# Transactions, isolation, and anomalies

**Industry name(s):** ACID transactions / isolation levels / read anomalies ·
**Type:** Industry standard — **`not yet exercised` in this repo.** There is no
runtime write path, so there is nothing to make atomic and nothing to isolate.

## Zoom out, then zoom in

The honest verdict up front: **this repo has zero transactions, and that's
correct.** A transaction groups writes so they commit all-or-nothing and don't
interleave badly with other writes. flattr writes its data exactly once, offline,
in a single process, with no concurrent writer — so there's no group to make
atomic and no interleaving to prevent. This file teaches the concept by marking
where it would attach *if* a write path existed.

```
  Zoom out — where a transaction boundary WOULD live (it doesn't)

  ┌─ Build layer (the only writer) ──────────────────────────────────┐
  │  buildGraph() assembles the whole Graph in memory, then           │
  │  JSON.stringify → writeFileSync  ◄── the closest thing to a       │
  │                                       "transaction": one atomic    │
  │                                       file write, all-or-nothing   │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ Runtime layer ───────────▼──────────────────────────────────────┐
  │  reads only · NO writes · ✗ no transactions, no isolation ✗       │
  │  (a future "edit this edge" feature would put a txn boundary here)│
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"when multiple writes must succeed together or not at
all, how does the store guarantee it?"* flattr's answer is "the situation never
arises at runtime." The one place anything atomic-ish happens is the build's
single `writeFileSync` — which is all-or-nothing only in the loose sense that a
half-written JSON file would fail to parse and the old artifact stays in place.

## The structure pass

**Layers.** One writer (build), one reader (runtime). The transaction concept
only has meaning where there are writes; here that's exclusively the build layer.

**The axis: guarantees — what is promised about a write completing?** Trace it,
and notice the runtime layer has nothing to promise because it never writes:

```
  Axis = "what's guaranteed when a write happens?"

  ┌─ Build layer ─────────────────────────────────┐
  │  one writeFileSync of the whole graph          │  → file appears whole or
  │                                                 │    the build errors out
  └───────────────────────────┬─────────────────────┘
        seam: build ends, runtime begins  ═══════╪═══
  ┌─ Runtime layer ───────────▼─────────────────────┐
  │  no writes                                       │  → nothing to guarantee
  └───────────────────────────────────────────────────┘
```

**Seams.** There's no transaction seam because there's no concurrent-write
boundary. The would-be seam — "a runtime mutation that must commit atomically" —
is absent. Marking that absence precisely is the lesson: you can't have an
isolation anomaly without two transactions, and flattr never has two.

## How it works

### Move 1 — the mental model

You know optimistic UI updates: you mutate local state, fire the request, and
roll back if it fails. A transaction is the server-side version of that
all-or-nothing guarantee. flattr has neither side — it never mutates persistent
state at runtime, so there's no commit and nothing to roll back.

```
  The pattern — a transaction is a write group with an all-or-nothing boundary

  BEGIN ─► write A ─► write B ─► write C ─► COMMIT   (all) or ROLLBACK (none)
                                              │
                                              └─ flattr has NONE of this at
                                                 runtime: no BEGIN, no writes,
                                                 no COMMIT
```

### Move 2 — what's actually here, and what's absent

#### The only atomic-ish operation: the build's file write

`writeFileSync(path, JSON.stringify(graph))` is the closest analog to a commit.
It's atomic in a weak sense: the build holds the entire graph in memory and
writes it in one call, so a reader never sees a half-built graph *structure* —
either the build finishes and writes a complete file, or it throws and writes
nothing. There's no multi-statement transaction because there's only one write.

```
  Build "commit" — single write, weak atomicity

  assemble whole Graph in RAM ──► JSON.stringify ──► writeFileSync (one call)
       │                                                   │
       │                                                   └─ crash mid-write
       │                                                      leaves a corrupt
       └─ no partial graph is ever written: it's all in memory first             file, NOT a
                                                                                  partial graph
```

Note the gap: `writeFileSync` is *not* a true atomic file replace. A crash mid-
write corrupts `graph.json`. A real atomic-write pattern (write to temp + rename)
would fix that — it's a latent durability nit, covered in file `07`.

#### Why isolation levels are meaningless here

Isolation levels (read-committed, repeatable-read, serializable) describe how
concurrent transactions see each other's writes. With one writer and no
concurrent transactions, every isolation level collapses to the same thing:
there's nothing to be isolated *from*. The classic anomalies — dirty read,
non-repeatable read, phantom, write skew — all require a second transaction
writing while yours reads. flattr never has a second writer.

```
  Anomalies need TWO transactions — flattr has at most ONE

  dirty read:        T2 reads T1's uncommitted write   → needs T1 AND T2
  non-repeatable:    T1 reads X twice, T2 changed it    → needs T1 AND T2
  phantom:           T1's range query, T2 inserts a row → needs T1 AND T2
  flattr: at most one writer, ever  → ZERO of these can occur
```

#### Move 2.5 — current vs future state

The whole concept activates the day flattr gains a write path:

```
  Phase A (now): no transactions       Phase B (user edits an edge)

  data written once, offline           edits written at runtime, concurrently
  one writer, no concurrency           multiple users editing same area
  isolation: N/A                       must pick an isolation level
  anomalies: impossible                dirty/non-repeatable reads now possible
  rollback: N/A                        a failed edit must not corrupt the graph
