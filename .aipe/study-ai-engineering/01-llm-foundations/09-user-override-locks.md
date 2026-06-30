# User override locks

**Industry name(s):** user-override locks / `_overridden_at` flags /
human-edit precedence / the "don't clobber my edit" pattern. **Type:**
Industry standard state-precedence discipline.

## Zoom out — where this would sit in flattr

When an LLM (or any automated process) writes to a field a human can also
edit, you need a rule for who wins. The standard move: stamp a field with
`_overridden_at` when a human sets it, and make automated re-runs *skip*
fields the human touched. flattr has **no LLM**, so no auto-write races
exist today. But it already has the exact kind of field this protects:
`userMax`, the grade ceiling the user sets by hand with `GradeSlider`
(`MapScreen.tsx:56`, `:381`). If a future NL-parse ("flatter route") sets
`maxGrade`, it must **not** silently overwrite a `userMax` the user dialed
in. That is this pattern's natural flattr home.

```
  Zoom out — the user-set knob an NL-parse must not clobber

  ┌─ UI state (MapScreen.tsx) ──────────────────────────────┐
  │ const [userMax, setUserMax] = useState(DEFAULT_USERMAX)  │ :56
  │ <GradeSlider userMax onChange={setUserMax} />            │ :381
  │        ▲ HUMAN sets this by hand                         │
  └────────┼─────────────────────────────────────────────────┘
           │ feeds directedAstar / routeSummary (:155, :159)
  ┌─ ★ would-be NL parse (NOT BUILT) ───────────────────────┐
  │ "flatter route" ─► {maxGrade: 6} ─► setUserMax(6) ???    │
  │   ✗ must NOT overwrite a userMax the human just set      │
  │   ✓ honor an override lock on userMax                    │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no override lock** because nothing writes `userMax` except the
slider. The lesson: the instant an LLM can also write that field, add the
lock so the human's hand-set value wins.

## Structure pass

- **Layers:** human input (GradeSlider) → `userMax` state → router/summary
  consumers.
- **Axis — write authority:** today only the human writes `userMax`
  (single writer, no conflict). Add an NL-parse and you have *two* writers
  — human and model — racing for one field. The axis is "who is allowed to
  write, and who wins on conflict."
- **Seam:** the conflict point is `setUserMax` (`MapScreen.tsx:56`). Today
  only `GradeSlider` calls it (`:381`). A parse chain calling it too is
  where the lock must sit — model writes only if the human hasn't
  overridden.

## How it works

### Move 1 — the mental model

You know optimistic-UI reconciliation: a server refetch shouldn't stomp a
field the user is editing. Override locks are that rule made explicit —
mark human-set fields, and any automated writer checks the mark before
writing. Last-write-wins is the bug; human-wins-on-override is the fix.

```
  Pattern — automated writer yields to a human override

  human sets field ─► stamp userMaxOverridden = true
                              │
  automated re-run ─► wants to write field
                              │ check the stamp
                  ┌───────────┴───────────┐
            overridden?                 not overridden?
                  │                          │
            SKIP (human wins)          write (safe)
```

### Move 2 — the walkthrough

**flattr's `userMax` is already a hand-set knob.** `MapScreen.tsx:56` and
`:381`:

```ts
const [userMax, setUserMax] = useState(DEFAULT_USERMAX);   // :56
// ...
<GradeSlider userMax={userMax} onChange={setUserMax} />     // :381  ← only writer today
```

One writer, no conflict. The slider is the human's voice; `userMax` flows
into `directedAstar` (`:155`) and `routeSummary` (`:159`). Today nothing
contests it.

```
  Layers-and-hops — single writer today, two writers tomorrow

  TODAY:   GradeSlider ─► setUserMax ─► userMax ─► router
                          (one writer — no lock needed)

  WITH NL PARSE (NOT BUILT):
  GradeSlider ─┐
               ├─► setUserMax  ◄── conflict point (MapScreen.tsx:56)
  NL parse  ───┘     │ needs an override lock here
                     ▼
                  userMax ─► router
