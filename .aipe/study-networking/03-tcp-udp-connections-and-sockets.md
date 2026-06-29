# 03 — TCP/UDP, Connections, and Sockets

**Transport, sockets, connection lifecycle** · *Industry standard*

## Zoom out, then zoom in

Underneath every `fetch` is a TCP connection — a socket opened to the provider's IP on port 443, three-way handshake, bytes flowing, then a close. flattr opens dozens of these over a session and never names a single one. The socket is entirely below flattr's floor.

```
  Zoom out — where the connection sits

  ┌─ App ────────────────────────────────────────────┐
  │  fetch(...)  → Promise<Response>                   │ ← we are here (above the socket)
  └───────────────────────┬──────────────────────────┘
                          │ HTTP request
  ┌─ ★ Transport (TCP, OS-managed) ★ ────────────────┐
  │  open socket · handshake · send · recv · close    │
  └───────────────────────┬──────────────────────────┘
                          │ IP packets
  ┌─ Network ────────────────────────────────────────┐
  │  routers, the internet                            │
  └──────────────────────────────────────────────────┘
```

Zoom in: flattr makes exactly **one transport-relevant decision** — HTTP over TCP, implicitly, by using `fetch` and `https://` URLs. No UDP, no raw sockets, no WebSocket upgrade. So this concept is short and honest: the transport is TCP, flattr never touches the socket, and the one thing worth studying is *how flattr serializes its requests above the socket layer* — because that's the only connection-lifecycle control it actually has.

## Structure pass

**Layers.** Request (flattr) → connection (TCP, OS) → packet (IP). flattr operates only at the request layer.

