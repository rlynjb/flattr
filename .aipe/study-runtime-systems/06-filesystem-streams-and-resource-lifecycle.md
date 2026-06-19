# Filesystem, streams, and resource lifecycle

*Files, streams, descriptors, handles, cleanup, resource ownership.*
**Type:** Industry standard (synchronous fs + bundler asset import).

## Zoom out, then zoom in

This is flattr's shortest runtime story, and that's the finding. The
entire filesystem footprint is **one synchronous write at build time and
one bundler import at run time.** No streams, no open file descriptors
held across awaits, no manual `close()`, no temp files, no locks. The
artifact is written whole, in one call, and read whole, by the bundler.

```
  Zoom out — the entire filesystem footprint, on the runtime map

  ┌─ BUILD process ──────────────────────────────────────────┐
  │  ★ mkdirSync("data") + writeFileSync(graph.json) ★        │ ← we are here
  │     one blocking write, whole object, then exit            │
  └────────────────────────┬─────────────────────────────────┘
                           │  graph.json copied into the bundle
  ┌─ RUN process ──────────▼─────────────────────────────────┐
  │  ★ import graph from "../assets/graph.json" ★             │ ← and here
  │     bundler inlines it — NO runtime fs read at all         │
  └──────────────────────────────────────────────────────────┘

   no createReadStream/createWriteStream, no fs.open/close,
   no fds held across awaits — `not yet exercised`
```

Zoom in: the question is *what files does flattr touch, who owns the
handles, and when are they released?* The answer is almost trivially safe
— synchronous calls own their handle for the duration of the call and the
OS releases it the instant the call returns. There's nothing to leak
because nothing is held.

## Structure pass

**Layers.** The file lifecycle nests:

```
  Layered decomposition — "who holds the file handle, for how long?"

  ┌───────────────────────────────────────────────┐
  │ outer: the OS file (data/graph.json on disk)   │ → OS owns the bytes
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ middle: writeFileSync's transient handle  │ → held for ONE call
      └─────────────────────────────────────────┘    (opened+closed atomically)
          ┌─────────────────────────────────────┐
          │ inner: the bundler's compile-time read│ → no runtime handle at all
          └─────────────────────────────────────┘    (inlined into JS)

  "who holds the handle?" — OS / a single sync call / nobody (it's inlined)
```

**Axis — resource lifecycle.** Trace "when is the handle acquired and
released?" `writeFileSync` acquires a descriptor, writes, and releases it
— all inside the one call, synchronously. The run-time import has *no*
descriptor: the bundler turned the JSON into a JS object at compile time,
so the phone never opens the file. The handle's lifetime is "one function
call" at build, and "doesn't exist" at run.

**Seam.** The boundary is **synchronous fs call ↔ bundler asset
pipeline**. On the build side, a real (brief) file handle. On the run
side, no handle — just a module reference. The lifecycle axis flips from
"handle held for a call" to "no handle ever."

## How it works

### Move 1 — the mental model

You know the safe version of file I/O from any "write a config file"
script: `writeFileSync(path, data)` opens, writes, and closes in one
breath — you never see the descriptor, and there's nothing to forget to
close. The dangerous version (open a stream, write chunks, remember to
`.end()`/`.close()`, handle errors mid-stream) doesn't exist here. flattr
uses only the safe version.

```
  Pattern — synchronous open-write-close as one atomic call

   writeFileSync(path, data)
        │
        ├─ OS: open(path)        ─┐
        ├─ OS: write(all bytes)   │ all inside the one call;
        └─ OS: close(fd)         ─┘ the fd never escapes to your code

   contrast (NOT used): createWriteStream → write chunks → .end()
                        (handle lives across ticks; must remember to close)
```

### Move 2 — walk the lifecycle

**Build writes the whole graph in one synchronous call.** `run-build.ts`
finishes by `JSON.stringify`-ing the entire graph and handing it to
`writeFileSync` — one string, one write, one implicit close. Because it's
*synchronous*, the descriptor is never held across an `await`, so there's
no "handle open while the event loop does something else" hazard. It
blocks the build thread for the duration of the write, which is fine —
it's the last thing the build does.