```

**Where the lock attaches.** Add `userMaxOverridden` (set true in the
slider's `onChange`). When the NL-parse resolves `{maxGrade}`, it calls a
guarded setter: write `userMax` only if `!userMaxOverridden`. So "flatter
route" can *suggest* a ceiling, but a value the user set on the slider
stands. The human's deliberate choice outranks the model's inference.

**Why this specifically matters for an LLM writer.** The parse is fuzzy and
non-deterministic ([05-streaming.md](05-streaming.md) — await the whole
filter first). If it silently set `userMax`, a user who carefully picked
"Kick scooter, 5%" could watch the model bump it to 6% and route over a
hill they meant to avoid. Override locks turn a silent stomp into a
respected boundary.

### Move 3 — the principle

When a human and an automated process can write the same field, stamp
human edits and make the automation yield. flattr's `userMax` is the field;
`setUserMax` (`MapScreen.tsx:56`) is the conflict point; the lock is the
guard a future NL-parse must pass. The human's hand-set value wins.

## Primary diagram

```
  User override locks — protecting userMax from a future NL-parse

  ┌─ human ─────────────────────────────────────────────────┐
  │ GradeSlider.onChange ─► setUserMax(v); overridden = true │ :381,:56
  └────────────────────────────┬─────────────────────────────┘
                            userMax state
  ┌─ NL parse (NOT BUILT) ─────▼─────────────────────────────┐
  │ {maxGrade} ─► if (!overridden) setUserMax(maxGrade)       │
  │            else SKIP — human's slider value wins          │
  └────────────────────────────┬─────────────────────────────┘
                            router / summary  (:155, :159)
```

## Elaborate

The general shape in CRUD systems: an `_overridden_at` timestamp (not just
a bool) lets you decide *staleness* — a human edit older than the latest
authoritative data might be re-synced, a recent one is protected. In a UI
like flattr a boolean per protected field is usually enough. The trap is
implicit last-write-wins: it works until two writers exist, then silently
destroys user intent. The fix is cheap if added *with* the second writer;
expensive to retrofit after users complain their settings "reset
themselves." flattr's contrl/dryrun work has the same human-vs-automation
precedence concern.

## Project exercises

### B-OL.1 — stamp the slider edit

- **Exercise ID:** B-OL.1
- **What to build:** add a `userMaxOverridden` flag set true in
  `GradeSlider`'s `onChange`, threaded through `MapScreen` state, with no
  behavior change today (single writer) — just the stamp.
- **Why it earns its place:** it lays the lock's foundation at the real
  field before the second writer exists.
- **Files to touch:** `mobile/src/MapScreen.tsx:56` (state),
  `:381` (GradeSlider onChange); `mobile/src/GradeSlider.tsx`.
- **Done when:** the flag flips on slider use; existing routing unchanged.
- **Estimated effort:** 1 hr.

### B-OL.2 — guarded setter for a parse

- **Exercise ID:** B-OL.2
- **What to build:** a `setUserMaxFromModel(v)` that writes only when
  `!userMaxOverridden`, plus a test proving a model write is skipped after
  a human slider edit.
- **Why it earns its place:** it implements human-wins-on-override at the
  exact conflict point a future NL-parse would hit.
- **Files to touch:** `mobile/src/MapScreen.tsx:56` (setter + flag);
  a test for the precedence.
- **Done when:** model write is skipped post-override; test passes.
- **Estimated effort:** 1–2 hrs.

## Interview defense

**Q: If an LLM could set the grade ceiling, how do you stop it stomping the
user's choice?** Answer: An override lock. `userMax` is already a hand-set
knob (`GradeSlider` → `setUserMax`, `MapScreen.tsx:56`/`:381`). I'd stamp a
`userMaxOverridden` flag when the human moves the slider, and route any
model write through a guarded setter that skips when the flag is set. So an
NL-parse can suggest a ceiling, but a value the user dialed in wins — no
silent reset.

```
  human slider → setUserMax + overridden=true
  model parse  → write only if !overridden  (else skip)
```

Anchor: *"userMax is the user's hand-set knob at MapScreen.tsx:56; a future
NL-parse must pass an override lock before it can write it."*

## See also

- [05-streaming.md](05-streaming.md) — await the parse before any write.
- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — the parse seam this protects.
- [04-structured-outputs.md](04-structured-outputs.md) — the typed filter the parse returns.
