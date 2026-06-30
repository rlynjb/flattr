# TCP/UDP, connections, and sockets

**Industry name(s):** transport layer / connection lifecycle / sockets. **Type:** Industry standard.

## Zoom out, then zoom in

Under every `await fetch(...)` in flattr is a TCP connection: a three-way handshake, an
ordered byte stream, a teardown. flattr never names a socket, never picks TCP over UDP,
never sets a pool size. It sits two layers above the socket and lets the runtime own all
of it.

```
  Zoom out — the transport flattr stands on but never touches

  ┌─ flattr code ───────────────────────────────────────────┐
  │  await fetchImpl(url, { method, headers, body })         │ ← flattr's floor
  └───────────────────────────────┬──────────────────────────┘
                                  │ HTTP request object
  ┌─ Runtime HTTP client ─────────▼──────────────────────────┐
  │  ★ open/reuse TCP socket · write bytes · read response ★  │ ← THIS CONCEPT
  │  (Node undici connection pool / RN native stack)          │
  └───────────────────────────────┬──────────────────────────┘
                                  │ TCP segments
  ┌─ OS network stack ────────────▼──────────────────────────┐
  │  3-way handshake · ordered reliable stream · FIN teardown │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. The concept is the **connection lifecycle**: handshake → send → receive →
close (or keep-alive for reuse). flattr exercises it entirely through `fetch`, so the
lesson is about **what TCP gives flattr for free** (ordering, reliability) and **what
flattr gives up by not touching it** (no socket timeout, no pool control).

## The structure pass

**Layers.** flattr → runtime HTTP client → OS TCP stack. The socket lives two floors
below flattr's lowest line of code.

**Axis traced: who owns the connection's lifetime?**

```
  Axis: "who decides when the socket opens, lives, and dies?"

  ┌─ flattr ────────────────┐  decides only WHEN to call fetch
  │  await fetch()           │  (and how many at once — the pump)
  └──────────┬───────────────┘
  ┌─ runtime ▼───────────────┐  opens, pools, keep-alives, reuses,
  │  HTTP client / agent      │  and closes the socket — all of it
  └──────────┬───────────────┘
  ┌─ OS ─────▼───────────────┐  the actual handshake + byte stream
  │  TCP segments             │
  └──────────────────────────┘
  flattr owns *request rate*; the runtime owns *connection lifetime*
```

**Seam.** `fetch` → runtime is the seam. The axis flips: above it flattr controls *how
many requests* (the single-in-flight pump, `useTileGraph.ts:166`); below it the runtime
controls *how many sockets and for how long*. flattr's only lever on the transport is
request rate — and that lever is `07`'s whole story.

## How it works

### Move 1 — the mental model

You know a `fetch` "opens a connection" — you just never see the socket. The transport
pattern is a **reliable ordered pipe**: TCP guarantees the bytes you send arrive in order
or the connection errors. flattr leans entirely on that guarantee — it never reassembles,
never dedupes packets, never handles out-of-order delivery, because TCP already did.

```
  The pattern — TCP gives flattr an ordered reliable byte pipe

  flattr: fetch ──┐
                  │   SYN ─────────────────►  } 3-way
                  │   ◄───────────── SYN-ACK  } handshake (runtime+OS)
                  │   ACK ─────────────────►  }
                  │   request bytes ───────►
                  │   ◄──────── response bytes  (in order, reliable)
                  │   FIN / keep-alive
  flattr: await resolves ◄─ JSON parsed
```

### Move 2 — the step-by-step walkthrough

**flattr always picks TCP — implicitly, by using HTTP.** Every call is HTTP/HTTPS, and
HTTP runs on TCP. flattr never touches UDP. There's no QUIC config, no datagram socket,
no raw socket anywhere in the repo. The transport choice is made *by choosing HTTP*, not
by any flattr code. **UDP is not yet exercised** and wouldn't be unless flattr added
something like a custom realtime protocol — which it has no reason to.

**flattr relies on TCP ordering and never re-checks it.** Look at how Open-Meteo's
response is consumed — flattr trusts that `elevation[i]` lines up with the i-th point it
sent, because TCP delivered the whole body intact and in order:

```
  pipeline/elevation.ts:100-120 — relying on ordered, complete delivery
  ┌──────────────────────────────────────────────────────────────┐
  │ const res = await fetchImpl(url);          // TCP stream done  │
  │ json = (await res.json());                 // whole body, ordered│
  │ for (const e of json.elevation) out.push(e);                  │
  │              └─ trusts elevation[] order matches the points    │
  │                 we batched — TCP + HTTP guarantee a complete,  │
  │                 in-order body, so no reassembly in flattr      │
  └──────────────────────────────────────────────────────────────┘
```

If TCP didn't guarantee ordering and completeness, this `for` loop would be a bug — you'd
need sequence numbers in the payload. flattr doesn't, because the transport handles it.

**Connection reuse (keep-alive) is the runtime's call, not flattr's.** When the build
loops over Open-Meteo batches (`elevation.ts:102`), each batch is a separate `fetch`.
Whether those reuse one keep-alive socket or open a fresh one each time is **entirely up
to the runtime's HTTP client** — Node's undici keeps a connection pool by default; React
Native's stack manages its own. flattr writes no `Agent`, no `keepAlive: true`, no pool
size. **Connection pooling is not yet exercised at flattr's layer** — it happens, but
flattr neither configures nor observes it.

```
  Layers-and-hops — batch loop, runtime decides socket reuse

  ┌─ flattr (elevation.ts:102) ─┐         ┌─ Open-Meteo ─┐
  │ for each batch:             │ batch 1 │              │
  │   await fetch(url)  ────────┼────────►│  reuse the   │
  │   await sleep(delayMs)      │ batch 2 │  same socket │
  │   await fetch(url)  ────────┼────────►│  OR a new one│
  │                             │         │  — runtime's │
  │  flattr controls the PACING │ batch 3 │  decision    │
  │  not the SOCKET REUSE  ─────┼────────►│              │
  └─────────────────────────────┘         └──────────────┘