```
  Execution trace — the build's disk lifecycle

  step  call                          handle state
  ────  ────────────────────────────  ──────────────────────
  1     buildGraph resolves (in heap)  no fd
  2     mkdirSync("data")              fd opened+closed (the dir)
  3     JSON.stringify(graph)          no fd (pure CPU, big string)
  4     writeFileSync(path, string)    fd opened → write → closed
  5     main() resolves → process exit  no fd

  at no point is a descriptor held across an await or a tick boundary
```

**`mkdirSync({recursive:true})` is idempotent and synchronous too.** It
ensures `data/` exists before the write, and `recursive: true` makes a
re-run a no-op rather than an error. Same lifecycle: open, act, close,
inside the call.

**Run time has no file read at all.** This is the part people miss.
`loadGraph` does `import graph from "../assets/graph.json"` — the Metro
bundler resolves that at *build* time and inlines the parsed object into
the JS bundle. So on the phone there is no `fs.open`, no descriptor, no
parse-at-startup cost beyond what the JS engine spends materializing the
inlined literal. The "file" is gone by run time; only the data survives,
already in the heap.

```
  Layers-and-hops — graph.json from build to run, crossing the bundler

  ┌─ BUILD (Node fs) ─┐ hop1: writeFileSync   ┌─ disk ──────────┐
  │ run-build.ts       │ ────────────────────► │ data/graph.json  │
  └────────────────────┘                       └────────┬─────────┘
                                       hop2: manual copy │
                                            (dev step)   ▼
                                            ┌─ mobile/assets/graph.json ┐
                                            └────────────┬───────────────┘
                              hop3: Metro bundler INLINES │ (compile time)
                                                          ▼
  ┌─ RUN (Hermes) ────┐ hop4: import returns object  ┌─ JS bundle ─────┐
  │ loadGraph()        │ ◄─────────────────────────── │ inlined literal  │
  └────────────────────┘  (no runtime fs read)        └──────────────────┘
```

**No streams means no backpressure-from-disk to manage.** Streaming exists
to bound memory when data is too big to hold at once — you read/write in
chunks and let the consumer's pace throttle the producer. flattr holds the
whole graph in memory anyway (`05-`), so there's nothing to stream; the
544 KB write fits comfortably in one call. Streams would be the upgrade
*if* the graph grew to where stringifying it whole became a memory or
pause problem.

### Move 3 — the principle

The safest resource is the one whose handle never escapes the call that
opens it. Synchronous, whole-object I/O — open, act, close, atomically —
removes the entire category of "leaked descriptor" and "handle held across
an await" bugs. flattr earns that safety by keeping the artifact small
enough to write and read whole. The day the artifact is too big for that
(can't `JSON.stringify` it without a pause, can't inline it into the
bundle), you graduate to streams — and inherit the close/cleanup
discipline that comes with held handles.

## Primary diagram

The complete filesystem lifecycle — every handle, where it's held, where
it doesn't exist.

```
  flattr filesystem lifecycle — the whole thing

  BUILD PROCESS (real, brief handles)        RUN PROCESS (no handles)
  ──────────────────────────────────        ────────────────────────
  mkdirSync("data")        ─ fd: open→close   import graph.json
  JSON.stringify(graph)    ─ no fd               │
  writeFileSync(path, str) ─ fd: open→close      │ bundler inlined it
        │                                         │ at COMPILE time
        ▼                                         ▼
  ┌──────────────┐   manual copy (dev)    loadGraph() returns
  │ graph.json   │ ─────────────────────► the inlined object
  │ ~544 KB      │                        (zero runtime fs)
  └──────────────┘

  every handle: acquired and released inside one synchronous call
  run-time descriptors held: none
```

## Implementation in codebase

**Use cases.** The write happens once per `npm run build:graph`. The
"read" happens once per app launch, but it's not really a read — it's a
module evaluation of inlined data. There is no other filesystem access in
the codebase.

The entire write path — `mkdir` then one `writeFileSync`:

```
  pipeline/run-build.ts  (lines 11-13, 47-48)

  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));   ← whole object, one sync call
  }
  ...
  mkdirSync("data", { recursive: true });          ← idempotent dir ensure
  writeGraph(graph, "data/graph.json");            ← the only disk write in the repo
        │
        └─ synchronous, so the fd is opened, written, and closed inside the
           call — never held across an await. recursive:true makes re-runs safe.
           This is the LAST thing the build does before main() resolves and exits.
```

