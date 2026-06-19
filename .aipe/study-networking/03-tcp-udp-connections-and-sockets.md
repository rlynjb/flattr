# 03 — TCP/UDP, connections, and sockets
### connections, sockets, transport choices, ordering, and connection lifecycle
**Industry name:** transport layer / connection management — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

Under every `fetch()` is a TCP connection: a three-way handshake, an ordered byte stream, a teardown. You've never opened a raw socket in flattr and you never will — the platform's `fetch` does all of it. The lesson here is what flattr relies on (TCP's ordering and reliability, for free) versus what it explicitly manages (nothing) versus what it can't control (pooling, keep-alive).

```
  Zoom out — where the transport sits

  ┌─ App / Build layer ──────────────────────────────┐
  │  fetch(url, { method, headers, body })            │
  └─────────────────────────┬─────────────────────────┘
  ┌─ ★ Transport layer (platform fetch → TCP) ★ ─────┐
  │  TCP: handshake · ordered stream · retransmit ·  │ ← we are here
  │  teardown.  flattr configures NONE of this.       │
  └─────────────────────────┬─────────────────────────┘
  ┌─ Network ────────────────▼────────────────────────┐
  │  IP packets across the internet                   │
  └────────────────────────────────────────────────────┘
```

Zoom in: the transport layer is "how do the bytes of my request actually get there, in order, intact." For flattr it's TCP every time (HTTP/HTTPS rides on TCP), flattr opens no sockets directly, and connection lifecycle is entirely the platform's job.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Application request (`fetch`) → Transport (TCP via the platform) → Network (IP). flattr only ever writes the top layer.

**Axis — guarantees (promised vs best-effort?).** Trace what each layer promises:

```
  Axis "what's guaranteed?" — down the transport stack

  ┌─────────────────────────────────────┐
  │ fetch: a Promise<Response> or throw  │  → all-or-nothing result
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ TCP: in-order, no-loss, no-dup   │  → reliable byte stream
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ IP: best-effort packets      │  → may drop/reorder/dup
          └─────────────────────────────┘

  TCP turns best-effort IP into a reliable stream — flattr gets that free
```

**Seams.** The load-bearing seam is `fetch` itself. Above it flattr reasons in whole requests and whole responses (it `await`s a `Response`, parses `.json()`). Below it lives every socket concern — handshake, windowing, retransmit, ordering — that flattr never sees. The guarantee flips here: above the seam you get one atomic "did the request succeed" answer; below it TCP is doing continuous reliability work flattr never observes.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how `await fetch()` either resolves with a full response or rejects — you never get "half a response"? That's because TCP delivered the bytes in order and intact (or the connection failed and you got nothing usable). flattr builds entirely on that all-or-nothing guarantee. It never streams, never reads a partial body, never opens a socket to manage ordering itself.

```
  Pattern — fetch hides the whole TCP lifecycle

   fetch(url) ──┐
                │  (platform) SYN → SYN-ACK → ACK    [handshake]
                │             send request bytes
                │             receive response bytes  [ordered by TCP]
                │             FIN / connection reuse  [teardown/pool]
                ▼
   await resolves with one complete Response  ◄── flattr only sees this
```

#### Move 2 — walking the transport behavior

**Transport choice: TCP, always, implicitly.** Every flattr network call is HTTP or HTTPS, and both ride TCP. There is no UDP anywhere — no QUIC the code controls, no raw datagrams, no custom transport. flattr never *chooses* TCP; it falls out of using `fetch` over `http(s)://`. The one place UDP-ish behavior appears is DNS resolution (`02`), and that's the OS resolver's business, not flattr's.

```
  Transport inventory

  Overpass    HTTPS → TCP    (POST, body in stream)
  Open-Meteo  HTTPS → TCP    (GET)
  Nominatim   HTTPS → TCP    (GET)
  tiles       HTTPS → TCP    (GET, MapLibre-managed)
  ── no UDP, no QUIC-by-flattr, no raw sockets ──
```

**Socket management: none, by design.** flattr opens zero sockets. It calls `fetch`; the platform allocates, connects, and reclaims the socket. There's no socket reuse flattr controls, no `net.Socket`, no WebSocket (`06`), no persistent connection flattr holds open. Every call is a fresh logical request from flattr's point of view.

**Connection lifecycle and pooling: the platform decides, flattr neither controls nor depends on it.** Here's the honest state: when the elevation pipeline fires 100-point batches in a loop (`pipeline/elevation.ts:102-122`), the underlying platform *may* reuse a keep-alive connection across those batches — that's a real performance win and Node's fetch typically does it. But flattr **configures no agent, no pool size, no keep-alive header, no connection limit.** It's `not yet exercised` as a controlled mechanism.

```
  Layers-and-hops — pooling is invisible to flattr

  ┌─ flattr ─────┐  batch 1 GET   ┌─ platform fetch ─┐   ┌─ provider ─┐
  │ for-loop     │ ─────────────► │  socket #1       │ ──► api        │
  │ over batches │  batch 2 GET   │  REUSE #1? or    │   │            │
  │              │ ─────────────► │  open #2?        │ ──► api        │
  └──────────────┘                └──────────────────┘   └────────────┘
         │
         └─ flattr does NOT decide reuse-vs-reopen. No agent config exists.
            Inferred: keep-alive reuse happens, but it's the platform's call
```

**Ordering across requests is flattr's job, not TCP's.** TCP orders bytes *within* one connection. But flattr's elevation loop needs the *results* ordered to match the input points — and that's application-level, handled by pushing into an array in iteration order (`pipeline/elevation.ts:79`, `:120`), not by anything TCP does. This is the subtle part: TCP gives you in-order bytes per request; correlating multiple requests' results back to their inputs is on you. flattr does it by issuing batches sequentially and appending in order.

#### Move 3 — the principle

When you use `fetch`, you're renting TCP's reliability and ordering guarantees without managing the socket. The cost is that you also give up control of the connection lifecycle — pooling, keep-alive, and timeouts become the platform's defaults unless you go out of your way to override them. flattr takes the defaults everywhere, which is fine until a connection hangs (see `07`, the no-timeout problem).

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The transport picture — what flattr controls vs what the platform owns.

```
  flattr transport — the seam at fetch

  ┌─ flattr (writes requests, reads responses) ────────────────┐
  │  await fetch(url, init)  ·  parse .json()                  │
  │  orders RESULTS by appending in loop order (app-level)     │
  └────────────────────────────┬───────────────────────────────┘
              the fetch seam    │   (flattr stops here)
  ┌─ Platform (owns the socket) ▼──────────────────────────────┐
  │  TCP handshake · ordered stream · retransmit · teardown    │
  │  keep-alive / pooling: platform default, flattr unconfigured│
  └────────────────────────────┬───────────────────────────────┘
  ┌─ Network ────────────────────▼─────────────────────────────┐
  │  best-effort IP packets                                    │
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** The transport layer is reached on every `fetch`, but the one place flattr's behavior is *visible* at this layer is the sequential batch loop — because that's where connection reuse (if it happens) and result ordering both matter.

**The sequential batch loop** — `pipeline/elevation.ts` (lines 100-122):

```
  pipeline/elevation.ts  (lines 100-122)

  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {
    const batch = points.slice(i, i + OPEN_METEO_BATCH);  ← 100 pts/request
    ...
    const res = await fetchImpl(url);          ← one TCP request, awaited
    ...
    for (const e of json.elevation) out.push(e); ← APPEND in order →
  }                                                this is the result ordering
        │
        └─ requests are SEQUENTIAL (await inside the loop). flattr never
           opens parallel sockets here. Whether the platform reuses one
           keep-alive socket across iterations is invisible and unconfigured.
           Result ordering is guaranteed by append-order, not by TCP.
```

The `await` inside the loop means one request is in flight at a time. flattr never fans out parallel connections, so it never hits a connection-limit problem — but it also serializes the latency. That's a deliberate trade for rate-limit politeness (see `07`), not a transport optimization.

**No agent, no pool config — the absence is the finding.** A search across the repo for `Agent`, `keepAlive`, `pool`, `maxSockets`, or `net.Socket` finds nothing. flattr never constructs an HTTP agent. This is `not yet exercised`: connection pooling is purely the platform's default behavior.

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

The "just use `fetch` and take the defaults" approach is correct for flattr's volume — a handful of requests per build, a handful per pan. Connection pooling and keep-alive tuning matter when you're making hundreds of requests per second to the same host and the handshake cost dominates; flattr's elevation loop is the only place that even approaches "many requests to one host," and it serializes them anyway. Where this *would* bite: if flattr ever parallelized the elevation batches to cut build time, it'd want an agent with a bounded pool to avoid opening 50 simultaneous connections and getting rate-limited harder. That's the connection-management work that's currently `not yet exercised`. The general theory of connection pools and backpressure lives in `.aipe/study-runtime-systems/` (the async execution model) and `07` here (the concurrency cap).

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "What transport does your app use, and how do you manage connections?"**

Answer: "TCP everywhere — every call is HTTP/HTTPS over the platform `fetch`, so TCP falls out of that. No UDP, no QUIC I control, no raw sockets. I don't manage connections at all: `fetch` owns the socket lifecycle. The one place it'd matter is the elevation batch loop, and there I issue requests sequentially with `await` in the loop, so there's never more than one connection in flight. Whether the platform reuses a keep-alive socket across batches is its call — I don't configure an agent or pool."

```
  fetch → TCP (free reliability + ordering)
  elevation loop: sequential await → 1 conn at a time
  pooling/keep-alive: platform default, unconfigured
```

Anchor: *fetch rents TCP's guarantees; flattr gives up socket control as the price.*

**Q: "Your elevation API returns results for 100 points. How do you keep them aligned with the input?"**

Answer: "TCP orders bytes within a request, but aligning multiple requests' results to inputs is application-level. I issue batches sequentially and push each response's elevations into an output array in iteration order, so `out[i]` lines up with `points[i]`. The dedup path does the same with a key→elevation map. Nothing relies on TCP for cross-request ordering."

Anchor: *TCP orders bytes per connection; correlating batch results is the app's job, done by append-order.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** Which transport does every flattr call use, and why is there no UDP?
2. **Explain:** Why is connection pooling `not yet exercised` in flattr, and where would it first matter? (`pipeline/elevation.ts:102-122`)
3. **Apply:** You parallelize the elevation batches with `Promise.all` to speed up the build. What transport-layer problem do you risk, and what would you add to control it?
4. **Defend:** Is "no agent config" a defect or a non-issue at flattr's scale? Make the call.

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `04-tls-and-trust-establishment.md` — the TLS handshake that rides on the TCP connection.
- `07-timeouts-retries-pooling-and-backpressure.md` — the concurrency cap and the missing timeout.
- `.aipe/study-runtime-systems/` — the async execution model the sequential loop rides on.