```

**The one transport lever flattr does pull: how many connections exist at once.** flattr
can't size a pool, but it *can* cap concurrency to one — and it does, deliberately. The
`busyRef` gate in the pump means at most one Overpass+elevation build is in flight at a
time (`useTileGraph.ts:167`):

```
  mobile/src/useTileGraph.ts:166-167 — capping in-flight connections to 1
  ┌──────────────────────────────────────────────────────────────┐
  │ const pump = useCallback(() => {                              │
  │   if (busyRef.current) return;   // ◄ already one build live; │
  │                                  //   don't open a second set │
  │   ...                            //   of Overpass/elevation   │
  │   busyRef.current = true;        //   connections             │
  └──────────────────────────────────────────────────────────────┘
```

This isn't a pool size — it's a concurrency cap of one, the bluntest possible
backpressure (`07`). It exists for rate limits, but the *side effect* is that flattr never
has more than one set of these sockets open, so it never needs pool tuning.

**The socket's failure modes are invisible until they aren't.** Because flattr sets no
socket timeout (`07`), a connection that opens but never delivers (server accepts the SYN,
then hangs) leaves the `await fetch` pending **indefinitely**. TCP itself will eventually
time out at the OS level (minutes), but flattr has no faster path. This is the transport
consequence of the no-timeout gap.

### Move 3 — the principle

The value of TCP is that flattr's code reads `json.elevation[i]` and trusts it — ordering
and reliability are abstracted away. The cost of delegating the *whole* connection is that
the two things you'd actually want to control at the socket — **timeout and pool size** —
are exactly the two flattr can't reach without an `AbortController` or an agent. The
principle: **the transport gives you correctness for free and takes control of failure
timing in exchange.** flattr took the trade and paid for it in `08`'s top finding.

## Primary diagram

```
  flattr transport — what's delegated vs what flattr keeps

  ┌─ flattr ──────────────────────────────────────────────────┐
  │  KEEPS:  request rate  (pump caps in-flight to 1)          │
  │          await fetch() · trusts ordered/complete body      │
  └──────────────────────────────┬─────────────────────────────┘
                                 │ seam: fetch → runtime
  ┌─ Runtime HTTP client ────────▼─────────────────────────────┐
  │  OWNS:   socket open/close · keep-alive · pool · reuse      │
  │          (Node undici / RN native — flattr configures none) │
  └──────────────────────────────┬─────────────────────────────┘
  ┌─ OS TCP ─────────────────────▼─────────────────────────────┐
  │  3-way handshake · ordered reliable stream · FIN           │
  │  NO UDP · NO QUIC config · OS-level timeout only            │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

TCP's handshake-and-stream model is the substrate the entire web sits on; HTTP is "just"
a request/response framing on top of it. flattr is a textbook case of an app that benefits
from never thinking about the socket — until the day a server hangs mid-connection, at
which point the missing `AbortController` becomes the bug. Where you *would* drop to the
socket: a high-throughput service tuning keep-alive and pool size for connection reuse, or
a realtime app picking UDP/QUIC for latency. flattr is neither, so **the socket stays the
runtime's problem** — correctly, with one named cost. Read `04`: before any request bytes
flow on HTTPS hosts, TLS negotiates on top of this TCP connection.

## Interview defense

**Q: TCP or UDP, and who decides?**
> TCP, always — chosen implicitly by using HTTP. flattr writes no socket code at all; the
> runtime and OS own the handshake, ordering, and teardown. flattr relies on TCP's ordered
> delivery so hard that `elevation[i]` is trusted to match the i-th point sent with no
> sequence checking — if TCP didn't guarantee order, that'd be a bug.

```
  HTTP ⇒ TCP (implicit) ⇒ ordered reliable stream ⇒ no reassembly in flattr
```
> Anchor: *flattr never picks the transport — it picks HTTP, and HTTP picks TCP.*

**Q: Does flattr do connection pooling?**
> Not at flattr's layer — not yet exercised. The runtime (undici/RN) pools by default;
> flattr configures no agent or pool size. The one transport lever flattr pulls is a
> concurrency cap of **one** in-flight build (`useTileGraph.ts:167`), for rate-limit
> reasons — which incidentally means pooling never matters.

```
  pump: busyRef gate ⇒ ≤1 build's worth of sockets live at once
```
> Anchor: *flattr controls request rate, the runtime controls socket lifetime.*

## See also

- `02-dns-routing-and-addressing.md` — resolution that precedes the handshake.
- `04-tls-and-trust-establishment.md` — TLS layered on this TCP connection.
- `07-timeouts-retries-pooling-and-backpressure.md` — the concurrency cap and the missing socket timeout.
- `study-runtime-systems` — the event loop beneath the suspended `await fetch`.
