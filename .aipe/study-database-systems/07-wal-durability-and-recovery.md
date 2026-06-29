# WAL, durability, and recovery

**Industry name(s):** write-ahead log / durability (the D in ACID) / fsync /
crash recovery / backup & restore · **Type:** Industry standard.

> **Status in flattr: WAL `not yet exercised`; durability exercised weakly via
> one store.** flattr has no write-ahead log. Its only durable write path is the
> elevCache's debounced `AsyncStorage.setItem` (`elevCache.ts:53`), which is where
> the real (and thin) durability + recovery lessons live. This file teaches WAL in
> full and grounds durability/recovery in that one store.

## Zoom out, then zoom in

```
  Zoom out — durability is the floor under every write

  ┌─ App layer ──────────────────────────────────────────────┐
  │  putElev(cell, elev)  → in-memory Map (volatile)          │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Durability layer ─────────▼─────────────────────────────┐
  │  ★ debounced setItem → AsyncStorage (the durability seam) ★│ ← we are here
  │  ✗ NO write-ahead log · ✗ no fsync control · ✗ no backup  │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Physical layer ───────────▼─────────────────────────────┐
  │  device storage (SQLite-backed AsyncStorage on RN)        │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. Durability is the promise that *once a write is committed, a crash can't
lose it.* The hard part is that "writing to disk" isn't atomic at the hardware
level — a crash mid-write leaves a torn page — so databases write the *intent*
to a sequential log (the WAL) *before* touching the real data, so recovery can
replay or undo. flattr has no WAL because its writes are whole-blob single calls
(no torn-page risk, `02`) — but it *also* has a durability *window* during the
debounce where writes are committed in memory but not yet on disk. That window is
the lesson.

## The structure pass

**Layers** (by where a write lives, volatile → durable):
1. **In-memory** — the elevCache `Map` (`elevCache.ts:11`). Volatile.
2. **The debounce window** — committed to `Map`, scheduled but not yet persisted.
3. **On disk** — after `setItem` resolves. Durable (as durable as AsyncStorage).

**Axis traced — "if the process dies right now, is this write gone?"**

```
  axis — "crash → is the write lost?" — across the write's life

  ┌─ putElev returns ───────────────────────┐
  │  in Map, dirty=true, timer scheduled     │  CRASH → LOST (not on disk yet)
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (the 4-second debounce window)
  ┌─ persistNow runs setItem ──▼─────────────┐
  │  awaiting AsyncStorage write              │  CRASH → maybe lost (in flight)
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (setItem resolves)
  ┌─ on disk ──────────▼─────────────────────┐
  │  AsyncStorage blob committed              │  CRASH → SAFE
  └───────────────────────────────────────────┘
