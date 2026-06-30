# Filesystem, Streams, and Resource Lifecycle — handles and cleanup

**Industry name:** resource lifecycle / I/O handles / persistence — *Industry standard*.

## Zoom out, then zoom in

flattr touches durable storage in exactly two places, and they couldn't be more different:
the pipeline writes one file once and exits; the app reads-modifies-writes a debounced
key-value store. Here's where they sit.

```
  Zoom out — the two durable-storage touchpoints

  ┌─ BUILD TIME (Node fs) ───────────────────────────────────────┐
  │  run-build.ts → writeFileSync("data/graph.json")  (once)     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ artifact bundled into the app
  ┌─ RUN TIME (Hermes) ──────────▼───────────────────────────────┐
  │  loadGraph(): read bundled JSON once                         │
  │  ★ elevCache → AsyncStorage: debounced read-modify-write ★   │ ← we are here
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"what resources does flattr open, and what guarantees they're
cleaned up?"** The honest answer is that flattr opens almost nothing that needs cleanup —
no long-lived file descriptors, no streams, no sockets it manages by hand. The one resource
*lifecycle* worth studying is the AsyncStorage cache: load-once, batched debounced writes,
FIFO cap. Trace that, and note all the descriptor-heavy machinery flattr deliberately
doesn't have.

## Structure pass — layers, one axis, the seams

**The layers:** build-time fs → bundled read → runtime key-value store. **The axis: "what
opens a handle, and who closes it?"**

```
  Axis: "handle ownership — who opens, who closes?"  — traced down

  ┌─ build fs write ─────────────────────────────┐
  │  writeFileSync                                │  → Node opens + closes the fd
  └────────────────────────────────────────────────┘    synchronously, internally
      ┌─ bundled read ───────────────────────────┐
      │  import graph from "graph.json"           │  → no runtime handle: inlined by
      └────────────────────────────────────────────┘    the bundler at build time
          ┌─ AsyncStorage R/M/W ─────────────────┐
          │  getItem / setItem                    │  → native owns the handle;
          └────────────────────────────────────────┘    you get a Promise, not an fd
```

The answer is the same at every layer: **flattr never holds a raw handle.** Node closes the
fd inside `writeFileSync`; the bundler erases the runtime read; AsyncStorage hides the
descriptor behind a promise. **The seam that needs care isn't a handle — it's the
read-modify-write race on the cache.** Hand off to How it works.

## How it works

### Move 1 — the mental model

You've used `localStorage` in a web app: `getItem`/`setItem`, no file handles, no cleanup —
the browser owns the storage. AsyncStorage is the React Native version, just promise-based
because it's off the JS thread. flattr's whole persistence story is "load the blob once into
a `Map`, mutate the `Map` in memory, flush the whole blob back occasionally." The strategy:
**no handles to leak — treat durable storage as a load-once / flush-occasionally key-value
blob, and batch writes so you're not serializing JSON on every cache put.**

```
  Resource-lifecycle kernel — load once, mutate in mem, flush batched

   loadElevCache()  ──getItem──► parse blob ──► fill mem Map  (once)
        │
   putElev(k,v) ──► mem.set ──► mark dirty ──► schedule flush (debounced)
        │
   persistNow() ──► serialize mem ──► setItem (whole blob)  (every ~4s if dirty)
```

### Move 2 — the parts, one at a time

**Part 1 — the build-time write: fire-and-forget, self-closing.** The pipeline writes the
artifact with a synchronous call that opens and closes the descriptor internally:

```ts
// pipeline/run-build.ts:11-13 — writeFileSync opens, writes, and closes the fd itself
function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));   // ← no handle escapes; nothing to close
}
```

```
  Build write lifecycle — handle never escapes the call

  writeGraph()
    └─ writeFileSync: open fd → write bytes → close fd   (all inside one sync call)
  main() returns → process exits   (no open handles to leak)
