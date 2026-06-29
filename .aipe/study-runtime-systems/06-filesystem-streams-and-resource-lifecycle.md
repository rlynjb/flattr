# Filesystem, Streams & Resource Lifecycle

**Industry name(s):** file handles · static build artifact · persistent KV store
· timer handles as resources · resource cleanup. **Type:** Industry standard.

## Zoom out, then zoom in

flattr touches durable resources in exactly three places, and they're cleanly
split by runtime. Build time owns a `node:fs` handle that writes one file. Run
time owns an AsyncStorage-backed cache and a fistful of timer handles. There are
**no streams** anywhere — all I/O is whole-body request/response.

```
  Zoom out — durable & OS resources, by runtime

  ┌─ BUILD time · Node ──────────────────────────────────────┐
  │  node:fs → mkdirSync + writeFileSync(data/graph.json)    │ ← write-once
  │  network sockets → Overpass, Open-Meteo (closed by fetch)│   artifact
  └────────────────────────┬──────────────────────────────────┘
                           │ ships graph.json (544 KB) into the bundle
  ┌─ RUN time · Hermes ─────▼────────────────────────────────┐
  │  bundled asset: graph.json (read-only, via import)       │ ← we are
  │  AsyncStorage: "flattr.elevCache.v1" (read/write KV)     │   here
  │  timer handles: timerRef, retryRef, persistTimer,        │
  │   suggestTimer ── must be cleared or they leak/double-fire│
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the question is **what resources are acquired, and who's responsible for
releasing them?** Files and sockets are short-lived and self-closing. The
durable resource is AsyncStorage. The *leakable* resources — the ones a careless
edit would mishandle — are the timers.

## Structure pass

**Layers.** Three resource classes: (1) the build artifact — a file written once,
then read-only forever; (2) the persistent cache — a single AsyncStorage key
holding the whole elevation Map as JSON; (3) ephemeral OS handles — `setTimeout`
IDs and the network sockets `fetch` opens and closes.

**Axis traced — "who releases this, and what leaks if they don't (failure)?"**

```
  One axis — "who releases it / what leaks?" — across resources

  graph.json (fs)      → process exit releases handle; no leak (write-once)
  fetch sockets        → fetch closes them; await res.json() drains the body
  AsyncStorage key     → no handle to release; debounced write, capped size
  setTimeout IDs       → ★ YOU must clearTimeout ★ or stale callbacks fire / pile up
```

**Seam — the import boundary on `graph.json`.** At build time it's a mutable file
behind a `node:fs` handle. After bundling, the *same bytes* are a frozen
read-only `import` (`loadGraph.ts:7`). The axis flips: writable file →
immutable in-memory object. That seam is the whole "static artifact" model —
`06`'s reason to exist. → also `01-runtime-map.md`.

## How it works

### Move 1 — the mental model

You know the lifecycle from any resource you've used: acquire → use → release,
and the release is the part that bites. A `fetch` is self-releasing once you read
the body. A file handle releases on process exit. But a `setTimeout` is a
resource you *must* release by hand — its handle outlives the function that made
it, and if you don't `clearTimeout`, the callback fires later against stale
state, or a new one stacks on the old.

```
  Pattern — resource lifecycle, and who owns the release

   resource        acquire            release             leak if not
   ────────        ───────            ───────             ───────────
   file            writeFileSync      process exit        (none)
   socket          fetch()            await res.json()    held connection
   AsyncStorage    setItem            (no handle)         stale data only
   timer  ★        setTimeout → id    clearTimeout(id)    callback fires/stacks
```

### Move 2 — the walkthrough

**Part 1 — the build artifact: acquire fs, write once, exit.** The entire
filesystem footprint of flattr:

```ts
// pipeline/run-build.ts:11-13, 47-48
function writeGraph(graph, path) { writeFileSync(path, JSON.stringify(graph)); }
...
mkdirSync("data", { recursive: true });   // ensure dir
writeGraph(graph, "data/graph.json");      // synchronous write, handle auto-closed
```

`writeFileSync` opens, writes, and closes the handle in one call — no descriptor
to track. The process then returns from `main()` and exits. Nothing leaks because
there's nothing held open. Note `build-graph.ts` itself has **no** `node:fs`
(header comment line 2) — fs lives only in the CLI entry, so the build logic
bundles for Hermes.

**Part 2 — the static artifact becomes a read-only import.** On the phone the same
bytes are loaded by the module system, not the filesystem:

```ts
// mobile/src/loadGraph.ts:7-11
import graph from "../assets/graph.json"; // bundled at build; in memory at startup
export function loadGraph(): Graph { return graph as unknown as Graph; }
```

There's no file open here — the bundler inlined `graph.json` into the JS bundle.
It's a frozen object held for the app's lifetime (via the `baseGraph` `useMemo`).
The lifecycle is trivial precisely because it's immutable: acquire at startup,
never release, never mutate.

**Part 3 — AsyncStorage: a single-key KV store with debounced, capped writes.**
This is the one read/write durable resource:

```ts
// mobile/src/elevCache.ts:17-29, 38-39, 42-57
export async function loadElevCache() {       // acquire: read the whole blob once
  if (loaded) return; loaded = true;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw) for (const k in JSON.parse(raw)) if (!mem.has(k)) mem.set(k, obj[k]);
}
export function putElev(key, value) {
  ...
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS); // ④ debounce
}
async function persistNow() {                  // release: write the whole blob back
  persistTimer = null; if (!dirty) return; dirty = false;
  ... AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}