```

The axis-answer is "lost" for up to 4 seconds after every `putElev`. That's the
durability gap (red-flag #3). It's an *acceptable* gap — the lost data is just
cached elevation that gets re-fetched — but it's a real one, and naming it is the
point. A WAL is the mechanism that shrinks that window to ~zero for data you can't
afford to re-derive.

## How it works

### Move 1 — the mental model

You know `localStorage.setItem` blocks until it's written, but a `setState`
followed by an unmount loses the state. flattr's elevCache sits between those: a
write is instantly in memory (like `setState`) but only *eventually* on disk
(unlike `setItem`). The debounce is a deliberate bet — coalesce many writes into
one disk hit — and the cost of that bet is a window where "committed in memory"
≠ "safe on disk." A WAL is what you build when you can't afford that window.

```
  the pattern — WAL: log the intent before touching the data

  WRITE:  append "change X to v" to LOG (sequential, fast, fsync'd)
          ──► THEN apply the change to the data pages (can be lazy)
  CRASH:  replay the LOG from the last checkpoint → data is reconstructed
          ──► committed-but-unapplied changes are redone; partial ones undone
       ▲ the log is the source of truth for durability; data pages catch up
```

The insight: appending to a sequential log and fsync'ing *that* is far cheaper
than fsync'ing scattered data pages — so WAL makes durable commits fast *and*
crash-safe. flattr's whole-blob write is the opposite trade: no log, but the data
write itself is the durable commit (slower per write, but coalesced by debounce).

### Move 2 — flattr's durability mechanism, one piece at a time

**The debounce — write coalescing.** `putElev` doesn't write to disk; it marks
dirty and schedules:

```ts
// mobile/src/elevCache.ts:35-40 — commit to memory, schedule the disk write
export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;                  // line 36: idempotent — never overwrite
  mem.set(key, value);                       // line 37: COMMIT to volatile memory
  dirty = true;                              // line 38: mark there's unpersisted state
  if (!persistTimer)                         // line 39: only ONE timer in flight
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);  // 4s window
}
```

Line 37 is the in-memory commit (instantly visible to `getElev`). Line 39 ensures
N puts within 4 seconds produce *one* disk write, not N — the coalescing. The cost
is line 38's `dirty` flag describing data that exists only in RAM until the timer
fires.

**The flush — the actual durable write.** `persistNow` is flattr's "checkpoint":

```ts
// mobile/src/elevCache.ts:42-57 — the flush + its only recovery affordance
async function persistNow(): Promise<void> {
  persistTimer = null;
  if (!dirty) return;                        // line 44: nothing to flush
  dirty = false;                             // line 45: clear BEFORE the await (see note)
  try {
    let entries = [...mem.entries()];        // snapshot whole map (whole-blob write)
    // …FIFO cap to MAX_ENTRIES…
    await AsyncStorage.setItem(STORAGE_KEY,  // line 53: the durable write
      JSON.stringify(Object.fromEntries(entries)));
  } catch {
    dirty = true;                            // line 56: write FAILED → re-mark for retry
  }
}
```

Line 53 is the durability boundary — before it the data is volatile, after it
resolves it's on disk. Line 56 is flattr's *entire* recovery story for a failed
write: on error, re-set `dirty` so the next `putElev` reschedules a flush. That's
a crude retry, not a WAL — there's no log of *which* writes were pending, just
"something's dirty, try again." **Inference:** clearing `dirty=false` at line 45
*before* the await means a `putElev` arriving *during* the in-flight `setItem`
sets `dirty=true` again and correctly schedules another flush — so concurrent puts
aren't lost. But if the *write itself* fails, the catch re-marks dirty; the subtle
correctness here is that the snapshot already includes all puts up to line 47, so
re-flushing is safe (idempotent whole-blob write). It works, but it's reasoning
flattr gets right by luck of the whole-blob design, not by an explicit log.

**Recovery on startup — load, don't replay.** flattr's "crash recovery" is just
reloading the last persisted blob:

```ts
// mobile/src/elevCache.ts:17-29 — recovery = re-read the blob, tolerate corruption
export async function loadElevCache(): Promise<void> {
  if (loaded) return;                        // line 18: idempotent
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const k in obj) if (!mem.has(k)) mem.set(k, obj[k]);  // line 24: merge in
    }
  } catch {
    // line 26: corrupt/unavailable → start from whatever's in memory
  }
}
```

Line 24 merges the persisted blob into memory; line 26 is the durability/
availability tradeoff — a corrupt blob is *swallowed*, not surfaced, and the cache
starts empty. For a re-derivable cache that's the right call (worst case: re-fetch
elevations). For real data it would be silent data loss. The `.v1` in `STORAGE_KEY`
(line 7) is the one piece of *recovery-schema* discipline here — bump it and old
incompatible blobs are ignored cleanly instead of mis-parsed. That's the schema
version `graph.json` lacks (red-flag #2).

**Why there's no WAL — and when there would be.** A WAL exists to make
*partial-write* and *lost-recent-write* survivable for data you can't re-derive.
flattr's data is either immutable+re-buildable (the graph) or re-fetchable (the
cache), so it can afford to lose a recent write — re-derive it. The trigger for a
real WAL is **durable user-authored data that can't be re-derived**: saved routes,
preferences, sync state. The moment flattr stores something a user *created*
(not something it *computed*), the 4-second loss window stops being acceptable and
you need either synchronous writes or a real engine's WAL.

### Move 2.5 — current vs future

```
  Phase A (now)                      Phase B (durable user data / Postgres)

  write: debounced whole-blob        write: WAL append (fsync) → lazy data apply
  durability gap: up to 4s lost      durability gap: ~0 (committed = logged)
  recovery: re-read last blob;       recovery: replay WAL from checkpoint;
            swallow corruption                 redo committed, undo partial
  backup: none (it's a cache)        backup: base backup + WAL archive (PITR)
  carries over: the GRAPH still needs no WAL (immutable). Only new
                user-authored, non-re-derivable data does.
```

### Move 3 — the principle

Durability is a *window*, not a switch — the question is never "is it durable?"
but "how long is the gap between commit-in-memory and safe-on-disk, and can I
afford to lose what's in that gap?" flattr made the gap 4 seconds because the only
thing in it is re-derivable cache data. A WAL is the mechanism that drives the gap
to near-zero by logging intent sequentially before touching data — you reach for
it exactly when the data in the window can't be reconstructed. Reading a system
for "what's the durability window, and what's the cost of losing it" tells you
whether a missing WAL is a bug or a correct simplification.

## Primary diagram

```
  flattr's durability path vs the WAL it doesn't have

  ┌─ flattr (now) ─────────────────────────────────────────────┐
  │ putElev ─► Map (volatile) ─► dirty=true ─► [4s debounce] ─► │
  │           setItem whole blob ─► AsyncStorage (durable)      │
  │ recovery: loadElevCache re-reads blob; corruption swallowed │
  │ GAP: up to 4s of writes lost on crash (acceptable: cache)   │
  └─────────────────────────────────────────────────────────────┘
  ┌─ a real WAL (not present; the upgrade path) ───────────────┐
  │ write ─► append intent to LOG ─► fsync(log) ─► COMMIT ack   │
  │        ─► apply to data pages lazily                        │
  │ recovery: replay log from checkpoint (redo/undo)            │
  │ GAP: ~0 — committed means logged means survivable           │
  └─────────────────────────────────────────────────────────────┘
   trigger to cross: durable user-authored, non-re-derivable data
```

## Elaborate

WAL is the single most important durability mechanism in databases, and it does
double duty: it makes commits *fast* (one sequential fsync beats many scattered
ones) *and* crash-safe (replay reconstructs committed work). It's also the
substrate for two things beyond this file — **point-in-time recovery** (archive
the WAL, replay to any moment) and **replication** (ship the WAL to a replica and
replay it there — `08`'s mechanism is literally streaming this log). So WAL is the
hinge between durability, recovery, and replication; understand it once and three
chapters connect.

flattr's "swallow corruption, start empty" recovery is the right move for a cache
and exactly the *wrong* move for data — the difference is whether you can
re-derive. Your `AdvntrCue` Postgres gets WAL for free (it's on by default) and
its session memory survives a crash because of it; your `buffr` SQLite store uses
SQLite's WAL mode for the same reason. flattr is the one project in your portfolio
whose data is disposable enough to skip it — and recognizing *that's why* is the
signal.

## Interview defense

**Q: "What's flattr's durability story?"**

> One store: the elevCache. A `putElev` commits to an in-memory Map instantly,
> then a 4-second debounce coalesces writes into one whole-blob `setItem` to
> AsyncStorage (`elevCache.ts:53`). So there's a durability window — up to 4
> seconds of writes are lost on a crash. That's acceptable because the data is
> just cached elevations that get re-fetched. Recovery is re-reading the blob on
> startup, swallowing corruption and starting empty. No WAL, because nothing in
> the window is non-re-derivable.

```
  putElev → Map (gap: up to 4s) → setItem → disk
  recovery = re-read blob; corruption → empty (cache, so fine)
```

Anchor: *durability is a window; flattr made it 4 seconds wide because the only
thing in it is re-derivable cache data.*

**Q: "When would flattr need a WAL?"**

> The instant it stores user-authored, non-re-derivable data — saved routes, sync
> state. Then losing the 4-second window is real data loss, and I'd either write
> synchronously or move to an engine with a WAL. The WAL also unlocks point-in-
> time recovery and replication, since both are just replaying the log elsewhere.

Anchor: *you need a WAL when the data in the durability window can't be
reconstructed — re-derivable cache doesn't qualify; user-authored data does.*

## See also

- `02-records-pages-and-storage-layout.md` — whole-blob writes and torn-page avoidance
- `05-transactions-isolation-and-anomalies.md` — the D in ACID
- `06-locks-mvcc-and-concurrency-control.md` — the dirty-flag-across-await reasoning
- `08-replication-and-read-consistency.md` — replication as WAL shipping
- `09-database-systems-red-flags-audit.md` — the durability gap and missing schema version
- `../study-runtime-systems/` — debounce, timers, the event loop
