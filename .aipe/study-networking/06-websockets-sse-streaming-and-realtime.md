# 06 — WebSockets, SSE, Streaming, and Realtime

**Long-lived connections, server push, streaming bodies** · *Industry standard* · **NOT YET EXERCISED**

## Zoom out, then zoom in

flattr has no realtime networking. Not a WebSocket, not Server-Sent Events, not long-polling, not a streamed response body. Every network interaction is a discrete request that opens, completes, and closes. This file is honest about that — and useful precisely because it draws the line where realtime *would* enter and what it would replace.

```
  Zoom out — the realtime band, empty in flattr

  ┌─ UI ──────────────────────────────────────────────┐
  │  MapScreen — pan, type, route                       │
  └────────────────────────┬───────────────────────────┘
                           │ request/response only
  ┌─ ★ Realtime band ★ ───────────────────────────────┐
  │           (NOT YET EXERCISED)                       │ ← we are here
  │  no WebSocket · no SSE · no streaming · no push     │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Providers ─────────────▼──────────────────────────┐
  │  Overpass · Open-Meteo · Nominatim (all one-shot)   │
  └────────────────────────────────────────────────────┘
```

Zoom in: the question this concept answers is *"does any part of flattr need a connection that stays open and pushes data over time?"* The answer today is no, and the reason is structural — flattr's data (a street graph, an elevation grid, an address lookup) is *static*. Nothing about it changes second-to-second, so there's nothing to push.

## Structure pass

**Layers.** There's nothing to layer — the realtime band is empty. The useful structural move is to identify *where* a realtime requirement would attach if the product grew.

**Axis = guarantees (request/response vs continuous stream).** Across all of flattr, the answer never changes: every call is one-shot request/response. There's no seam where it flips to streaming, because no module streams. That flat answer *is* the finding.

```
  axis traced: request/response or continuous?

  ┌─ Overpass ─┐  ┌─ Open-Meteo ─┐  ┌─ Nominatim ─┐
  │ one-shot   │  │ one-shot     │  │ one-shot    │
  └────────────┘  └──────────────┘  └─────────────┘
   no seam flips to streaming anywhere → realtime not exercised
```

**Seam.** The only relevant seam is hypothetical: the boundary between "static baked data" (what flattr is) and "live updating data" (what would demand realtime). flattr sits entirely on the static side.

## How it works

### Move 1 — the mental model

You know the difference between a `fetch` (ask once, get an answer, done) and a WebSocket (open a pipe, both sides talk whenever they want, until someone closes it). flattr is 100% the former. The mental model for *this* file is the negative space: what would a realtime feature look like, and why doesn't flattr's data need one?

```
  Pattern — request/response (what flattr is) vs realtime (what it isn't)

  flattr (now):
    client ──ask──► server
    client ◄answer─ server      one exchange, connection closes

  realtime (not exercised):
    client ══open══► server
    client ◄push═══ server      server pushes whenever it has data
    client ◄push═══ server      connection stays open
    client ══close═► server     until torn down (needs reconnect/heartbeat)
```

### Move 2 — what's confirmed absent, and where it would attach

**Confirmed absent.** A repo-wide search for `WebSocket`, `EventSource`, `SSE`, streaming body readers (`res.body.getReader`), and `ws`/`socket.io`/`eventsource` dependencies returns nothing across `pipeline/`, `mobile/src/`, `lib/`, and `features/`. Both `package.json` files carry no realtime library. Every response is consumed whole via `await res.json()` (`overpass.ts:41`, `elevation.ts:111`, `geocode.ts:25`) — the body is fully buffered, never read as a stream.

```
  Layers-and-hops — how flattr reads a body (whole, not streamed)

  ┌─ provider ──┐ hop: full JSON body
  │ sends bytes │ ──────────────────────────┐
  └─────────────┘                           ▼
  ┌─ platform fetch ────────────────────────────┐
  │ buffers the entire body                      │
  └──────────────────────┬───────────────────────┘
            hop: await res.json()
                         ▼
  ┌─ flattr ────────────────────────────────────┐
  │ gets the parsed object all at once           │
  │ (no getReader, no incremental chunks)         │
  └──────────────────────────────────────────────┘
```

**Where realtime would attach if the product grew.** Three plausible features, none built:

```
  feature (hypothetical)        would need        replaces
  ───────────────────────────   ───────────────   ─────────────────────
  live GPS turn-by-turn         streamed position  the one-shot Location
  re-route                      updates (local)    call (MapScreen:97)
  ───────────────────────────   ───────────────   ─────────────────────
  live traffic/closure overlay  SSE or WebSocket   nothing (new data
                                from a backend      source entirely)
  ───────────────────────────   ───────────────   ─────────────────────
  collaborative route share     WebSocket          nothing (new feature)
```

