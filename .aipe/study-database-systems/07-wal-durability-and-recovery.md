# WAL, durability, and recovery

**Industry name(s):** write-ahead log / durability (the D in ACID) / backup &
restore · **Type:** Industry standard — **mostly `not yet exercised`.** There's
no WAL and no runtime durability concern, because nothing is written at runtime.
The real durability story is "rebuild the artifact."

## Zoom out, then zoom in

Verdict first: **flattr has no write-ahead log and needs none, because it never
writes data at runtime.** A WAL exists to make writes survive a crash — log the
change before applying it, replay the log on restart. flattr's data is written
once, offline, and read-only thereafter, so there's no in-flight write to protect
and nothing to replay. Its "recovery" is regenerating the artifact from source.

```
  Zoom out — where durability is (and isn't) a concern

  ┌─ Build layer (the only write) ───────────────────────────────────┐
  │  pipeline reads OSM + elevation ──► writeFileSync(graph.json)     │
  │      durability question lives HERE (weakly) ──► f.below          │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ Storage ─────────────────▼──────────────────────────────────────┐
  │  graph.json — the artifact. "Backup" = the build inputs + script  │
  │  "Restore" = npm run build:graph                                  │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ Runtime ─────────────────▼──────────────────────────────────────┐
  │  reads only · ✗ no WAL · ✗ no fsync · ✗ no crash recovery ✗       │
  │  a crash loses only in-memory search state (recomputed for free)  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"if the process crashes, what data is lost and how do
you get it back?"* flattr's answer: at runtime, *nothing* is lost — the data is a
read-only file, and any in-flight computation (an A* search) just re-runs. The
only durable thing is the artifact, and it's recoverable by rebuilding.

## The structure pass

**Layers.** Build (writes the file), storage (holds it), runtime (reads it). The
durability concern only touches the build→storage seam.

**The axis: failure — what's lost on a crash, and how is it recovered?** Trace it
down the stack and watch "what's lost" shrink to nothing at runtime:

```
  Axis = "crash now — what's lost, how recovered?"

  ┌─ Build layer ─────────────────────────────────┐
  │  crash mid-writeFileSync                        │  → corrupt graph.json;
  │                                                 │    recover: rerun build
  └───────────────────────────┬─────────────────────┘
  ┌─ Storage ─────────────────▼─────────────────────┐
  │  file lost / corrupt                            │  → recover: rebuild from
  │                                                 │    OSM + elevation source
  └───────────────────────────┬─────────────────────┘
  ┌─ Runtime ─────────────────▼─────────────────────┐
  │  crash mid-search                               │  → lose ONLY in-memory
  │                                                 │    search state → re-run,
  │                                                 │    costs nothing durable
  └───────────────────────────────────────────────────┘
```

**Seams.** The one durability-relevant seam is the build's `writeFileSync`. It's
where data becomes durable, and it has a small, concrete weakness: it's not
crash-atomic (no temp-file + rename). That's the single actionable item in this
whole file. Everything else is correctly `not yet exercised`.

## How it works

### Move 1 — the mental model

You know `localStorage.setItem` — it persists synchronously and survives a reload,
but if the tab crashes mid-write the value can be half-written. A WAL is the
database's answer to that: write the *intent* to a log first, so a crash can
replay it. flattr is closer to the `localStorage` end — one synchronous file
write — but it sidesteps the crash problem entirely at runtime by never writing
at runtime.

```
  The pattern — durability is "survive a crash with no data loss"

  WAL approach:   log change ─► fsync log ─► apply ─► (crash? replay log)
  flattr approach: data is read-only at runtime ─► crash loses nothing durable
                   data is rebuildable from source ─► "restore" = rebuild
```

### Move 2 — what's here, what's absent

#### Runtime durability: a non-problem by design

If the Expo app crashes mid-route, what's lost? The A* search's `g`/`came`/
`closed` maps — all in-memory, all recomputed in milliseconds on the next request.
The `graph.json` is untouched (it's read-only and bundled). So a runtime crash
has *zero* durable data loss. There's nothing to fsync, nothing to log, nothing
to recover. This is the clean payoff of the read-only design.

```
  Runtime crash — nothing durable is lost

  crash during A* ──► lose g/came/closed (in-memory) ──► next request recomputes
  graph.json ──────► untouched (read-only bundle) ──────► no recovery needed
