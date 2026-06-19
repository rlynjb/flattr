# Distributed system map
### the coordination map: nodes, boundaries, messages, ownership, failure domains
**Industry name:** system/coordination map, failure-domain diagram · **Type:** Language-agnostic

## Zoom out, then zoom in

Before any mechanism, look at the whole thing and ask the one question that defines a distributed system: *where do two machines have to coordinate, and which of them can fail independently?* For flattr the answer is small and sharp — there's exactly one kind of boundary, and you cross it the same way every time.

```
  Zoom out — every layer of flattr, with the one boundary that matters marked

  ┌─ UI layer (the phone, RN/Expo) ─────────────────────────────┐
  │  MapScreen.tsx · AddressBar.tsx · GradeSlider.tsx            │
  └───────────────────────────┬─────────────────────────────────┘
                              │  in-process calls (no network)
  ┌─ Coordination layer ──────▼─────────────────────────────────┐
  │  ★ useTileGraph.ts — single-flight pump(), corridor>view ★   │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK BOUNDARY (the only one) ═══
  ┌─ Provider layer (NOT yours) ──▼──────────────────────────────┐
  │  Overpass API   ·   Open-Meteo   ·   Nominatim               │
  │  (separate failure domains — each can 429/time out alone)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the "distributed system" here is not your boxes talking to each other — you only have one box live at a time. It's your box talking to *their* boxes. The coordination map is therefore almost entirely a **failure-domain map**: where does your process end and a machine you can't control begin, and what happens at that seam when the other side misbehaves. That seam — and only that seam — is what this whole guide studies.

## Structure pass

**Layers.** Three, top to bottom: UI (the React Native screens), a thin coordination layer (`useTileGraph` at build/runtime, `run-build.ts` at build time), and a provider layer of public APIs you don't own.

**The axis: failure domain — "if this stops responding, who notices and who keeps working?"** Trace it down the stack:

```
  One question — "what's an independent failure domain?" — traced down

  ┌──────────────────────────────────────┐
  │ UI screens                            │  → NOT independent: same process,
  └──────────────────────────────────────┘    crash together
      ┌──────────────────────────────────┐
      │ useTileGraph / run-build          │  → NOT independent: same process
      └──────────────────────────────────┘
          ═══ network boundary ═══           ← the answer FLIPS here
          ┌──────────────────────────────┐
          │ Overpass                      │  → INDEPENDENT domain (can be down
          ├──────────────────────────────┤    while Open-Meteo is up, and v.v.)
          │ Open-Meteo                    │  → INDEPENDENT domain
          ├──────────────────────────────┤
          │ Nominatim                     │  → INDEPENDENT domain
          └──────────────────────────────┘
```

**The seam.** There's one load-bearing seam: the network boundary. Above it, everything shares fate — a thrown error unwinds the whole call stack, one process, one device. Below it, each provider is its own failure domain that can be slow, throttled, or down *independently of the others*. That's why Overpass and Open-Meteo get **separate** retry policies (`02`) and why the elevation call gets degraded while the streets call still hard-fails — they're different domains with different consequences.

## How it works

#### Move 1 — the mental model

You already know the shape from any frontend app: a component calls `fetch()`, and the server it hits is somebody else's. The mental model for flattr's "distributed system" is just that, drawn honestly — a fan of independent remotes hanging off one client.

```
  The shape — one client, a fan of independent remotes

                    ┌────────────► Overpass    (domain A)
                    │
   [ your process ] ┼────────────► Open-Meteo  (domain B)
   one failure      │
   domain           └────────────► Nominatim   (domain C)

  A, B, C fail independently. Your process is the only point
  that sees all three. There is no coordination BETWEEN A/B/C
  and none between two copies of "your process" — there's one.