Note the first one is the closest: turn-by-turn navigation does involve a continuous *local* GPS stream — but that's the device's location API, not a network transport. Even a full nav feature wouldn't necessarily add a network WebSocket; it would re-run A* locally as the GPS position moves. So flattr could ship live navigation and *still* not need a realtime network transport. That's the surprising part worth saying out loud.

**No reconnect/heartbeat logic, because there's nothing to reconnect.** Realtime transports need reconnect-with-backoff, heartbeats/pings, and resume-from-offset logic — flattr has none, correctly, because it holds no long-lived connection. Its "reconnect" equivalent is the self-heal retry in `useTileGraph.ts:209-218`, which re-issues a *fresh one-shot build*, not a reconnect to a dropped stream.

### Move 2.5 — current vs future

```
  Phase A (now)                  Phase B (if realtime arrives)
  ───────────────────────────    ────────────────────────────────
  all request/response           a long-lived connection appears
  body buffered whole            body or events read incrementally
  no reconnect logic             reconnect + backoff + heartbeat
  self-heal = re-fetch one-shot  resume = reattach to the stream
  needs: nothing                 needs: a backend that pushes +
                                 ws/SSE client + connection lifecycle
```

The takeaway is *what doesn't have to change*: the graph build, the router, the cache, and all three current API calls stay exactly as they are. Realtime would be a new band added beside them, not a rewrite of the existing one.

### Move 3 — the principle

Realtime is a transport you reach for when data *changes while you're watching it* and the server knows before the client does. flattr's data is static (a baked graph, a DEM that never changes, address lookups that are stable), so request/response is not a limitation — it's the correct match. Adding a WebSocket to static data would be infrastructure with nothing to carry. Recognizing when you *don't* need realtime is as much a skill as knowing how to wire it.

## Primary diagram

The complete picture — the realtime band empty, with its hypothetical attachment points marked.

```
  flattr realtime — empty band, future attachment points

  ┌─ what exists (request/response) ───────────────────────────┐
  │  fetch → await res.json() (whole body) → done → close       │
  │  Overpass · Open-Meteo · Nominatim  ·  local GPS one-shot   │
  └─────────────────────────────────────────────────────────────┘

  ┌─ what's NOT YET EXERCISED ─────────────────────────────────┐
  │  WebSocket · SSE · long-poll · streamed body · server push  │
  │  reconnect · heartbeat · resume-from-offset                 │
  │                                                             │
  │  would attach at: live nav (likely still local, no ws) ·    │
  │  live traffic overlay (SSE/ws + backend) · route sharing    │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The streaming case most relevant to the AI-engineering pivot is LLM token streaming (SSE) — the pattern in AdvntrCue's streaming response. That's the realtime transport you'll actually use next, and it's worth contrasting: an LLM stream is request/response that happens to deliver its *one* answer incrementally (token by token via SSE), which is different from a WebSocket's bidirectional push. flattr exercises neither, but the partition is the thing to carry forward — "stream one response" (SSE, LLM tokens) vs "push many messages" (WebSocket, live collaboration). When you build the AI features, you'll add the first; flattr's static-data shape is why it needs neither.

## Interview defense

**Q: Does flattr use any realtime transport, and if not, why not?**
None — no WebSocket, SSE, long-poll, or streamed body; every response is buffered whole via `await res.json()`. The reason is structural: flattr's data is static (baked graph, unchanging DEM, stable geocodes), so there's nothing for a server to push. Request/response is the correct match, not a limitation. Anchor: *static data needs no realtime; recognizing that is the skill.*

**Q: If you added turn-by-turn navigation, would you need a WebSocket?**
Probably not. Nav needs a continuous *local* GPS stream and a re-run of A* as position moves — both local. No server has to push anything, so no network realtime transport is required. A live *traffic* overlay would be the first real case for SSE/WebSocket, and it'd need a backend first. Anchor: *even live nav stays local; traffic is the first push case.*

## See also

- `03-tcp-udp-connections-and-sockets.md` — the long-lived socket a WebSocket would need
- `05-http-semantics-caching-and-cors.md` — how bodies are read whole today
- `.aipe/study-distributed-systems/` — server-push and the consistency it implies
- `.aipe/study-ai-engineering/` — LLM token streaming (SSE) as the next realtime pattern to learn