```

#### The artifact's durability: source + script, not a backup

The `graph.json` isn't backed up in the database sense. Its durability comes from
being *reproducible*: the build inputs (OSM via Overpass, elevation via
Open-Meteo, the bbox in `pipeline/config.ts`) plus the build script regenerate
it. Lose the file, run `npm run build:graph`, get it back. The "backup" is the
source data and the deterministic pipeline.

```
  "Restore" = rebuild from source

  lost graph.json ──► npm run build:graph ──► fetch OSM + elevation ──► rebuild
       │                                                                  │
       └─ caveat: not perfectly reproducible — OSM data and the Open-Meteo
          DEM can change between builds, and the API 429s under load (project
          memory). So the rebuild restores a CURRENT graph, not a byte-identical
          one. For a street graph that's fine; for a system needing exact
          reproducibility you'd snapshot the raw inputs too.
```

#### The one concrete gap: the build write isn't crash-atomic

`writeFileSync(path, JSON.stringify(graph))` writes in place. If the build crashes
mid-write (or the disk fills), `graph.json` is left corrupt — and a corrupt
artifact fails to parse at load, breaking the app. The standard fix is the atomic-
write pattern: write to `graph.json.tmp`, then `rename` it over `graph.json`
(rename is atomic on POSIX). One small change, closes the only durability hole.

```
  Atomic write — the fix for the one gap

  now:  writeFileSync("graph.json", json)            ✗ crash → corrupt file
  fix:  writeFileSync("graph.json.tmp", json)
        rename("graph.json.tmp", "graph.json")        ✓ crash → old file intact
                                                        (rename is atomic)
```

#### WAL specifically: not present, not needed

A WAL's job is to recover *uncommitted in-flight writes* after a crash. flattr has
no in-flight writes at runtime, and the build is a single batch write (no
incremental commits to log). So there is no WAL and adding one would protect
nothing. Correctly `not yet exercised`.

#### Move 2.5 — current vs future state

```
  Phase A (now): rebuild-as-recovery        Phase B (user edits persist)

  data read-only → crash loses nothing      edits written → crash can lose them
  restore = rebuild from source             restore = backup + WAL replay
  no fsync, no WAL                           need fsync on commit, WAL for replay
  build write not crash-atomic (small gap)   need a real durable write path
  reproducible-ish from OSM                  edits aren't in OSM → must back up
```

The trigger, again, is the first persisted runtime write. The moment a user edit
must survive a crash, "rebuild from OSM" stops working (OSM doesn't have the
user's edit), and you need real durability: fsync-on-commit, a WAL, and backups of
the mutable store.

### Move 3 — the principle

**Reproducible data needs no backup; rebuildable beats recoverable.** flattr's
durability strategy is to keep its data a pure function of versioned inputs, so
"recovery" is "recompute." The general lesson: data you can deterministically
regenerate from source doesn't need WAL/backup machinery — but the moment data
becomes a *fact only your system knows* (a user's edit), reproducibility breaks
and real durability becomes mandatory.

## Primary diagram

The full durability picture: the reproducible artifact, the runtime non-problem,
the one atomic-write gap.

```
  flattr durability & recovery — full picture

  ┌─ BUILD ──────────────────────────────────────────────────────────┐
  │  OSM + elevation (versioned source) ──► buildGraph ──►            │
  │  writeFileSync(graph.json)  ◄── ✗ NOT crash-atomic (one gap;      │
  │                                    fix = temp file + rename)      │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ STORAGE ─────────────────▼──────────────────────────────────────┐
  │  graph.json — "backup" = source + script · "restore" = rebuild   │
  │  (reproducible-ish: OSM/DEM may drift between builds)            │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ RUNTIME ─────────────────▼──────────────────────────────────────┐
  │  read-only · crash loses only in-memory search state (recomputed)│
  │  ✗ no WAL  ✗ no fsync  ✗ no crash recovery  — none needed         │
  │  [Phase B] persisted edits → WAL + fsync + backups land here      │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Durability is a build-time-only concern. The "recovery" path is a
developer running `npm run build:graph` when the data is stale or the file is
lost. At runtime, durability is never exercised.

**The one durable write (and its gap) — `pipeline/run-build.ts` (lines 10-13, 46-48):**

```
  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));   ← NOT crash-atomic: a crash or
  }                                                 full disk mid-write leaves a
  ...                                               corrupt graph.json that fails
  mkdirSync("data", { recursive: true });           to parse at load
  writeGraph(graph, "data/graph.json");
       │
       └─ THE one durability gap in the repo. Fix: write to a .tmp path then
          rename over the target (atomic on POSIX). Without it, an interrupted
          build can break the app's data load.
```