**Axis = state (who owns the connection's lifetime?).** The OS owns it. flattr never holds a socket handle, never sees connect/close, never pools deliberately. flattr's only "connection state" is the application-level `busyRef` flag — a boolean that means "one build is in flight," which is *not* a socket, just a gate above the socket.

```
  axis traced: who owns connection lifetime?

  ┌─ flattr ───────────┐  seam  ┌─ OS transport ────────────┐
  │ owns: busyRef gate │ ══╪══► │ owns: socket open/close,   │
  │ (app-level)        │ flips  │ keep-alive, pooling, RTT   │
  └────────────────────┘        └────────────────────────────┘
```

**Seam.** The `fetch` call is the floor. Above it, flattr controls *whether and when* a request is issued (the pump gate). Below it, the platform controls *how* the bytes move. The axis flips hard at this seam: flattr owns scheduling, the OS owns transport.

## How it works

### Move 1 — the mental model

You know `fetch` returns a Promise that resolves when the response arrives. What you don't see is that resolving that Promise required opening a TCP socket, doing a handshake, and (probably) reusing a kept-alive connection from a pool the platform manages. flattr lives entirely in the Promise world and never descends to the socket. Its only transport-adjacent move is making sure it doesn't open *too many* sockets at once.

```
  Pattern — flattr's only connection control: the single-flight gate

   request A ──► busyRef? ──busy──► queued (one slot)
   request B ──► busyRef? ──busy──► queued (corridor jumps line)
                    │ free
                    ▼
              fetch(...)  ──► [OS opens/reuses ONE socket] ──► done
                    │
                    └─ busyRef released ─► drain next queued
```

That gate is not transport — it's an application scheduler. But it's the only lever flattr has that affects how many connections exist at a time, so it's where the connection story actually lives.

### Move 2 — walk the transport facts

**Fact 1 — it's TCP, always, implicitly.** Every URL is `https://`, every call is `fetch`. HTTPS rides TCP (HTTP/1.1 or HTTP/2 — see below). There is no `dgram`, no UDP, no `net.Socket`, no `ws` anywhere in the repo (confirmed: no socket libraries in either `package.json`). flattr never *chose* TCP; it chose `fetch`, and `fetch` chose TCP.

**Fact 2 — flattr never holds a socket.** No connection object is stored, inspected, or closed in flattr code. The lifecycle (SYN → SYN-ACK → ACK → data → FIN) happens entirely inside the platform's HTTP client. The closest flattr comes to "lifecycle" is awaiting the Promise:

```ts
// overpass.ts:33-41 — flattr sees a Response, never a socket
const res = await fetchImpl(endpoint, { method: "POST", headers: {...}, body });
if (res.ok) return (await res.json()) as OverpassResponse;
```

`await fetchImpl(...)` is "connection established + request sent + response headers received." `await res.json()` is "response body fully read off the socket." Two awaits, two phases of the socket's life, and flattr names neither.

**Fact 3 — connection reuse (pooling) is the platform's, not flattr's.** When the build samples elevation in batches of 100 (`elevation.ts:85,102`), it issues many sequential GETs to the same host. The platform *almost certainly* reuses one kept-alive TCP connection across them rather than reopening per request — that's standard HTTP/1.1 keep-alive / HTTP/2 behavior. flattr neither enables nor configures this; it's the default. *(Inference, from platform defaults — flattr sets no keep-alive header and no pool size. Covered as "not exercised" in `07`.)*

```
  Layers-and-hops — 100-point elevation batch loop, sockets reused

  ┌─ flattr (elevation.ts:102) ─┐
  │  for each 100-pt batch:      │
  │    await fetch(GET ...)      │
  └──────────────┬───────────────┘
       hop: HTTP request         (flattr issues N sequential requests)
                 ▼
  ┌─ OS transport ──────────────┐
  │  ONE kept-alive TCP socket   │ ← reused across the loop (platform default)
  │  reused across all batches   │   flattr never opens/closes it
  └──────────────────────────────┘
```

**Fact 4 — the single-flight gate caps concurrent connections at runtime.** `pump()` holds `busyRef = true` for the duration of one build (`useTileGraph.ts:166-167,182`), so at runtime there's at most one Overpass-plus-elevation build's worth of sockets open at a time. This isn't socket management — it's request scheduling — but it's *why* flattr never opens a flood of connections that would trip rate limits or exhaust the pool.

### Move 3 — the principle

When an app uses `fetch` and `https://` exclusively, its transport story is "TCP, delegated." The only connection-lifecycle decision left to make is *application-level concurrency* — how many requests you let fly at once. flattr makes exactly that one decision (single-flight via `busyRef`) and delegates everything below it. That's the correct division of labor: scheduling is yours, the socket is the platform's.

## Primary diagram

The full transport picture — flattr's scheduling above, the OS socket below.

```
  flattr transport — scheduling (flattr) over sockets (OS)

  ┌─ flattr scheduling layer ───────────────────────────────┐
  │  pump() single-flight gate (busyRef)                     │
  │  corridor > viewport priority                            │
  │  sequential batch loop (elevation, 100/req)              │
  └────────────────────────┬────────────────────────────────┘
                           │ await fetch(...)  ← the floor
  ┌─ OS transport layer (TCP, delegated) ───────────────────┐
  │  socket open → handshake → send → recv → keep-alive →    │
  │  reuse → eventual close   (flattr never sees any of it)  │
  └─────────────────────────────────────────────────────────┘
     not exercised: UDP · raw sockets · WebSocket upgrade ·
                    manual pool sizing · explicit keep-alive
```

## Elaborate

The reason flattr can ignore the socket entirely is that all its traffic is short, idempotent-ish request/response — perfect for `fetch`. The moment that would change is realtime (a live position stream, server-pushed traffic updates): then you'd want a long-lived connection (WebSocket/SSE), and *that's* when socket lifecycle becomes your problem — reconnect, heartbeat, backoff. flattr has none of that (see `06`), which is exactly why this concept is one page.

## Interview defense

**Q: What transport does flattr use, and where does it configure the socket?**
TCP, via HTTPS over `fetch`, and it configures nothing — no socket handle is ever held. The only connection-adjacent control is the `pump()` single-flight gate (`useTileGraph.ts:166`), which caps concurrent requests at the application layer. Anchor: *scheduling is flattr's; the socket is the OS's.*

**Q: When the build samples 100-point elevation batches in a loop, is it opening a connection per batch?**
Almost certainly not — the platform reuses a kept-alive TCP connection to the same host across the loop. flattr sets no keep-alive header and no pool size, so this is the platform default, not a flattr decision. Anchor: *N requests, one reused socket, zero flattr config.*

## See also

- `04-tls-and-trust-establishment.md` — the handshake that rides on this TCP connection
- `07-timeouts-retries-pooling-and-backpressure.md` — pooling-not-exercised + the single-flight gate as backpressure
- `06-websockets-sse-streaming-and-realtime.md` — the long-lived-connection case flattr doesn't have