```

#### Move 2 — walk the map one boundary at a time

**The node inventory.** Name every participant. *Yours:* the build CLI (`pipeline/run-build.ts`) and the phone app (`mobile/`), never both live at once on the same data. *Not yours:* Overpass, Open-Meteo (or Google Elevation), Nominatim. That's the entire node set. The diagram below is a layers-and-hops view of who sends what to whom.

```
  Layers-and-hops — messages across the only boundary

  ┌─ Client (yours) ─┐  hop 1: POST bbox query     ┌─ Overpass ─────┐
  │  run-build /     │ ──────────────────────────► │  OSM ways      │
  │  useTileGraph    │  hop 2: JSON elements ◄───── └────────────────┘
  │                  │
  │                  │  hop 3: GET lat,lng list    ┌─ Open-Meteo ───┐
  │                  │ ──────────────────────────► │  DEM elevation │
  │                  │  hop 4: JSON elevations ◄─── └────────────────┘
  │                  │
  │                  │  hop 5: GET ?q=address      ┌─ Nominatim ────┐
  │                  │ ──────────────────────────► │  geocode rows  │
  └──────────────────┘  hop 6: JSON rows ◄──────── └────────────────┘
```

**Ownership.** Who owns state? *You* own the merged graph (`graph.json` at build, the React state in `useTileGraph` at runtime). The providers own the source-of-truth OSM/DEM data; you hold copies. Crucially, no piece of state is *shared* across a boundary that both sides mutate — every hop is a read. That single fact (state is owned, not shared) is why most of the hard distributed problems don't appear here.

**Failure domains.** Each provider is its own. The map's job is to make you ask, per boundary, "what if this one is down?" — and the answers differ: Overpass down ⇒ this build is skipped, retry on next pan (`useTileGraph.ts:121-122`); Open-Meteo down ⇒ degrade to flat, keep going (`:111`); Nominatim down ⇒ the geocode throws and the search box shows nothing. Same boundary type, three different blast radii.

#### Move 3 — the principle

A distributed system is defined by its **failure domains**, not its boxes. The map you draw first is always "what fails independently of what," because every later decision — retry here, degrade there, don't bother with a queue — falls out of where the domains split. flattr has exactly one split (your process | their APIs), which is why it gets to skip 80% of the distributed-systems playbook honestly.

## Primary diagram

The full recap — every node, every boundary, every owned-vs-borrowed piece of state in one frame.

```
  flattr coordination map — the whole thing

  ┌─ YOUR FAILURE DOMAIN ───────────────────────────────────────┐
  │                                                             │
  │  BUILD TIME                        RUN TIME                  │
  │  run-build.ts                      useTileGraph.ts          │
  │    owns: data/graph.json           owns: merged Graph state  │
  │    pickElevation() chain           pump() single-flight      │
  │         │                                │                   │
  └─────────┼────────────────────────────────┼──────────────────┘
            │        ═══ NETWORK ═══          │
   ┌────────┼────────┐  ┌──────────────┐  ┌──┼──────────┐
   ▼        ▼        ▼  ▼              ▼  ▼  ▼          ▼
  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐
  │ Overpass │  │ Open-Meteo / │  │ Nominatim│  │ (OpenFree- │
  │  streets │  │ Google elev. │  │  geocode │  │  Map tiles)│
  │  domain A│  │  domain B    │  │  domain C│  │  domain D  │
  └──────────┘  └──────────────┘  └──────────┘  └────────────┘
   retry+throw   degrade-to-flat   throw to UI    handled by
   (overpass.ts) (useTileGraph)    (geocode.ts)   MapLibre
```

## Implementation in codebase

**Use cases.** The map isn't a file — it's the union of where boundaries are crossed. Two concrete triggers: (1) `npm run build:graph` builds the static artifact by crossing the Overpass + Open-Meteo boundaries once each; (2) panning the map or routing on the phone crosses the same two boundaries again, live, through `useTileGraph`.

The clearest single place the *whole* failure-domain decision is encoded is the elevation-source fallthrough at build time:

```
  pipeline/run-build.ts  (lines 22–38, pickElevation)

  const key = process.env.GOOGLE_ELEVATION_KEY;
  if (key) return { provider: googleProvider(key), ... }   ← domain B = Google (paid)
  if (process.env.FLAT_ELEVATION === "1")
    return { provider: fixtureProvider(() => 0), ... }      ← NO domain B: synthetic, offline
  return { provider: openMeteoProvider(), ... }             ← domain B = Open-Meteo (free)
       │
       └─ this IS the failure-domain map as code: which remote (if any)
          owns elevation is chosen here. Drop the fixture branch and an
          offline build is impossible — that branch is the "boundary B
          can be removed entirely" escape hatch.