**The reproducibility source — `pipeline/run-build.ts` (lines 22-43):**

```
  function pickElevation(): Picked {
    const key = process.env.GOOGLE_ELEVATION_KEY;   ← source of elevation truth
    if (key) return { provider: googleProvider(key), ... };   (paid, best)
    if (FLAT_ELEVATION) return { fixtureProvider(()=>0) };     (offline fallback)
    return { provider: openMeteoProvider(), ... };             (free, default)
  }
  ...
  const osm = await fetchOverpass(BBOX);            ← source of street truth
       │
       └─ the artifact is a function of these inputs. "Restore" re-runs them.
          But they can drift (OSM edits, DEM changes) and Open-Meteo 429s under
          load (project memory) — so the rebuild is reproducible-ish, not exact.
```

**Proof of zero runtime durability concern — `features/routing/astar.ts` (lines 30-77):**

```
  const g = new Map(); const came = new Map(); const closed = new Set();
  ...the search mutates these...
  return { path, nodesExpanded, pushes, pops };
       │
       └─ all search state is in-memory and discarded on return. A crash mid-
          search loses only this, and the next request recomputes it for free.
          Nothing here ever touches disk — so there's nothing to make durable.
```

## Elaborate

WAL and crash recovery are among the most intricate parts of a real database, and
they're genuinely absent here — the right answer, not a gap, given read-only
runtime data. The disciplined move is to locate the *one* place durability is a
real concern (the build write) and name its *one* real weakness (not crash-atomic),
rather than imagine a WAL the system doesn't need.

The transferable insight is the rebuild-as-recovery strategy: when your data is a
deterministic function of versioned source, you replace backup/restore with
recompute. This is the same instinct as infrastructure-as-code and reproducible
builds — and it has the same limit. The day your system records a fact that isn't
in the source (a user's edit, a transaction), recompute can't recover it, and you
inherit the full durability problem: fsync-on-commit, a WAL for in-flight writes,
and real backups. flattr lives entirely on the recompute side of that line.

What to read next: `08` — replication, the last `not yet exercised` topic, where
"one bundled copy" means there's no lag or stale-read story to tell.

## Interview defense

**Q: "What's this system's durability and recovery story?"**

> Runtime durability is a non-problem — the data is a read-only file, so a crash
> loses only in-memory search state, which recomputes for free. The only durable
> write is the build's `writeFileSync`, and durability there means "the artifact
> is reproducible": lose `graph.json`, run `npm run build:graph`, rebuild it from
> OSM and elevation. There's no WAL because there are no in-flight writes to
> replay. The one real gap is that the build write isn't crash-atomic — a crash
> mid-write corrupts the file. Fix is a temp-file-plus-rename, one line.

```
  runtime crash → lose nothing durable    build write → reproducible (rebuild)
  WAL: not needed (no in-flight writes)   gap: writeFileSync not crash-atomic
```

Anchor: *rebuildable beats recoverable — recovery is `npm run build:graph`.*

**Q: "Is the rebuild a perfect backup?"**

> No — it's reproducible-*ish*. The graph is a function of OSM and the elevation
> DEM, and both can change between builds (plus Open-Meteo 429s under load). So a
> rebuild gives you a *current* graph, not a byte-identical one. Fine for a street
> graph; if you needed exact reproducibility you'd snapshot the raw inputs too.

```
  source (OSM + DEM) ──► rebuild ──► current graph (not byte-identical)
```

Anchor: *data reproducible from drifting source is recoverable-as-current, not exact.*

## Validate

1. **Reconstruct:** explain why a runtime crash loses no durable data, using the
   in-memory-search-state argument (`astar.ts:30-77`).
2. **Explain:** what's the one durability gap in the repo, and what's the one-line
   fix? (`run-build.ts:12`; temp file + rename.)
3. **Apply:** a user edits an edge and it must survive a crash. Why does
   "rebuild from OSM" no longer work, and what do you add?
4. **Defend:** someone says "you have no backups, that's irresponsible." Counter
   it using the reproducible-artifact argument (`run-build.ts:22-43`) and name
   its actual limit (input drift).

## See also

- `05-transactions-isolation-and-anomalies.md` — the build write as a weak "commit"
- `06-locks-mvcc-and-concurrency-control.md` — the immutability that makes runtime durability moot
- `08-replication-and-read-consistency.md` — the last `not yet exercised` topic
- `.aipe/study-system-design/` — the build-as-artifact pipeline in full