```

The lifecycle: load-once (guarded by `loaded`), accumulate in memory, and
write-back debounced 4 s after the last `putElev` (④). The whole Map is one JSON
blob under one key — read-modify-write the entire thing, not per-entry. Why
debounce: a build samples hundreds of cells in a burst; without it, each `putElev`
would re-serialize and re-write the whole blob. The boundary condition: on a hard
crash within the 4 s window, the unflushed entries are lost — acceptable, since
they're just a re-fetchable cache.

**Part 4 — timers are the leakable resource, and every one is paired with a
clear.** This is where resource hygiene actually matters in the run-time process.
Four distinct timer handles, each cleared before re-arming:

```ts
// mobile/src/useTileGraph.ts:254-255 (debounce)
if (timerRef.current) clearTimeout(timerRef.current);     // release old
timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS); // acquire new

// mobile/src/useTileGraph.ts:211-212 (retry)
if (retryRef.current) clearTimeout(retryRef.current);
retryRef.current = setTimeout(() => { ...; pump(); }, RETRY_MS);

// mobile/src/MapScreen.tsx:74 (autocomplete suggest)
if (suggestTimer.current) clearTimeout(suggestTimer.current);
```

The clear-before-set idiom is what keeps a fast pan from leaving five debounce
timers armed — each new event cancels the prior pending one. The
`persistTimer` is managed differently: it's set only when *not* already pending
(`if (!persistTimer)`, `elevCache.ts:39`) and nulled inside `persistNow`, so at
most one persist is ever scheduled.

```
  State — a debounce timer's lifecycle across two fast events

   ┌────────┐  event 1   ┌──────────┐  event 2 (clearTimeout)  ┌──────────┐
   │  idle  │ ─────────► │ pending  │ ──────────────────────►  │ pending' │
   │ no id  │            │ id set   │  old id cancelled,       │ new id   │
   └────────┘            └────┬─────┘  new id set              └────┬─────┘
        ▲                     │ fires (or cleared)                  │ fires
        └─────────────────────┴─────────────────────────────────────┘
   only ONE timer ever armed → no stacking, no stale double-fire
```

**The gap:** none of these timers are cleared on unmount via a `useEffect`
cleanup. For `useTileGraph` that's low-risk (the hook lives for the app's life),
but it's the kind of resource-release a reviewer would flag — a fired-after-unmount
`setState` warning is the symptom. Noted in the audit.

### Move 3 — the principle

Resources fall into two camps: self-releasing (files, sockets — the runtime or the
API closes them) and you-release (timers — the handle outlives its creator).
flattr's file and socket lifecycle is trivial because they self-close; its real
discipline is the clear-before-set timer idiom, which is the manual release the
runtime won't do for you. Get that idiom wrong and you don't crash — you get
stale callbacks firing against state that moved on, the subtlest class of bug.

## Primary diagram

```
  All durable & OS resources, acquire → release, fully labelled

  ┌─ BUILD · Node ───────────────────────────────────────────┐
  │  fetch(Overpass/Open-Meteo) ─ socket ─ closed by res.json()│
  │  writeFileSync(graph.json) ─ fs handle ─ closed in-call    │
  │  → process exits, all handles gone                         │
  └────────────────────────┬───────────────────────────────────┘
                           │ graph.json bundled (read-only)
  ┌─ RUN · Hermes ─────────▼─────────────────────────────────┐
  │  import graph.json ─ in-memory, immutable, app lifetime   │
  │  AsyncStorage[elevCache.v1] ─ load-once, debounced write, │
  │                               capped 50k, whole-blob       │
  │  timers: debounce/retry/persist/suggest                   │
  │   ─ clear-before-set ─ at most one armed each ─ NO unmount │
  │     cleanup ◄─ minor gap                                  │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The "static artifact + read-only client" file model is the same one in
`01-runtime-map.md` and is the SSG pattern. The AsyncStorage usage is a classic
*whole-blob KV cache*: one key, serialize the entire map, debounce the writes —
simple and correct when the blob is small (50k number entries), but it's a
read-modify-write of the *whole* store on every flush, which wouldn't scale to a
large cache (you'd move to per-key storage or SQLite). The timer-handle hygiene is
the run-time analog of closing file descriptors — different resource, identical
discipline. Cross-link `.aipe/study-database-systems/` for the KV-store angle.

## Interview defense

**Q: What durable resources does the app manage, and how are they cleaned up?**

Three. The build artifact `graph.json` — written once with `writeFileSync`,
handle auto-closed, then read-only on the phone. AsyncStorage — a single-key
elevation cache, loaded once and written back debounced (`elevCache.ts`). And
timers — the leakable one, handled with clear-before-set so only one of each is
ever armed.

```
  the cleanup story, ranked by risk

  file/socket → self-close            (no risk)
  AsyncStorage → debounced, capped    (lose <4s on crash, re-fetchable)
  timers → clear-before-set ★         (the one you can get wrong)
           but: no unmount cleanup    (minor leak surface)
```

Anchor: *"The clear-before-set idiom at `useTileGraph.ts:254` is the real resource
discipline — without it, fast panning leaves a pile of armed debounce timers all
firing stale `queueViewport` calls. The gap is no `useEffect` cleanup to clear
them on unmount."*

**Q: Are there any streams?**

No — `not yet exercised`. Every I/O is whole-body: `await res.json()` reads the
entire response, `JSON.stringify` writes the entire cache. That's fine at this
data size; it becomes a problem only if a response is too big to hold in memory,
at which point you'd reach for a `ReadableStream` and chunked parsing.

## See also

- `01-runtime-map.md` — the `graph.json` build→run seam in context.
- `05-memory-stack-heap-gc-and-lifetimes.md` — the cache's in-memory side.
- `07-backpressure-bounded-work-and-cancellation.md` — timers as the cancellation substitute.
- `.aipe/study-database-systems/` — AsyncStorage as a persistent KV store.
