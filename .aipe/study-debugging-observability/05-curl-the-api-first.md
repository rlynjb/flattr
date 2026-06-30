# Curl-the-API-first

**Industry names:** isolate-the-boundary · bisect the request path · dependency
health check before code debugging · external-dependency triage. **Type:**
Project-specific discipline (an industry-standard debugging habit, codified
here).

## Zoom out, then zoom in

When grades come back wrong, the bug is in one of two places: your pipeline, or
the external API your pipeline depends on. The discipline says: **probe the API
directly before you touch your own code**, because a throttled API produces a bug
that *looks exactly like* a pipeline bug — and you can waste an afternoon in the
wrong file.

```
  Zoom out — where the probe sits

  ┌─ Your code (the suspect) ──────────────────────────────────┐
  │  pipeline: split → sampleElevations → grade → buildGraph   │
  │  mobile:   useTileGraph → bestEffortElevation → flat        │
  └─────────────────────────────┬───────────────────────────────┘
                                │  the network seam
  ┌─ External dependency (probe THIS first) ────────────────────┐
  │  curl 'https://api.open-meteo.com/v1/elevation?…'  ★        │ ← the discipline
  │  → 200 with data? bug is yours.  429? bug is the quota.    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **bisect the request path at the boundary you don't
own.** Before debugging your transform, confirm the input to that transform is
good. A `curl` to Open-Meteo is one command that tells you which side of the
network seam the failure is on — and it's documented as standing operational
discipline (`.aipe/project/context.md`, user memory) precisely because this team
already got burned by skipping it (the "all grades green" incident).

## Structure pass

**Layers.** Your pipeline (owned, mutable) vs the external API (unowned, opaque).
Two, split by the network seam.

**Axis — trace "who can I change to fix this?" across the seam:**

```
  One axis: control — across the network seam

  your pipeline   →  YOU can change it (edit, redeploy, retry)
  ─────────── seam: the curl probe lives here ──────────────
  external API    →  you CANNOT change it; you can only observe it

  debugging effort spent below the seam is wasted if the
  failure is above it — so PROBE the seam before editing below
```

**Seam.** The network call *is* the seam — `fetchImpl(url)` in `openMeteoProvider`
(`elevation.ts:109`). The control axis flips hard there: everything on your side
is editable, everything past it is a black box that can throttle you without
warning. The `curl` is a manual tap on that exact seam. It answers the one
question that determines where to spend the next hour: is the input good
(debug your code) or bad (wait out the quota / get a key)?

## How it works

### Move 1 — the mental model

You've done this with a flaky API in the browser: before debugging your fetch
wrapper, you paste the URL into the address bar or hit it in Postman to see if
the *server* is even returning what you expect. `curl` is that move for a build
pipeline.

```
  Pattern — bisect the request path at the boundary

   wrong grades observed
            │
            ▼
   ┌──────────────────┐
   │ curl the API     │  ← test the boundary you DON'T own, first
   │ directly         │
   └────────┬─────────┘
       ┌────┴─────┐
       │          │
   200 + data   429 / error
       │          │
       ▼          ▼
   bug is      bug is the quota — not your code.
   YOURS.      wait / add key / reduce request volume.
   Now debug   (editing the pipeline fixes nothing.)
   split/grade.
```

The strategy in one sentence: **before debugging a transform, prove its input is
good by probing the source directly — bisect the request path at the boundary you
can't change.**

### Move 2 — the walkthrough

**The documented discipline.** It's written down in two places — this is a
*codified* habit, not folklore.

```
  .aipe/project/context.md (External-data caveat):
  "Open-Meteo free elevation API 429s when quota is exhausted by heavy
   testing — check `curl` before debugging the pipeline (user memory)."