```

The first real write feature — "report this sidewalk closed" — is what forces
the first transaction. You'd group "mark edge blocked" + "log the report" + "bump
a version" and need them to commit together. That's where you'd reach for SQLite
(`BEGIN`/`COMMIT`) or Postgres, and where isolation level becomes a real choice.

### Move 3 — the principle

**Transactions are the price of concurrent writes; no writes, no price.** flattr
pays nothing because it confines all writes to a single offline build. The
general lesson: don't reach for transactional machinery before you have
concurrent writes to coordinate — and conversely, the moment you add the first
runtime write to shared state, the transaction question is no longer optional.

## Primary diagram

The full picture: one writer, the weak commit, the absent runtime transactions.

```
  flattr transactions — what exists vs what's absent

  ┌─ BUILD (the only writer) ────────────────────────────────────────┐
  │  buildGraph → whole Graph in RAM → writeFileSync (one call)       │
  │      ≈ a weak "commit": all-or-error, but NOT crash-atomic        │
  │        (no temp+rename; crash mid-write corrupts the file → f.07) │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ RUNTIME ─────────────────▼──────────────────────────────────────┐
  │  ✗ no BEGIN/COMMIT/ROLLBACK   ✗ no isolation levels               │
  │  ✗ no dirty/non-repeatable/phantom reads (need a 2nd writer)      │
  │                                                                   │
  │  [Phase B] user-edit feature → first real transaction lands here  │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** None at runtime — that's the finding. The only write is the build,
run by a developer via `npm run build:graph`, once per data refresh.

**The only write in the data path — `pipeline/run-build.ts` (lines 10-13):**

```
  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));   ← the entire "transaction":
  }                                                 one synchronous write of the
                                                    whole graph. No BEGIN, no
                                                    COMMIT — there's one statement.
       │
       └─ this is the ONLY persistent write anywhere in flattr. Grep the runtime
          (features/, mobile/src/) for writeFileSync or any persistence call —
          there are none. That absence IS the transaction story.
```

**The runtime "writes" that never persist — `features/routing/astar.ts` (lines 44, 70-72):**

```
  g.set(startId, 0);                       ← writes to IN-MEMORY maps (g, came,
  ...                                        closed) during search...
  g.set(next, tentative);
  came.set(next, { edge, prev: current });
       │
       └─ these are mutations, but to transient per-search state, never to the
          store. They vanish when search() returns. No durability, no isolation
          needed — they're local variables, not persisted rows.
```

## Elaborate

ACID is the foundation of stateful databases, and the temptation in a study guide
is to teach it whether or not the repo uses it. The disciplined answer is to teach
*where it would attach* and *what triggers it* — which is exactly the first
runtime write to shared state. flattr's design deliberately avoids that write, so
the honest label is `not yet exercised`.

The one transferable insight from what *is* here: the build's single
`writeFileSync` shows the cheapest possible "atomicity" — collect everything in
memory, write once. It's the same instinct behind copy-on-write and immutable
deploys: never expose a partial state by never writing a partial state. flattr
gets 80% of atomicity's benefit from that one habit, and the missing 20% (crash-
atomicity via temp+rename) is the small gap file `07` names.

What to read next: `06` — concurrency control, which is `not yet exercised` for
the same root reason (no concurrent writers).

## Interview defense

**Q: "How does this codebase handle transactions and isolation?"**

> It doesn't, and that's the right call — there's no runtime write path, so
> there's nothing to make atomic and nothing to isolate. The only write in the
> entire data path is the build's `writeFileSync` of the whole graph, which is a
> weak one-call "commit." Isolation levels and read anomalies are meaningless
> here because they all require a second concurrent transaction, and flattr never
> has even a first one at runtime. The concept activates the day users can edit
> the graph — that's when the first real `BEGIN`/`COMMIT` shows up.

```
  one writer, offline, one write  →  no txns needed  →  no anomalies possible
```

Anchor: *anomalies need two transactions; flattr has at most one, offline.*

**Q: "Is the build write atomic?"**

> Weakly. It assembles the whole graph in memory then writes in one call, so a
> reader never sees a partial graph *structure*. But it's a plain `writeFileSync`,
> not a temp-file-plus-rename, so a crash mid-write corrupts the file. The fix is
> a one-line atomic-write pattern — covered as a durability nit in file 07.

```
  whole-graph-in-RAM-then-one-write  ✓ no partial structure
  plain writeFileSync                ✗ not crash-atomic → temp+rename fixes it
```

Anchor: *atomic in structure, not crash-atomic — temp+rename closes the gap.*

## Validate

1. **Reconstruct:** explain why isolation levels are meaningless in flattr using
   the "anomalies need two transactions" argument.
2. **Explain:** which line is the closest thing to a commit, and in what weak
   sense is it atomic? (`pipeline/run-build.ts:12`.)
3. **Apply:** design the first transaction for a "report sidewalk closed" feature.
   What writes get grouped, and where does the txn boundary go?
4. **Defend:** someone says "you have no ACID guarantees, that's a bug." Explain
   why it's a correct design choice given the absence of runtime writes
   (`run-build.ts:12` is the only write; `astar.ts` mutations are transient).

## See also

- `06-locks-mvcc-and-concurrency-control.md` — also `not yet exercised`, same root cause
- `07-wal-durability-and-recovery.md` — the build write's crash-atomicity gap
- `01-database-systems-map.md` — the immutability that deletes the transaction problem
