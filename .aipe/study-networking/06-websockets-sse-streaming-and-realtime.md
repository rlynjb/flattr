# WebSockets, SSE, streaming, and realtime

**Industry name(s):** long-lived connections · server-sent events · streaming responses. **Type:** Industry standard.

## Status: not yet exercised

flattr has **no** WebSocket, **no** SSE, **no** streamed/chunked response, and **no**
long-lived connection anywhere. Every call in the repo is a discrete request/response that
opens, transfers a complete JSON body, and closes. This chapter is honest about that — and
teaches the realtime patterns *by contrast with what flattr does instead*, then shows
exactly where each would slot in if flattr ever needed it.

```
  Zoom out — flattr's connections are all short-lived request/response

  ┌─ flattr ───────────────────────────────────────────────────┐
  │  fetch ─► open ─► transfer WHOLE body ─► close              │
  │  (Overpass · Open-Meteo · Nominatim — all this shape)       │
  │                                                             │
  │  ✗ no socket held open   ✗ no event stream                 │
  │  ✗ no res.body reader    ✗ no reconnect logic              │
  └─────────────────────────────────────────────────────────────┘

  ★ THIS CONCEPT would live in a long-lived band that does not exist ★
```

## Why it's absent — and why that's correct

flattr's data is **static and pull-shaped**. The graph is a prebuilt artifact; elevation
and street data are immutable for a given area; geocoding is a one-shot lookup. Nothing in
the domain *pushes* — there's no live position feed, no other user, no server-initiated
update. Realtime transports exist to solve "the server has new data and the client
shouldn't have to ask." flattr's server-side is three read-only third-party APIs that
**only** answer when asked. There is nothing to push, so there is no push transport. That's
a domain fact, not a missing feature.

## The structure pass — the axis that decides realtime

**Axis: who initiates the next message — client or server?**

```
  Axis: "who pushes the next byte?"

  ┌─ request/response (flattr today) ─┐  CLIENT initiates every exchange
  │  client asks → server answers      │  → poll/debounce/retry to refresh
  └────────────────────────────────────┘
  ┌─ realtime (not in flattr) ────────┐  SERVER may initiate anytime
  │  socket/stream stays open          │  → reconnect logic, backpressure
  └────────────────────────────────────┘
  the seam is "who can speak unprompted" — flattr is all client-initiated
```

flattr lives entirely on the left. The moment any feature needs the *right* side — a
server speaking unprompted — is the moment a realtime transport earns its place.

## How it works — the patterns, and where they'd attach

### Move 1 — the mental model

You know the difference between refreshing a page (request/response) and a live feed that
updates itself (push). flattr only does the first. The three realtime patterns are three
ways to get the second:

```
  The three push transports, by shape

  WebSocket   client ◄════════════► server   full-duplex, both speak
  SSE         client ◄──────────────  server   one-way server→client stream
  HTTP stream client ──► server ──drip──► client   chunked body, read as it arrives
```

### Move 2 — where each would slot into flattr

flattr's closest *current* mechanism to "realtime" is its **self-heal retry loop** — and
naming what it does instead of streaming is the lesson. When elevation comes back flat
(throttled), flattr re-queues the region on a timer to upgrade it later:

```
  mobile/src/useTileGraph.ts:209-218 — polling-style self-heal, NOT a stream
  ┌──────────────────────────────────────────────────────────────┐
  │ if (degraded && retryCountRef.current < MAX_RETRIES) {        │
  │   retryCountRef.current += 1;                                 │
  │   retryRef.current = setTimeout(() => {                       │
  │     if (viewRef.current?.degraded) pendingViewRef.current=…   │ ◄ re-POLL the area
  │     pump();                                                   │   on a 12s timer
  │   }, RETRY_MS);   // RETRY_MS = 12000 (useTileGraph.ts:71)    │
  │ }                                                             │
  └──────────────────────────────────────────────────────────────┘
```

This is **timer-driven polling**, the request/response answer to "I want fresher data
later." A realtime transport would replace the timer with a held-open connection. Here's
where each pattern would attach if flattr grew that need:

**WebSocket — if flattr added live turn-by-turn navigation.** A walking route where the
server pushes "you're off-route, recompute" needs full-duplex: client streams GPS up,
server pushes corrections down. That's the one feature that would justify a WebSocket. It
doesn't exist; routing is computed *on device* from the static graph (`features/routing/`),
so nothing needs pushing.

```
  Layers-and-hops — hypothetical nav WebSocket (NOT built)

  ┌─ RN app ──┐  ════ GPS stream up ════►  ┌─ nav server ─┐
  │           │  ◄═══ reroute push down ═══ │ (would not   │
  │           │      (full-duplex, held)     │  exist — on- │
  └───────────┘                              │  device now) │
                                             └──────────────┘
```

