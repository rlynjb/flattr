# 06 — WebSockets, SSE, streaming, and realtime
### long-lived connections, streams, realtime behavior, and reconnect logic
**Industry name:** realtime transports / streaming protocols — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

**Verdict first: `not yet exercised`, and that's the correct architecture, not a gap.** You've built the streaming version of this — AdvntrCue streams GPT-4 tokens back over a server-sent response, reading the body chunk by chunk. flattr does the opposite: it never opens a long-lived connection, never streams a response body, never reconnects. Everything is a single request/response round-trip that completes and closes. This file exists to explain *why* that's right here, and exactly where realtime *would* enter if the product changed.

```
  Zoom out — the realtime layer flattr doesn't have

  ┌─ App layer ──────────────────────────────────────┐
  │  routing = LOCAL A* over bundled graph (no net)   │
  │  fetch() = one-shot request/response (closes)     │
  └─────────────────────────┬─────────────────────────┘
  ┌─ ★ Realtime transport layer — EMPTY ★ ───────────┐
  │  ✗ no WebSocket  ✗ no SSE  ✗ no streamed body    │ ← we are here
  │  ✗ no long-poll  ✗ no reconnect logic            │   (nothing here)
  └─────────────────────────┬─────────────────────────┘
  ┌─ Provider layer ─────────▼────────────────────────┐
  │  all providers serve discrete request/response    │
  └────────────────────────────────────────────────────┘
```

Zoom in: realtime transport is "do I hold a connection open to push/pull data continuously?" flattr's answer is no, everywhere. The question worth your time is *why nothing streams*, and *what would have to change about the product to need it.*

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** There's no realtime layer to decompose — so the structure pass here reads the *seam where realtime would attach* and shows it's absent.

**Axis — lifecycle (when does this happen: build / request / continuous?).** Trace it and the absence pops:

```
  Axis "what's the connection lifecycle?" — across flattr's work

  ┌──────────────────────────────────────────────────┐
  │ Graph build (Overpass/elevation): request → close │ → one-shot
  └──────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────────┐
      │ Geocode: request → close                      │ → one-shot
      └──────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ Routing (A*): no connection at all        │ → local compute
          └──────────────────────────────────────────┘

  NO layer has a "continuous / long-lived" lifecycle → no realtime needed
```

**Seams.** The seam to study is the one that *isn't* crossed: there's no point in flattr where a connection stays open across multiple logical events. Every `fetch` is request-in, response-out, done. If a realtime seam ever appears, it'd be at "live position tracking" or "live re-route as you walk" — neither of which the product does today.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know the difference between `fetch()` (ask once, get one answer, connection closes) and a WebSocket (open a pipe, messages flow both ways until someone closes it)? flattr is 100% the first kind. Even the "live-feeling" parts — the map updating as you pan, the route appearing — are not realtime transport; they're local recomputation plus the occasional one-shot fetch.

```
  Pattern — request/response (what flattr does) vs streaming (what it doesn't)

  flattr (one-shot):          streaming (NOT in flattr):
  ─────────────────           ─────────────────────────
  open → request → response   open ──────────────────────►
        → CLOSE                ◄── msg ── msg ── msg ── msg
   (repeat per need)           (connection STAYS open, reconnect on drop)
```

#### Move 2 — where realtime would attach, and why it doesn't

**The "live map" is not realtime transport.** When you pan and new streets appear, that's `useTileGraph` firing a *one-shot* Overpass fetch on a debounce (`mobile/src/useTileGraph.ts:131-151`), then recomputing the merged graph locally. No connection is held open between pans. The map *feels* live; the transport is discrete request/response.

```
  Layers-and-hops — "live" map is debounced one-shots, not a stream

  ┌─ App (RN) ─────┐  pan settles (600ms debounce)  ┌─ Overpass ──┐
  │ onRegionDid    │ ─── one POST ──────────────────► │            │
  │ Change         │ ◄── one response, CLOSE ──────── └────────────┘
  │                │  (next pan = a NEW one-shot, not a kept-open pipe)
  └────────────────┘
```