```

That sentence is the runbook. It names the exact failure (429 from quota), the
exact trigger (heavy testing), and the exact first step (curl, not code).

**Why the failure masquerades as a pipeline bug.** Trace what a 429 does to your
own code. In `openMeteoProvider`, a 429 past the retry budget throws
(`elevation.ts:114-118`). At build time that throw aborts the build
(`run-build.ts:54`). At runtime `bestEffortElevation` catches it and returns flat
0 m (`useTileGraph.ts:20-31`). So the *symptom* you observe is "all grades are
0/green" — which looks *identical* to a bug in `grade.ts` computing grades wrong,
or `split.ts` producing degenerate edges. The real cause is upstream of all of
them, past the seam.

```
  Layers-and-hops — why a 429 looks like a grade bug

  ┌─ Open-Meteo ─┐ 429      ┌─ openMeteoProvider ─┐
  │ (quota out)  │ ───────► │ throws after retries│
  └──────────────┘          └─────────┬───────────┘
                              hop 2 │ throw
                  ┌─────────────────┴──────────────────┐
                  ▼ (build time)            ▼ (runtime)
        ┌─ run-build.ts ──┐       ┌─ bestEffortElevation ─┐
        │ build aborts    │       │ catch → flat 0m       │
        └─────────────────┘       └──────────┬────────────┘
                                    hop 3 │ all grades = 0
                                          ▼
                              "all grades green" — LOOKS like
                              grade.ts / split.ts bug. IT ISN'T.
```

The curl short-circuits this entire diagnostic detour: one command tells you the
input was bad, so none of `grade.ts`, `split.ts`, or `build-graph.ts` is worth
opening.

**The probe is reproducible by construction.** The URL the code builds is plain
and inspectable (`elevation.ts:106`):

```ts
// features/.../elevation.ts:106
const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
```

You can copy that exact shape into a terminal:

```
  curl -s 'https://api.open-meteo.com/v1/elevation?latitude=47.6&longitude=-122.3'
  → 200 {"elevation":[56.0]}   → API healthy; the bug is yours.
  → 429 ...                     → quota exhausted; wait or add a key.
```

Because the provider takes an injectable `fetchImpl` (`elevation.ts:65, 92`), the
curl and the code hit the *same* endpoint the same way — the probe faithfully
reproduces the code's request. That injectability is also what makes the in-code
path testable; the curl is the manual counterpart for the live API.

**The compensation for discarded error detail.** Recall from `03-` that
`bestEffortElevation` catches the 429 and throws away the status code — it keeps
only a `degraded` boolean. The curl-first habit *is* the compensation for that
information loss. Because the code doesn't persist the status, the human re-fetches
it manually. That's the honest read: the system instruments the *fact* of failure
in-band (the flag) but not the *detail* (status, body, rate-limit headers) — so
the detail has to be recovered out-of-band, by hand.

### Move 2 variant — the load-bearing skeleton

The kernel: **probe the unowned boundary directly + branch your debugging on the
result + before editing owned code.** Three parts.

- Drop the **probe-first ordering** and you debug your own code on a bad input —
  the classic time-sink. You'll "fix" `grade.ts`, see grades still green
  (because the input is still 0), and conclude your fix was wrong. The ordering
  is the whole discipline.
- Drop the **direct probe** (infer API health from your app's behavior) and you
  can't distinguish "API down" from "my request malformed" from "my parsing
  wrong" — three causes, one symptom. The curl isolates the API in isolation.
- Drop the **branch** (probe but ignore the result) and the probe is theater.
  200 means go debug your code; 429 means stop and wait. The branch is what makes
  the probe actionable.

Optional hardening: persisting the status code in the catch (`useTileGraph.ts:219`
currently bare) would make the in-code path carry the detail and *reduce* the need
for the manual curl. That's the upgrade — the skeleton is the human discipline;
in-band error capture is what would automate it.

### Move 3 — the principle

**Bisect at the boundary you don't own, first.** When a symptom could originate
on either side of a dependency you can't change, the highest-leverage first move
is to test that dependency in isolation — because all the debugging effort you'd
spend on your own (editable) code is wasted if the failure is on the (uneditable)
other side. The general rule: a failure that crosses a boundary should be
attributed to a side *before* you start editing either one, and the cheapest way
to attribute it is to exercise the boundary directly. `curl` is just the tool;
the discipline is "isolate the unowned dependency before suspecting your own
code."

## Primary diagram

The full discipline — the probe, the branch, and what it saves you from.

```
  Curl-the-API-first — the full discipline

  symptom: "all grades green / 0" observed
              │
              ▼
  ┌─ STEP 1: probe the unowned boundary ───────────────────────┐
  │  curl 'https://api.open-meteo.com/v1/elevation?…'          │
  └────────────────────────────┬───────────────────────────────┘
              ┌─────────────────┴─────────────────┐
              ▼ 200 + data                        ▼ 429
  ┌─ bug is YOURS ──────────────┐   ┌─ bug is the QUOTA ───────────┐
  │ NOW open grade.ts /         │   │ stop. wait out the limit,    │
  │ split.ts / build-graph.ts   │   │ add GOOGLE_ELEVATION_KEY, or │
  │ — input was good            │   │ reduce request volume.       │
  └─────────────────────────────┘   │ editing pipeline fixes nada. │
                                     └──────────────────────────────┘
  documented in: .aipe/project/context.md · user memory
  compensates for: discarded 429 status in bestEffortElevation (03-)