```

What breaks if you used a manual `open`/`write`/`close`? You'd own the fd and have to close
it in a `finally`. `writeFileSync` removes that burden entirely. This is why `build-graph.ts`
has a comment (`build-graph.ts:2`) noting it imports *no* `node:fs` — keeping fs out of the
shared module so it bundles for the app; only the CLI entrypoint touches disk.

**Part 2 — the runtime read: erased by the bundler.** `loadGraph` looks like a file read but
isn't — Metro inlines the JSON at build time (`05`):

```ts
// mobile/src/loadGraph.ts:7-11 — a static import; no runtime fd, no async, no failure path
import graph from "../assets/graph.json";
export function loadGraph(): Graph {
  return graph as unknown as Graph;   // ← already in memory; zero I/O at runtime
}
```

There's no descriptor, no stream, no read error to handle (beyond the try/catch at
`MapScreen.tsx:28-34`). The "file" is just a module.

**Part 3 — the AsyncStorage cache: the one real lifecycle.** This is the only resource with
load → use → cleanup phases. Walk them:

*Load once.* `loadElevCache` is idempotent — a `loaded` flag makes repeat calls no-ops:

```ts
// mobile/src/elevCache.ts:17-29 — load-once guard; merges blob into the in-mem Map
export async function loadElevCache(): Promise<void> {
  if (loaded) return;                 // ← idempotent: safe to call on every mount
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const k in obj) if (!mem.has(k)) mem.set(k, obj[k]);   // ← don't clobber live values
    }
  } catch { /* corrupt/unavailable → start from memory */ }
}
```

*Mutate in memory, schedule a flush.* `putElev` never writes immediately — it marks dirty
and arms a single debounce timer:

```ts
// mobile/src/elevCache.ts:35-40 — write to mem now; schedule ONE batched flush
export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;           // ← dedupe: never re-write a known cell
  mem.set(key, value);
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS); // 4s, one timer
}
```

```
  Batched-write lifecycle — many puts, one flush

  putElev × 200  (during a build)
    └─ all mem.set immediately, dirty=true
    └─ first put arms a 4s timer; subsequent puts DON'T re-arm (if (!persistTimer))
                                   └──4s──► persistNow(): serialize ALL 200, one setItem
```

What breaks if you wrote on every `putElev`? You'd serialize the entire cache to JSON and
hit disk hundreds of times during one graph build — the debounce collapses that to one
write per ~4s. The `if (!persistTimer)` guard is what makes it *one* timer, not 200.

*Flush with a FIFO cap, retry on failure.* `persistNow` trims to the 50k ceiling (`05`) and,
critically, restores the dirty flag if the write throws so the next put retries:

```ts
// mobile/src/elevCache.ts:42-57 — flush; cap to 50k; re-dirty on failure for retry
async function persistNow(): Promise<void> {
  persistTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    let entries = [...mem.entries()];
    if (entries.length > MAX_ENTRIES) { /* keep newest 50k, rebuild Map (05) */ }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    dirty = true;   // ← write failed → re-dirty so the next putElev re-arms the flush
  }
}
```

What breaks without the `catch { dirty = true }`? A failed write would silently lose the
batch and never retry — the cache would persist nothing until the next *successful* arming.
Re-dirtying turns a transient write failure into a retry-on-next-put. This is the resource
lifecycle's durability guarantee.

**Part 4 — the read-modify-write "race" that isn't.** `loadElevCache` reads, `persistNow`
writes the whole blob. Could a flush mid-load clobber the loaded data? No — same reason as
`04`: both run on the one JS thread, and neither yields between read and the mem-mutation
that matters. The `if (!mem.has(k))` in load (`elevCache.ts:24`) further guards against
overwriting a value already sampled this session. *This is cooperative-single-thread safety,
not a lock.*

**Streams, descriptors, graceful close — not yet exercised.** flattr has no Node streams, no
`ReadableStream`/`WritableStream`, no manual `fs.open`/`close`, no socket lifecycle it
manages. Network responses are read whole (`.json()` buffers the entire body —
`overpass.ts:41`, `elevation.ts:111`), never streamed. *Trigger for streams:* a response too
large to hold in memory, or wanting to render partial graph as it arrives. *Trigger for
manual descriptors:* anything beyond `writeFileSync`/AsyncStorage — e.g., appending to a log
file or holding a DB connection.

### Move 3 — the principle

The cleanest resource lifecycle is the one with no handle to clean up: flattr uses
self-closing primitives (`writeFileSync`, AsyncStorage's promise API, bundler-inlined
imports) so there's nothing to leak. Where it *does* manage state over time — the cache — the
pattern is **load-once, mutate-in-memory, flush-batched-with-retry**, which is the
durable-cache shape behind everything from browser IndexedDB wrappers to write-back CPU
caches. The discipline isn't "remember to close things"; it's "pick primitives that close
themselves, and batch the one write path so you're not hammering the slow resource."

## Primary diagram

The full storage picture — both touchpoints, the cache lifecycle, what's absent.

```
  flattr resource lifecycle — two touchpoints, one managed cache

  ┌─ BUILD (Node fs) ────────────────────────────────────────────┐
  │  writeFileSync("data/graph.json")  → fd opened+closed inside  │
  │  process exits → no leaked handles                           │
  └───────────────────────────────┬──────────────────────────────┘
                          bundled into app
  ┌─ RUN (Hermes) ───────────────▼───────────────────────────────┐
  │  loadGraph(): import → in memory, zero runtime I/O           │
  │                                                              │
  │  elevCache lifecycle:                                        │
  │   loadElevCache (once) ──getItem──► mem Map                  │
  │   putElev × N ──► mem.set + dirty ──► 1 debounce timer (4s)  │
  │   persistNow ──► cap 50k ──► setItem ──► catch → re-dirty    │
  │                                                              │
  │  NOT PRESENT: streams · raw fds · socket lifecycle ·         │
  │               graceful close                                 │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