**Routing is local — the most realtime-feeling feature touches zero network.** `directedAstar(graph, startId, endId, userMax)` (`mobile/src/MapScreen.tsx:147`) runs entirely on-device over the in-memory graph. The route line redraws instantly when you change the max-grade preset because it's a local A\* recompute (a `useMemo`), not a server round-trip. The single most "interactive" thing in the app is the one with no network at all.

**Reconnect logic: none, because there's nothing to reconnect.** No WebSocket means no `onclose` handler, no exponential-reconnect, no heartbeat/ping-pong, no resubscribe-on-reconnect. The closest analog is the retry loop (`07`) — but that re-issues a *fresh* request, it doesn't restore a dropped persistent connection. Different mechanism, different problem.

**Streamed response bodies: none.** Every module does `await res.json()` — which buffers the *entire* body before parsing (`pipeline/overpass.ts:41`, `pipeline/elevation.ts:111`). flattr never reads a `ReadableStream`, never processes a partial body, never uses NDJSON or chunked progressive parsing. For the Overpass response (which can be multi-MB for a city) this means the whole payload lands in memory before any work starts — a deliberate simplicity choice that's fine at flattr's small-bbox scale.

#### Move 2.5 — current state vs future state

The product *could* grow a realtime need, and it's worth naming exactly where:

```
  Comparison — when realtime would enter flattr

  TODAY (one-shot, correct)         IF the product added…
  ─────────────────────────         ──────────────────────
  route computed once on demand     "live re-route as you walk"
   → local A*, no net                → still local A* on GPS ticks,
                                       STILL no realtime transport needed
                                       (recompute on each expo-location fix)

  graph fetched per pan (one-shot)  "collaborative shared routes"
   → debounced fetch                 → THEN you'd need a server +
                                       WebSocket/SSE to push others' updates
```

The insight: even "live re-routing while walking" wouldn't need a streaming transport — it's just running the local A\* again on each GPS tick (`expo-location` already provides the ticks, `mobile/src/MapScreen.tsx:90-102`). Realtime transport only becomes necessary if flattr adds a *server-pushed* feature — shared/live routes, server-side traffic, another user's position. None exist, so the layer is correctly empty.

#### Move 3 — the principle

Not every "live" feature needs a live connection. flattr's most interactive behavior — instant re-routing, panning the map — is local recomputation plus debounced one-shot fetches. Reach for WebSockets/SSE only when the *server* needs to push data you can't compute locally and can't poll for cheaply. flattr can compute its routes locally, so it never pays the cost of a persistent connection (reconnect logic, heartbeats, server fan-out). That's a feature of the architecture, not a missing piece.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The realtime picture — the empty layer, and the local-compute path that makes it unnecessary.

```
  flattr realtime — empty by design

  ┌─ App (RN) ─────────────────────────────────────────────────┐
  │  routing: directedAstar() — LOCAL, no connection           │
  │  re-route on grade change: useMemo recompute — LOCAL       │
  │  map pan: debounced ONE-SHOT fetch → merge → recompute     │
  └────────────────────────────┬───────────────────────────────┘
            no persistent conn  │
  ┌─ Realtime transport ────────▼──────────────────────────────┐
  │   ✗ WebSocket  ✗ SSE  ✗ streamed body  ✗ reconnect         │
  │   (NOT EXERCISED — local compute removes the need)         │
  └────────────────────────────┬───────────────────────────────┘
  ┌─ Provider ──────────────────▼──────────────────────────────┐
  │  all serve discrete request/response, then close           │
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** There's no realtime code to point at — the relevant evidence is the *one-shot* shape of the closest-to-realtime features, which proves the layer is intentionally absent.

**The "live" pan is a buffered one-shot** — `mobile/src/useTileGraph.ts` (lines 106-128):

```
  mobile/src/useTileGraph.ts  (lines 106-128)

  (async () => {
    try {
      const osm = await fetchOverpass(bbox);   ← ONE request, fully awaited
      ...
      const g = await buildGraph(...);          ← then local compute
      ...setView(region);                       ← merged into the graph
    } catch { /* keep last region */ }
    finally { busyRef.current = false; pump(); } ← no open connection to close
  })();
        │
        └─ fetchOverpass resolves with the WHOLE body (res.json() buffers
           it). No stream, no partial read. Each pan starts a fresh one-shot;
           nothing is held open between them.