```

## Elaborate

This is the human-process layer of observability — the part that lives in a
runbook, not in code. It's the classic "is it me or is it them?" triage every
engineer learns the hard way with a flaky upstream. What makes it worth a pattern
file here is that flattr *codified* it: the curl-first step is written into the
project context and user memory as standing discipline, born from a real incident
(the "all grades green" bug, `audit.md` lens 7). That's the difference between a
habit and a runbook — this one is documented, with the exact failure (429), exact
cause (quota), and exact first action.

It also exposes the repo's one structural observability gap precisely: the system
captures *that* elevation failed (the `degraded` flag, `03-`) but not *why* (the
status, the rate-limit headers). The curl recovers the "why" manually. The
clean upgrade path — persist the status in the catch — is named in `audit.md` lens
8 as the highest-consequence red flag (errors swallowed by bare `catch {}`).
Cross the network mechanics (what a 429 *is*, backoff, retry budgets) to
`study-networking`; this file owns only the debugging discipline around it.

## Interview defense

**Q: Grades come back all-flat in your pipeline. Walk me through your first move.**

I curl the elevation API directly before touching any of my code. A throttled
Open-Meteo (429) produces all-zero elevation, which looks identical to a bug in my
grade computation or edge splitting — same symptom, completely different cause. The
curl tells me which side of the network seam I'm on: 200 with data means the bug is
mine and I go open `grade.ts`; 429 means the quota's exhausted and editing my code
fixes nothing. It's documented as standing discipline in the project context because
we already lost time to it once.

```
  curl → 200? bug is yours (debug code)
       → 429? bug is the quota (wait / add key) — don't touch the pipeline
```

Anchor: *probe the boundary you don't own before editing the code you do — a
throttled dependency masquerades as your bug.*

**Q: Why isn't this just automated — why a manual curl?**

Because the code throws away the failure detail. `bestEffortElevation` catches the
429 and keeps only a `degraded` boolean — it discards the status code (`03-`). So
the "why" isn't persisted anywhere, and the curl is how I recover it by hand. The
real fix is to capture the status in the catch — that's the highest-consequence
gap in the audit (bare `catch {}` swallowing errors). Until then, the manual probe
is the compensation.

Anchor: *the curl exists because the error detail isn't instrumented — it's a
human stand-in for the structured error capture the runtime doesn't have yet.*

## See also

- `03-degrade-and-surface.md` — the catch that discards the status this probe
  recovers.
- `audit.md` lens 2 (reproduction), lens 7 (the incident), lens 8 (swallowed
  errors red flag).
- `00-overview.md` — the evidence map showing what's `not yet exercised`.
- Neighbor guide `study-networking` — the 429/backoff/retry transport mechanics.