flattr's cache is a **write-back cache** in the classic sense — mutations land in fast
storage (the in-memory `Map`) immediately and propagate to slow storage (AsyncStorage)
lazily and in batches, exactly like a CPU write-back cache or a database buffer pool flushing
dirty pages. The debounce-timer + dirty-flag pair is the minimal write-back machinery: dirty
tracks "needs flushing," the timer decides "when." The re-dirty-on-failure is the durability
backstop that turns a lossy flush into an eventually-consistent one. The deliberate absence
of streams is the right call for flattr's data sizes (a viewport of OSM is KB-to-low-MB, fits
in memory) — streams earn their complexity only when data exceeds memory or latency demands
incremental processing. For the cache's memory-side cap and FIFO eviction, see `05`; for the
network reads that feed it, see `03` and `study-networking`.

## Interview defense

**Q: "What resources does this app open, and how are they cleaned up?"**

Almost none that need manual cleanup. The pipeline writes the graph with `writeFileSync`,
which opens and closes the fd internally, then the process exits. The app reads the graph as
a bundler-inlined import — no runtime handle. The only managed resource is the AsyncStorage
elevation cache, and that's a key-value store with no descriptor to leak.

```
  writeFileSync (self-closing) · import (no handle) · AsyncStorage (promise, no fd)
```

*Anchor:* "Nothing holds a raw handle — the cleanest lifecycle is the one with no handle to
clean up."

**Q: "Walk the cache write path. What stops it from hammering disk?"**

`putElev` writes the in-memory `Map` immediately and arms a single 4-second debounce timer;
subsequent puts don't re-arm it. After 4s, `persistNow` serializes the whole cache once,
caps it at 50k entries, and writes one `setItem`. If the write throws, it re-sets the dirty
flag so the next put retries.

```
  put×200 → mem + dirty → 1 timer → persistNow → cap → 1 setItem → (fail? re-dirty)
```

*Anchor:* "Write-back cache: mutate in memory now, flush batched later, re-dirty on failure
— the dirty flag plus one timer is the whole mechanism."

## See also

- `05-memory-stack-heap-gc-and-lifetimes.md` — the cache's 50k FIFO cap and in-memory growth.
- `04-shared-state-races-and-synchronization.md` — why the read-modify-write isn't a race.
- `03-event-loop-and-async-io.md` — the debounce timers and whole-body buffered reads.
- `study-data-modeling` (sibling) — the graph.json artifact's schema.