```

**The most interactive feature has no network** — `mobile/src/MapScreen.tsx` (lines 143-154):

```
  mobile/src/MapScreen.tsx  (lines 143-154)

  const routed = useMemo(() => {
    if (!graph || !startId || !endId) return {...};
    const r = directedAstar(graph, startId, endId, userMax); ← LOCAL A*
    ...
  }, [graph, startId, endId, userMax]);   ← recompute on any input change
        │
        └─ change the max-grade preset → userMax changes → this useMemo
           reruns → new route line. Instant, because it's local compute.
           Zero network. This is why no streaming transport is needed.
```

**The absence — confirmed.** A search for `WebSocket`, `EventSource`, `new WebSocket`, `text/event-stream`, `ReadableStream`, or `res.body.getReader` across the repo finds nothing. No realtime transport exists.

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

WebSockets and SSE earn their complexity when the server holds state the client must learn about *as it changes* and can't cheaply poll — live chat, collaborative editing, market data, streaming LLM tokens (the AdvntrCue case). The cost they impose is real: connection lifecycle management, heartbeats to detect dead connections, reconnect-with-backoff, and resubscribe-on-reconnect, plus server-side fan-out infrastructure. flattr avoids every bit of that because its data is either baked (the graph) or computable locally (the route). If flattr ever adds a feature where *another party's* state must reach this client live, that's when you'd reach for SSE (one-way server push, simplest) or a WebSocket (bidirectional). Until then, the empty layer is the right call. The reconnect/backoff theory that *would* apply lives in `.aipe/study-distributed-systems/`.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "Your app feels live — re-routing is instant, the map updates as you pan. What transport powers that?"**

Answer: "None for the routing — it's local A\* over an in-memory graph, recomputed in a `useMemo` whenever the endpoints or max-grade change. The map pan is a debounced *one-shot* Overpass fetch, not a kept-open connection. I deliberately have no WebSocket or SSE: flattr's data is either baked into a bundled graph or computable on-device, so there's nothing a server needs to push. Persistent connections would add reconnect logic and heartbeats for zero benefit here."

```
  re-route: local A* useMemo, no net
  pan: debounced one-shot fetch, closes
  no WS/SSE → no reconnect, no heartbeat to maintain
```

Anchor: *not every live feature needs a live connection — local compute beats a persistent socket when you can compute the answer yourself.*

**Q: "When would you add streaming to flattr?"**

Answer: "Only if a feature needs *server-pushed* data — shared live routes, another user's position, server-side traffic conditions. Even 'live re-route as I walk' wouldn't need it: that's just rerunning the local A\* on each GPS fix from expo-location. SSE would be my first reach (one-way push, simplest) if the push is server→client only; a WebSocket only if it's bidirectional."

Anchor: *streaming enters when the server holds state the client can't compute or cheaply poll — flattr has none of that yet.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** Name three realtime mechanisms flattr does *not* use, and the one local mechanism that makes them unnecessary.
2. **Explain:** Why is the map-pan update a one-shot fetch and not a streamed/long-lived connection? (`mobile/src/useTileGraph.ts:106-128`)
3. **Apply:** Product wants "re-route automatically as I walk." Does this need a realtime transport? Justify using `mobile/src/MapScreen.tsx:90-102` (GPS) + `:143-154` (local A\*).
4. **Defend:** Argue that the empty realtime layer is correct, then name the single product change that would flip your answer.

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `07-timeouts-retries-pooling-and-backpressure.md` — retry re-issues a fresh request; it is *not* connection reconnect.
- `01-network-map.md` — every connection is one-shot; the map shows it.
- `.aipe/study-distributed-systems/` — reconnect/backoff theory if realtime ever enters.