```

And the runtime edge of the same boundary, where one build crosses two domains in sequence:

```
  mobile/src/useTileGraph.ts  (lines 106–120, inside pump)

  const osm = await fetchOverpass(bbox);                    ← cross boundary A
  const elev = bestEffortElevation(openMeteoProvider(...)); ← wrap boundary B
  const g = await buildGraph(kind, bbox, osm, elev, ...);   ← B crossed inside here
       │
       └─ boundary A failing throws and is caught at :121 (skip build);
          boundary B failing is swallowed INSIDE bestEffortElevation and
          never reaches here. Two domains, two different fates, same hop.
```

## Elaborate

The "draw the failure domains first" move comes straight from production distributed-systems practice — it's the first thing an SRE does in an incident review and the first thing a design doc draws. The insight flattr makes vivid is the *degenerate* case: when you have exactly one of your own nodes, the map collapses to "me vs. the internet," and the entire discipline reduces to *client-side resilience against remotes you don't control*. That's not a lesser version of distributed systems — it's the base case every larger system is built out of. The retry loop you write against Overpass is the same retry loop a service mesh sidecar writes against a downstream service; there's just one of it instead of thousands.

What would grow the map: spec §11 D(2)/E(2) — a server-side A* over a served multi-city graph. The instant there are two server instances, you gain a *new* boundary type (your-node ↔ your-node) and with it the topics this guide currently marks `not yet exercised`: replication (`05`), leadership (`07`), and cross-boundary workflows (`08`).

## Interview defense

**Q: "Is this a distributed system? Walk me through the architecture."**
Verdict first: no — it's a single-process engine plus a single-device app over a static artifact. The only distributed surface is the client-to-third-party-API boundary. Sketch the fan diagram: one client, three independent remote failure domains (Overpass, Open-Meteo, Nominatim), no coordination between them and no second copy of my own node. The skill I'd show is recognizing that this is the *base case* of distributed systems — client resilience against uncontrolled remotes — not pretending it's something bigger.

```
   [ my one process ] ──► Overpass   (down? skip+retry)
                     ──► Open-Meteo (down? degrade to flat)
                     ──► Nominatim  (down? empty search)
   no node↔node coordination anywhere. one failure domain on my side.
```
*Anchor: one failure domain on my side; three independent ones on theirs.*

**Q: "What's the most load-bearing part of this map people miss?"**
That the three providers are *separate* failure domains, so they earn *separate* failure policies. Overpass down kills the build (retry later); Open-Meteo down only kills fidelity (degrade to flat); Nominatim down only kills search. Treating them as one "the network" would force one policy and lose that nuance. *Anchor: separate domains, separate blast radii, separate policies.*

## Validate

1. **Reconstruct:** draw flattr's failure-domain map from memory. How many of *your* nodes are live at once? (One.) How many independent remote domains? (Three: Overpass, Open-Meteo, Nominatim — four with OpenFreeMap tiles.)
2. **Explain:** why does `pipeline/run-build.ts:22-38` count as "the failure-domain map encoded as code"?
3. **Apply:** Nominatim starts returning 503s. Trace the blast radius using `pipeline/geocode.ts:24`. Whose screen breaks, and does routing still work?
4. **Defend:** someone says "add a retry queue so all three providers share one resilience layer." Argue why the *separate* policies at `pipeline/overpass.ts:18` vs `pipeline/elevation.ts:114` vs `useTileGraph.ts:18-28` are correct given the different blast radii.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what happens at each boundary when the remote misbehaves.
- `04-consistency-models-and-staleness.md` — the owned-copy-vs-source-of-truth split this map exposes.
- `.aipe/study-system-design/` — the same boundary at the architecture/scale altitude.
- `.aipe/study-networking/` — the transport mechanics of each hop drawn here.