The build-graph module is deliberately fs-free so it can run on-device:

```
  pipeline/build-graph.ts  (lines 1-2)

  // pipeline/build-graph.ts — orchestrate the stages into a Graph.
  // No node:fs here so this module bundles for the app (on-device tile building).
        │
        └─ load-bearing comment: keeping node:fs OUT of build-graph is why
           useTileGraph can call buildGraph on the phone (where there's no fs).
           The fs lives only in run-build.ts, which is build-time-only.
```

The run-time "read" that isn't a read:

```
  mobile/src/loadGraph.ts  (lines 7-11)

  import graph from "../assets/graph.json";   ← Metro inlines this at compile time
  export function loadGraph(): Graph {
    return graph as unknown as Graph;          ← returns an in-memory object,
  }                                            ║   not a file read
        │
        └─ no fs.readFile, no parse call, no descriptor. The phone never opens
           a file — the bundler already turned JSON bytes into a JS literal.
```

## Elaborate

Synchronous whole-file I/O is the right default for small artifacts and
the wrong one for large or streaming data — `writeFileSync` blocks the
thread and `JSON.stringify` materializes the whole string in memory before
a single byte hits disk. flattr is firmly in "small artifact" territory
(544 KB), so the simple path is correct. The split where `build-graph.ts`
stays `node:fs`-free while `run-build.ts` owns the fs is a nice piece of
layering: the *orchestration* (parse→split→grade) is portable to the
phone, and only the *persistence* is Node-bound. The upgrade path, if the
graph ever outgrows whole-object I/O, is `createWriteStream` + JSON
streaming (or a binary format) — at which point you inherit the
close/error-handling discipline this code currently gets to skip. Read
`05-` for why the graph is held whole in the first place, and `07-` for
how the streaming-as-backpressure idea connects.

## Interview defense

**Q: "How does the app load its graph at startup — is there a file read?"**

No runtime file read. `loadGraph` does `import graph from
".../graph.json"` (`loadGraph.ts:7`), which Metro inlines into the JS
bundle at compile time. The phone gets the parsed object as a literal — no
`fs.open`, no descriptor, no startup parse beyond materializing the
inlined data. The only real file I/O is the build-time `writeFileSync`.

```
  build: writeFileSync ──► graph.json ──► bundler inlines ──► run: in-memory object
                                          (no runtime fs read)
```

Anchor: *"The bundler turns the file into data at compile time — by run
time there's no file, just the bytes already in the heap."*

**Q: "Any risk of leaked file handles?"**

None. The only fs calls are synchronous (`writeFileSync`, `mkdirSync`,
`run-build.ts:12,47`) — the descriptor is opened, used, and closed inside
the single call, never held across an `await` or a tick. There are no
streams to forget to close.

```
  writeFileSync = open+write+close, atomic ─► nothing to leak
```

Anchor: *"Synchronous whole-file calls never let the descriptor escape —
no held handles, no leaks."*

## Validate

**Reconstruct.** Draw the file lifecycle: the one write (with its
open→close), the disk artifact, the bundler inline, the run-time
no-handle import. Check against the Primary diagram.

**Explain.** Why does `build-graph.ts` deliberately avoid `node:fs`
(`build-graph.ts:1-2`)? (So the orchestration module bundles for the
phone, where `useTileGraph` calls `buildGraph` on-device and there's no
filesystem.)

**Apply.** The graph grows to 50 MB and `JSON.stringify` in
`writeGraph` causes a long pause. What's the resource-lifecycle upgrade?
(Switch to `createWriteStream` + a streaming JSON serializer or a binary
format — bounding memory by writing in chunks, accepting the held-handle +
explicit-close discipline that comes with it.)

**Defend.** Argue that synchronous `writeFileSync` is correct here, not a
blocking-call smell. (It's the last operation in a build-time CLI on an
idle thread with no UI — blocking is free, and whole-object write is
simplest for a 544 KB artifact. `run-build.ts:47`.)

## See also

- `05-memory-stack-heap-gc-and-lifetimes.md` — why the graph is held whole
- `07-backpressure-bounded-work-and-cancellation.md` — streaming as backpressure
- `01-runtime-map.md` — the file as the build↔run seam
