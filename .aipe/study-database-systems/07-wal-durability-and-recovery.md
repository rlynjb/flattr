# WAL, durability, and recovery

**Industry names:** write-ahead log (WAL) · durability · fsync · checkpoint ·
crash recovery · backup/restore — *type label: Industry standard.*

**Status in flattr:** WAL, checkpointing, and recovery are **not yet
exercised** — there is no log and no restore path. *Durability itself IS
exercised*, in one place: the debounced, best-effort, whole-blob write in
`elevCache.ts`. This file teaches the durability spectrum and places flattr's
single write path on it honestly.

## Zoom out, then zoom in

Durability is the promise that **a write you were told succeeded survives a
crash.** flattr makes a *weak* version of this promise for exactly one thing:
the elevation cache. The graph needs no durability (it's a read-only bundled
artifact — losing it is impossible, it's in the app binary). So the entire
durability surface is one debounced `setItem`.

```
  Zoom out — the durability surface

  ┌─ Storage layer ─────────────────────────────────────────────┐
  │                                                             │
  │  graph.json   → bundled in app binary → can't be "lost"     │
  │                 durability = N/A (it's read-only ship data) │
  │                                                             │
  │  ★ elevCache → AsyncStorage key "...v1" ★                  │ ← the ONLY
  │     debounced 4s · whole-blob rewrite · best-effort        │   durable write
  │     no WAL · no fsync control · no recovery beyond reload  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. Durability is a *spectrum*, not a yes/no: from "lost on app kill"
(in-memory only) through "lost on crash within the debounce window"
(flattr's cache) up to "fsync'd to a WAL before ack" (Postgres
`synchronous_commit=on`). flattr deliberately sits low on that spectrum
because the data it persists is *reconstructible* — every cached value can be
re-fetched from the elevation API. Knowing exactly where flattr sits, and why
that's the right altitude for *this* data, is the lesson.

## The structure pass

**Layers.** Three durability tiers in play: in-memory `mem` (lost on
process death), the AsyncStorage blob (survives restart), and the API
(ultimate source of truth, re-fetchable).

**Axis — what survives which failure?** Trace it:

```
  Axis: "what survives ___?" down the durability tiers

  failure →     app reload   crash mid-debounce   device wipe
  ──────────    ──────────   ─────────────────    ───────────
  mem (RAM)     LOST         LOST                 LOST
  blob (disk)   survives     survives (old data)  LOST
  API (cloud)   survives     survives             survives
               ↑ reload reads blob, refills mem; misses re-fetch from API
```

**Seam.** The load-bearing boundary is **the debounce window**. Inside the
4-second window after a `putElev`, the new entry lives only in `mem` — a
crash there loses it (it'll be re-fetched, so no harm). After `persistNow`
runs, it's on disk. The seam between "in mem only" and "on disk" is the
4-second timer, and that window *is* flattr's durability gap — bounded,
deliberate, and harmless because the data is reconstructible.

## How it works

### Move 1 — the mental model

You know debounced autosave — type into a doc, and it saves 2 seconds after
you stop, not on every keystroke, to avoid hammering the server. flattr's
durability is exactly that pattern pointed at disk: buffer writes in memory,
flush the whole buffer on a timer. The database-grade version (WAL) is the
*opposite* trade — log every write immediately so nothing is ever lost,
accepting the I/O cost. flattr chose autosave because its data is cheap to
recreate.

```
  The durability spectrum — flattr sits low, on purpose

  WEAK ◄──────────────────────────────────────────────► STRONG
  in-memory     debounced blob      append-only WAL    WAL + fsync
  only          (flattr) ★          + checkpoint        per commit
  ─────────     ───────────────     ───────────────     ───────────
  lost on       lost within         lost only if disk   never lost
  process exit  4s window           itself fails        once ack'd
                (re-fetchable!)
```

### Move 2 — the parts, one at a time

**The buffer — in-memory `mem`.** Every cached elevation lands first in
`mem` (`elevCache.ts:11`, `new Map`). `putElev` marks `dirty = true` and
arms a debounce timer (`elevCache.ts:35-40`). Nothing touches disk yet. What
breaks if the buffer were the *only* tier: an app restart loses every cached
value and the next session re-fetches everything, hammering the rate-limited
API. The disk tier exists precisely to avoid that.

**The flush — debounced whole-blob write.** After 4 seconds of quiet
(`PERSIST_DEBOUNCE_MS = 4000`, `elevCache.ts:8`), `persistNow` serializes the
*entire* Map and overwrites the key:

```ts
// mobile/src/elevCache.ts:42-57 — the flush, annotated
async function persistNow(): Promise<void> {
  persistTimer = null;
  if (!dirty) return;                              // nothing new → skip the write
  dirty = false;
  try {
    let entries = [...mem.entries()];              // snapshot the WHOLE cache
    if (entries.length > MAX_ENTRIES) {            // safety cap: drop oldest
      entries = entries.slice(entries.length - MAX_ENTRIES);
      mem.clear();
      for (const [k, v] of entries) mem.set(k, v);
    }
    await AsyncStorage.setItem(STORAGE_KEY,        // ← ONE write of the whole blob
      JSON.stringify(Object.fromEntries(entries)));//   (not a per-entry append)
  } catch {
    dirty = true;                                  // failed → retry next debounce
  }
}
```

This is **checkpoint-only durability with no log.** A database writes a small
WAL record per change (cheap, append-only) and periodically checkpoints the
full state. flattr skips the WAL and *only* checkpoints — it rewrites
everything every flush. That's O(total cache size) per write, not O(change
size). Fine at a few thousand floats; it would be the bottleneck at a million
entries (you'd rewrite megabytes to add one key). The `MAX_ENTRIES = 50000`
cap (`elevCache.ts:9`) is the crude bound that keeps the blob small enough
for this to stay cheap.

```
  Comparison — WAL+checkpoint vs. flattr's checkpoint-only

  DATABASE (WAL + checkpoint)        FLATTR (checkpoint-only)
  ┌──────────────────────────┐       ┌──────────────────────────┐
  │ write → append 1 WAL rec │       │ write → mem.set + dirty   │
  │   (cheap, O(1))          │       │ debounce 4s               │
  │ later: checkpoint full   │       │ flush → rewrite WHOLE blob │
  │   state to data file     │       │   (O(N) every flush)      │
  │ crash → replay WAL       │       │ crash → reload last blob, │
  │   → zero loss            │       │   re-fetch the gap        │
  └──────────────────────────┘       └──────────────────────────┘
```

**Best-effort, not guaranteed.** The `catch` swallows the failure and sets
`dirty = true` so the next `putElev` retries (`elevCache.ts:54-55`). There's
no fsync control, no ack-before-proceed, no error surfaced to the user. A
write can silently fail and you'd only know because the data re-appears in
`mem` to be retried. This is **best-effort durability** — correct for a cache
(the API is the source of truth) and *wrong* for anything you can't
recreate. Naming that boundary is the point: this exact code would be a
data-loss bug if it held user routes instead of re-fetchable elevations.

**Recovery — reload, not replay.** flattr's only recovery is
`loadElevCache` at startup (`elevCache.ts:17-29`): read the blob, parse it,
seed `mem`. There's no log to replay, no crash-consistency check, no torn-
write detection. If the blob is corrupt, the `catch` (`elevCache.ts:26-28`)
starts from empty and the cache simply rebuilds from the API. "Recovery" here
means "lose the cache, refill it" — acceptable only because the cache is
disposable.

```
  Layers-and-hops — recovery path at startup

  ┌─ Disk ───────┐  hop 1: getItem("...v1")  ┌─ loadElevCache ─┐
  │ blob "...v1" │ ─────────────────────────► │ JSON.parse      │
  └──────────────┘                             └────────┬────────┘
       │ corrupt? hop 2a: catch → empty mem            │ hop 2b: seed
       └─────────────────────────────────────────────► │ mem.set(k,v)
                                                        ▼
                                              ┌─ Runtime mem ───┐
                                              │ cache restored  │
                                              └─────────────────┘
```

### Move 2.5 — the graph's durability gap (the schema-version finding)

The graph artifact's durability is trivially perfect (it's in the binary),
but its *recovery from a schema change* is broken — the same finding as `02`,
viewed through recovery. The cache blob is versioned (`"...v1"`,
`elevCache.ts:7`); bump the shape, bump to `.v2`, old reads cleanly miss and
rebuild. The graph has no version tag, so a shape change between
`pipeline/` and a stale bundled `graph.json` is undetectable at load
(`loadGraph.ts:10`, `as unknown as Graph`).

```
  Comparison — the cache can recover from a schema change; the graph can't

  CACHE                              GRAPH
  ┌──────────────────────────┐       ┌──────────────────────────┐
  │ key carries ".v1"        │       │ no version field          │
  │ shape change → ".v2"     │       │ shape change → silent     │
  │ old reads miss → rebuild │       │   field reads = undefined │
  │ → safe                   │       │ → corrupt routes, no error│
  └──────────────────────────┘       └──────────────────────────┘
```

**The fix is one line:** a `"schemaVersion"` field in `graph.json`, checked
in `loadGraph`, throwing on mismatch. Not urgent (app + pipeline ship
together today), but it's the recovery gap that bites the day they diverge.
Red flag #2.

### Move 3 — the principle

Durability is a **price you pay proportional to how irreplaceable the data
is.** flattr's cache is fully reconstructible from the API, so it pays the
cheapest durability that still avoids re-fetch storms: a debounced
best-effort blob. The graph is reconstructible from the pipeline, so it pays
none. The discipline that transfers: before choosing a durability level, ask
"if I lose this write, what's the cost to recreate it?" — and don't buy WAL+
fsync for data the API can hand you back for free.

## Primary diagram

```
  flattr's durability + recovery, end to end

  ┌─ WRITE PATH (durability) ───────────────────────────────────┐
  │  putElev → mem.set + dirty=true + arm 4s timer              │
  │     │                                                       │
  │     │ 4s quiet (debounce window = the durability gap)       │
  │     ▼                                                       │
  │  persistNow → snapshot WHOLE mem → JSON → setItem(key,blob) │
  │     checkpoint-only (no WAL) · O(N) per flush · best-effort │
  │     catch → dirty=true → retry next debounce                │
  └─────────────────────────────────────────────────────────────┘
  ┌─ READ/RECOVERY PATH ────────────────────────────────────────┐
  │  loadElevCache → getItem → parse → seed mem                 │
  │     corrupt → catch → start empty → rebuild from API        │
  │  "recovery" = reload + re-fetch, NOT replay                 │
  └─────────────────────────────────────────────────────────────┘
       graph durability: N/A (bundled) · graph recovery GAP:
       no schemaVersion → stale-shape mismatch is silent (fix: 1 field)
```

## Elaborate

The WAL exists to solve the **torn-write / partial-flush** problem: a crash
mid-write leaves the data file half-updated, and the log is the only way to
know what to redo or undo. flattr can't suffer a torn write that *matters*
because (a) the write is a single `setItem` the KV store treats atomically,
and (b) even a fully lost write just re-fetches. That's the same reasoning
behind treating caches as disposable everywhere: durability engineering is
expensive, and you only pay it for data without another source of truth.
When you read about `synchronous_commit`, `fsync`, and checkpoint tuning,
anchor them here — they're all knobs on *how much you pay to never lose a
write*, and flattr turned them all to "cheapest" because its writes are free
to recreate.

## Interview defense

**Q: Walk me through flattr's durability guarantee for the cache.**
It's debounced, whole-blob, best-effort. A write lands in an in-memory Map
and arms a 4-second timer; on fire, `persistNow` serializes the *entire*
cache and overwrites one AsyncStorage key (`elevCache.ts:42-57`). It's
checkpoint-only — no WAL, so it rewrites everything every flush (O(N), bounded
by a 50k-entry cap). The failure path swallows the error and retries on the
next write. A crash within the 4-second window loses the unflushed entries —
which is fine, because every value is re-fetchable from the elevation API.

```
  debounce window = the loss window; loss = re-fetch = harmless
```
*Anchor: best-effort checkpoint-only durability — correct because the data is
reconstructible.*

**Q: Where's the recovery gap, given the cache has none worth fixing?**
The graph. The cache key is versioned (`"...v1"`) so a schema change migrates
cleanly. The graph artifact has no version field, and `loadGraph` casts the
JSON to `Graph` with no check (`loadGraph.ts:10`). A stale `graph.json` after
a pipeline shape change reads missing fields as `undefined` with no error —
silent corruption. One `schemaVersion` field checked at load closes it.
*Anchor: the cache can recover from a schema change; the graph can't — it
forgot its version tag.*

## See also

- `02-records-pages-and-storage-layout.md` — the same schema-version finding,
  from the layout angle.
- `06-locks-mvcc-and-concurrency-control.md` — the async gap in the same
  write path.
- `09-database-systems-red-flags-audit.md` — both findings, ranked.