**SSE — if a first-party backend streamed build progress.** flattr's build already has
*phases* (`buildGraph` reports steps via `onPhase`, `useTileGraph.ts:196`), but they're
local function callbacks, not server events. If graph-building moved to a backend, SSE
would stream those phase updates one-way to the client. Today the phases never cross the
wire.

**HTTP streaming (chunked body) — if a response were huge and incremental.** flattr reads
every body whole with `await res.json()` (`overpass.ts:41`, `elevation.ts:111`). For a
massive Overpass response you *could* stream-parse `res.body` to start building before the
last byte arrives. flattr doesn't, because viewport/corridor bboxes are capped small
(`MAX_LOAD_SPAN_DEG`, `MAX_CORRIDOR_SPAN_DEG` in `useTileGraph.ts:67,69`) — bodies are
small enough to buffer. The size cap is *why* streaming isn't needed.

```
  Comparison — flattr today vs the streaming version it doesn't need

  TODAY (useTileGraph.ts:186):              STREAMING (not built):
  await fetchOverpass(bbox)                 const reader = res.body.getReader()
  await res.json()  ← whole body            while(chunk) parseIncrementally(chunk)
       │                                          │
  bbox capped small ⇒ body small ⇒          would matter only if bodies
  buffering is fine, streaming unneeded     grew past the bbox caps
```

**Reconnect logic — not exercised because there's no connection to lose.** WebSocket/SSE
need reconnect-with-backoff because a held-open socket drops. flattr's retries
(`overpass.ts:42`, `07`) reconnect a *fresh request*, not a *dropped stream* — different
problem. There is no `onclose`/`onerror` reconnect handler anywhere, correctly, because
nothing stays open.

### Move 3 — the principle

Realtime transports are the answer to one question: *can the server speak unprompted?* If
the answer is no — as it is for every API flattr touches — then polling, debouncing, and
timer-driven self-heal are not a poor substitute, they're the *correct* tool, and a
WebSocket would be over-engineering. The principle: **don't reach for a held-open
connection until the data actually pushes.** flattr's self-heal timer is the honest,
right-sized version of "refresh later."

## Primary diagram

```
  flattr realtime posture — everything client-initiated, push absent

  ┌─ flattr (today) ───────────────────────────────────────────┐
  │  request/response only:                                     │
  │    pan/route  → fetch → whole body → close                  │
  │    self-heal  → setTimeout(12s) → re-fetch  (polling)       │
  │                                                             │
  │  ✗ WebSocket   would need: live nav (on-device today)       │
  │  ✗ SSE         would need: backend build-progress stream    │
  │  ✗ HTTP stream would need: bodies past the bbox size caps   │
  │  ✗ reconnect   would need: a held-open connection to drop   │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

WebSockets and SSE came out of the "I'm tired of polling" era — chat, live dashboards,
collaborative editing, all cases where the server genuinely has unprompted updates. The
skill is recognizing when you *don't* have that case: flattr's data is immutable per area
and computed on-device, so there's no push to receive. The cleanest signal of engineering
judgment here is that flattr reached for a 12-second self-heal *timer* instead of a socket
— matching the transport to the actual data shape. Read `07` next: it's the full treatment
of the request/response hardening (retry, backoff, the concurrency pump) that flattr uses
*instead of* realtime transports.

## Interview defense

**Q: Does flattr use WebSockets or SSE?**
> No — not yet exercised, and correctly so. Every API it calls is request/response and
> read-only; nothing pushes. The closest mechanism is a 12-second self-heal *timer*
> (`useTileGraph.ts:212`) that re-polls throttled regions — polling, not streaming.

```
  no server-initiated data ⇒ no push transport ⇒ poll/timer instead
```
> Anchor: *realtime answers "can the server speak unprompted" — flattr's never can.*

**Q: When would you add a WebSocket to flattr?**
> Live turn-by-turn navigation — the one feature needing the server to push "off-route,
> recompute." Today routing runs on-device from the static graph, so nothing needs a
> held-open connection. Adding nav would also bring reconnect-with-backoff, which flattr
> has no analog for today.

```
  add live nav ⇒ server pushes reroutes ⇒ full-duplex WebSocket + reconnect
```
> Anchor: *the trigger is on-device compute becoming server-pushed compute.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the request/response hardening flattr uses instead.
- `01-network-map.md` — confirms zero long-lived connections on the map.
- `study-system-design` — why routing is on-device (no nav server).
