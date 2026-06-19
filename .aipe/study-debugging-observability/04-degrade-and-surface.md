# Degrade and surface

> **Industry names:** graceful degradation / fail-open / fallback +
> progress reporting / error-state surfacing. **Type:**
> Language-agnostic (the degrade-vs-fail and progress-vs-error
> patterns), applied to a mobile app over flaky free APIs.

---

## Zoom out, then zoom in

Every `fetch()` you've shipped had to answer: when the network is slow
or down, do I crash, hang, or show something useful? flattr's mobile
graph-build pipeline answers that three ways at once — it *degrades*
(builds with flat elevation when the elevation API throttles), it
*reports progress* (a `loadingStep` string), and it *surfaces user
errors* (a `routeError` string). This file is about how runtime failure
becomes visible — and the one place it's deliberately invisible.

Here's where these surfaces sit.

```
  Zoom out — failure-visibility surfaces in the app

  ┌─ UI layer (Expo) ──────────────────────────────────────────────┐
  │  MapScreen.tsx                                                  │
  │    routeError  "From not found" / "Lookup failed"  ← USER ERROR │ ← here
  │    "Failed to load graph."                         ← fatal      │
  │  useTileGraph: loadingStep "Fetching streets"      ← PROGRESS   │
  └────────────────────────────┬─────────────────────────────────────┘
                               │ drives the build
  ┌─ Build/network layer ──────▼─────────────────────────────────────┐
  │  useTileGraph.pump()  fetchOverpass → elevation → buildGraph     │
  │    bestEffortElevation: catch → 0m            ← SILENT DEGRADE ⚠ │
  │    catch {} keep last region                  ← SILENT RETRY     │
  │  pipeline/overpass.ts / elevation.ts: 429 retry w/ backoff       │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: there are two distinct patterns braided together here.
**Fail-open degradation** — when a non-essential signal (elevation)
fails, keep going with a worse-but-usable value rather than failing the
whole operation. And **state surfacing** — turn the *expected* failures
(address not found, no GPS) into specific UI strings the user can act on.
The tension between them is the lesson: flattr surfaces *user* errors
loudly and degrades *infrastructure* failures silently — and the silent
half is the audit's top blind spot.

---

## Structure pass

Three layers, one axis, one seam that's also a bug.

**Layers:** the **fetch layer** (Overpass/Open-Meteo with retry), the
**build orchestrator** (`useTileGraph.pump`), and the **UI** (`MapScreen`).

**Axis — "is this failure visible to the user?"** Trace it across the
failure types:

```
  One axis: "is this failure visible?" — across failure types

  failure type                  →  what the user sees
  ─────────────────────────────────────────────────────────
  address not geocodable        →  "From not found"     VISIBLE
  GPS unavailable               →  "Location unavailable" VISIBLE
  route span too wide           →  routeError set         VISIBLE
  graph asset won't load        →  "Failed to load graph" VISIBLE (fatal)
  ─────────────────────────────────────────────────────────
  elevation API throttled (429) →  flat route, GREEN card SILENT ⚠
  Overpass fetch fails on pan   →  stale map, no message  SILENT
  region-load transient error   →  nothing                SILENT
```

**The seam:** the `catch` blocks. Above them, failure is a typed
UI state (`routeError`, fatal screen). Below them — specifically in
`bestEffortElevation` and the region-load `catch {}` — failure is
*swallowed* and converted to a degraded-but-successful result. The axis
flips at the catch: user-facing inputs fail *loud*, infrastructure fails
*quiet*. That asymmetry is a deliberate availability call (a flat map
beats no map) with a missing observability half (no one's told it
degraded). It's `audit.md` RF-1, and it's the most interesting thing in
this file.

---

## How it works

### Move 1 — the mental model

Two shapes. First, **fail-open**: wrap the fragile call, and on failure
return a safe default instead of propagating. You've done this with
`try/catch` around a `JSON.parse` that falls back to `{}`. Second,
**state surfacing**: map each *expected* failure to a distinct value the
UI renders, so "didn't work" is never a blank screen.

```
  Pattern — degrade vs surface (the fork at the catch)

                  fragile operation
                        │
                    try ┤
                        ▼
              ┌─────────┴──────────┐
           success                fails
              │                     │
              ▼                catch ┤
          real value               ▼
                          ┌─────────┴──────────┐
                    DEGRADE (fail-open)    SURFACE (fail-loud)
                    return safe default    set a UI state string
                    e.g. elevation → 0m    e.g. "From not found"
                    user sees nothing      user sees + can act
```

The design question every catch answers: *is this input the user can
fix, or infrastructure they can't?* User-fixable → surface it. Infra →
degrade and (ideally) signal it. flattr does the first well and the
second only halfway.

### Move 2 — the step-by-step walkthrough

#### Retry with backoff at the fetch layer

Before anything degrades, the fetch layer tries to *not* fail — it
retries transient HTTP statuses with exponential backoff.

```
  Pattern — bounded retry with exponential backoff

  attempt = 0
  loop:
      res = fetch(url)
      if res.ok:  return body
      if res.status is retryable (429/502/503/504) and attempt < max:
          sleep(base * 2^attempt)    ← back off, give the server room
          attempt++;  continue
      throw Error(status)            ← bounded: give up after `max`
```

The boundary: retries are *bounded*. After `max` attempts it throws —
it doesn't loop forever on a server that's down hard. That throw is what
the next layer catches and decides to degrade on. Unbounded retry would
turn a throttle into a hang; the bound is what makes degradation
possible.

#### Fail-open elevation — degrade the non-essential signal

Elevation is the fragile, rate-limited dependency. But a map with
streets and *no grades* is still navigable; a map with no streets is
useless. So elevation failure must not fail the whole build.

```
  Layers-and-hops — elevation degrades, build survives

  ┌─ pump() ─────┐ hop 1: sample(points)   ┌─ bestEffortElevation ─┐
  │ build a tile │ ───────────────────────►│  try real provider    │
  │              │                          │    429 after retries? │
  │              │ hop 2a: real elevations  │    → throws           │
  │              │ ◄──────────────────────  │  catch → 0m for all   │
  │              │ hop 2b: all-0m (degraded)│  ← SILENT             │
  └──────┬───────┘ ◄──────────────────────  └───────────────────────┘
         │ either way, buildGraph proceeds → streets render,
         ▼ routing connects. grades just = 0 on this tile.
```

The cost, named plainly: a tile built with flat elevation has every
grade = 0, so the honesty card (`03-route-honesty-signal.md`) sees
`steepCount === 0` and shows GREEN "Flat all the way" — for a route
whose real grades are unknown. The degrade is correct (connectivity
beats fidelity); the *silence* is the bug. There's no flag threaded out
to say "these grades are degraded." That's RF-1.

#### Progress reporting — make the slow path visible

A graph build is several network round-trips; without a signal the
screen looks frozen. `loadingStep` is a single string the orchestrator
sets as it moves through phases, rendered in the UI.

```
  State — loadingStep through a build

  null ──pump starts──► "Fetching streets"
       ──buildGraph────► (steps set via setLoadingStep callback)
       ──finally───────► null   (always cleared, even on failure)
```

The boundary that matters: `loadingStep` is cleared in a `finally`, so a
*failed* build doesn't leave a stuck "Fetching…" spinner. Forgetting the
finally is the classic progress-indicator bug — the spinner that never
stops.

#### Error surfacing — typed user states

The geocode/route path maps each expected failure to a specific
`routeError` string, cleared at the start of each attempt.

```
  State machine — routeError lifecycle

  (attempt starts) ──► routeError = null   (clear stale error)
        │
        ├─ "From not found"        (geocode From failed)
        ├─ "To not found"          (geocode To failed)
        ├─ "Location unavailable"  (GPS failed)
        ├─ "Lookup failed — try again"  (network threw)
        │
  (success) ──► routeError stays null → card shows the route
```

Each string is *actionable* — the user knows whether to fix the address,
enable GPS, or retry. Compare a single generic "Error" — useless. The
specificity is the observability.

### Move 2 variant — the load-bearing skeleton

The kernel of "degrade and surface," by what-breaks-if-removed:

1. **Bounded retry at the fetch.** *Remove the bound and a throttle
   becomes an infinite hang — degradation can never trigger because the
   call never returns.*
2. **A fail-open wrapper on the non-essential signal**
   (`bestEffortElevation`). *Remove it and one 429 fails the entire
   tile build — the map goes blank over a free-tier rate limit.*
3. **Progress cleared in `finally`.** *Remove the finally and a failed
   build leaves a permanent spinner — the UI lies about being busy.*
4. **Typed, actionable error states.** *Collapse them to one generic
   error and the user can't tell a fixable input from a dead network.*

Missing from the skeleton (and that's the finding): **a degraded-state
signal.** The fail-open at part 2 has no counterpart that says "I
degraded." Adding it is the single highest-leverage fix in the whole
guide (RF-1).

### Move 3 — the principle

Decide *per failure* whether the user can act on it. Inputs they control
(addresses, GPS) should fail loud and specific; infrastructure they
can't (a throttled free API) should fail open to a usable default — *but
the degrade must still emit a signal*, or you've traded a visible
failure for an invisible wrong answer. flattr nails the first half and
half-finishes the second: degradation without a signal is how a flat
fallback becomes a confident lie on the honesty card.

---

## Primary diagram

The full failure-handling surface, fetch to screen.

```
  Degrade and surface — complete failure-handling map

  ┌─ Fetch layer: pipeline/overpass.ts, elevation.ts ──────────────┐
  │  fetch(url)                                                    │
  │   ok → body                                                   │
  │   429/502/503/504 & attempt<max → sleep(base*2^attempt),retry │
  │   else → throw Error(status)            ← BOUNDED give-up      │
  └────────────────────────────┬───────────────────────────────────┘
                               │ throws on hard failure
  ┌─ Orchestrator: mobile/src/useTileGraph.ts (pump) ──────────────▼┐
  │  setLoadingStep("Fetching streets")     ── PROGRESS (visible)   │
  │  bestEffortElevation: try sample() catch → 0m ── DEGRADE(SILENT)│
  │  outer catch {} keep last region        ── SILENT RETRY-LATER   │
  │  finally: setLoadingStep(null)           ── clear, even on fail │
  └────────────────────────────┬───────────────────────────────────┘
                               │ graph (possibly grade-degraded)
  ┌─ UI layer: mobile/src/MapScreen.tsx ───────────────────────────▼┐
  │  !graph || !heatmap     → "Failed to load graph."  (fatal)     │
  │  geocode From fails     → routeError "From not found"          │
  │  geocode To fails       → routeError "To not found"            │
  │  GPS fails              → routeError "Location unavailable"     │
  │  network throws         → routeError "Lookup failed — try again"│
  │   └─ user-facing inputs FAIL LOUD; infra FAILS QUIET (RF-1)    │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

This surface is exercised constantly because the app runs on **free,
rate-limited APIs** (Overpass for streets, Open-Meteo for elevation,
Nominatim for geocoding). Concrete triggers:

- **Open-Meteo 429s mid-pan** (the documented quota hazard in project
  memory) → `bestEffortElevation` returns 0m, the tile builds flat,
  streets still render. The user keeps navigating; grades fill in on a
  later load when the quota recovers.
- **User types a typo'd address** → `geocode` returns null →
  `routeError = "From not found"`. Actionable.
- **User taps "route" while still on a world-zoom map** → corridor span
  exceeds `MAX_CORRIDOR_SPAN_DEG`, `ensureBbox` returns false, no doomed
  build is launched.
- **A pan triggers an Overpass failure** → outer `catch {}` keeps the
  last region; the map shows stale-but-present streets and a later pan
  retries. Silent — the RF-3 blind spot.

### Code, line by line

**Fail-open elevation** — `mobile/src/useTileGraph.ts:18-28`:

```
  mobile/src/useTileGraph.ts  (bestEffortElevation, lines 18-28)

  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return {
      async sample(points) {
        try {
          return await p.sample(points);   ← 21 real elevations (good case)
        } catch {
          return points.map(() => 0);      ← 24 DEGRADE: flat 0m for all ⚠
        }
      },
    };
  }
       │
       └─ line 24 is the fail-open. it preserves connectivity (streets +
          routing survive a throttled elevation API) at the cost of
          fidelity (grades=0). the BUG is the bare `catch` — it swallows
          the failure with no flag, so the honesty card later shows GREEN
          "flat all the way" for grades it never actually measured (RF-1).
          the FIX: return {elevations, degraded:true} and surface it.
```

**Bounded backoff at the fetch** — `pipeline/elevation.ts:108-119`:

```
  pipeline/elevation.ts  (openMeteoProvider, lines 108-119)

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url);              ← 109
    if (res.ok) { json = await res.json(); break; }← 110-112 success
    if (res.status === 429 && attempt < retries) { ← 114 retryable + budget
      await sleep(delayMs * 2 ** (attempt + 1));    ← 115 EXPONENTIAL backoff
      continue;
    }
    throw new Error(`Open-Meteo elevation: ${res.status}`);← 118 BOUNDED giveup
  }
       │
       └─ line 114's `attempt < retries` is the bound — after `retries`
          429s it falls through to the throw at :118. that throw is what
          bestEffortElevation catches. without the bound, a hard-down API
          loops forever and the screen hangs instead of degrading.
          the app wires this with retries:1 (fail-fast) so a throttled
          build degrades to flat QUICKLY rather than stalling — useTileGraph.ts:111.
```

`pipeline/overpass.ts:18,42-46` is the same pattern for streets:
`RETRYABLE = new Set([429,502,503,504])`, retry-with-backoff, then a
bounded throw.

**Progress, cleared in finally** — `useTileGraph.ts:104-128`:

```
  mobile/src/useTileGraph.ts  (pump, lines 104-128)

  busyRef.current = true;
  setLoadingStep("Fetching streets");          ← 105 PROGRESS shown
  (async () => {
    try {
      const osm = await fetchOverpass(bbox);    ← 108
      const elev = bestEffortElevation(
        openMeteoProvider(fetch,{delayMs:400,retries:1}));← 111 fail-fast
      const g = await buildGraph(..., setLoadingStep);    ← 112 sub-steps
      ...set view/corridor...
    } catch {
      // Overpass failed — keep last region;    ← 121-122 SILENT retry-later
      //   a later pan retries.
    } finally {
      busyRef.current = false;                  ← 124
      setLoadingStep(null);                     ← 125 ALWAYS clear spinner
      pump();                                   ← 126 drain next request
    }
  })();
       │
       └─ line 125 in `finally` guarantees the "Fetching streets" string
          clears even when the build throws — no stuck spinner. line 121's
          bare catch is RF-3: a failed Overpass fetch is fully silent
          (no log, no toast). on a device with no console attached, that
          failure is invisible. FIX: a dev-mode console.warn in the catch.
```

**Typed user errors** — `mobile/src/MapScreen.tsx:156-161, 166-198`:

```
  mobile/src/MapScreen.tsx  (lines 156-161, 166-198)

  if (!graph || !heatmap) {
    return <View ...><Text>Failed to load graph.</Text></View>;← 156-161 fatal
  }

  const handleRoute = async (from, to) => {
    setRouteBusy(true);
    setRouteError(null);                       ← 168 clear stale error first
    try {
      const a = await geocode(from, {viewbox});← 174
      if (!a) { setRouteError("From not found"); return; }← 175-178
      const b = await geocode(to, {viewbox});  ← 181
      if (!b) { setRouteError("To not found"); return; }  ← 182-185
      ...set points, ease camera...
    } catch {
      setRouteError("Lookup failed — try again");← 195 generic network fail
    } finally {
      setRouteBusy(false);                     ← 197 always clear busy
    }
  };
       │
       └─ line 168 clears the previous error before each attempt — so a
          retry that succeeds doesn't show a stale message. each failure
          maps to a SPECIFIC actionable string (175/182/195): the user
          knows whether to fix the address or retry the network. the
          generic catch (195) is the only non-specific one, reserved for
          genuinely unexpected throws.
```

### The asymmetry, named

Put the two halves side by side and the audit finding writes itself:

```
  Comparison — loud vs quiet failure

  USER-FIXABLE (loud)              INFRASTRUCTURE (quiet)
  ─────────────────────            ──────────────────────
  bad address  → "From not found"  elevation 429 → 0m, no signal  ⚠ RF-1
  no GPS       → "Location unavail" Overpass fail → stale, no log  ⚠ RF-3
  span too wide→ ensureBbox false   region error  → catch {}       ⚠ RF-3

  the call is right (infra you can't fix shouldn't nag the user),
  but "no signal at all" ≠ "no user nag" — the system should still
  KNOW it degraded. that missing flag is the top blind spot.
```

---

## Elaborate

This is the **fail-open vs fail-closed** decision, one of the oldest in
systems design. Fail-closed (deny on failure) is right for security — a
broken auth check should *block*, not allow. Fail-open (proceed on
failure) is right for non-essential enrichment — a broken elevation
lookup should *degrade*, not block the map. flattr picks correctly per
dependency: elevation fails open (it's enrichment), the graph asset
fails closed (`"Failed to load graph"` — no graph, no app).

The piece flattr is missing is the **observability of the open**.
Industrial fail-open always pairs with a signal: a circuit breaker
flips, a `degraded` flag rides the response, a counter increments. The
signal is what lets you tell "everything's flat here" from "we couldn't
measure the grades." Without it, fail-open silently manufactures
confident-but-wrong output — which on a *flat-routing* app is the worst
failure mode, because the wrong output is exactly "it's flat." The fix
isn't to stop degrading; it's to make the degrade observable. That's why
RF-1 is ranked above everything else in `audit.md`.

The retry/backoff layer connects to standard HTTP client hygiene —
bounded retries on idempotent GETs with exponential backoff on
retryable statuses (429/5xx). flattr also tunes the *budget* by context:
the build CLI uses `retries: 3` (it can afford to wait), the app uses
`retries: 1` (`useTileGraph.ts:111`) to fail fast and degrade quickly
rather than stall the screen. Same mechanism, different budget — a real
operational judgment.

What to read next: `03-route-honesty-signal.md` (the card that the
silent elevation degrade can turn into a false "flat all the way"), and
`audit.md` lens 8 for the full ranked red-flag list.

---

## Interview defense

**Q: You fail open on elevation — return 0m on any error. Defend that
over just failing the build.**

A map with streets and no grades is navigable; a map with no streets is
dead. Elevation is enrichment, not the skeleton — so it fails open while
the street fetch and graph asset fail closed. The cost I accept is a
tile with grades = 0 until the API recovers.

```
  fail open for ENRICHMENT, fail closed for SKELETON

  elevation 429 → 0m, map survives   (open: right — it's enrichment)
  graph won't load → "Failed to load" (closed: right — it's the skeleton)
```

Anchor: *fail open for enrichment, fail closed for the skeleton.*

**Q: What's wrong with that fail-open as written?**

It's silent. The bare `catch` at `useTileGraph.ts:24` swallows the
failure with no flag, so a tile built flat looks identical to a tile
that's genuinely flat — and the honesty card cheerfully shows GREEN
"Flat all the way" for grades it never measured. Degrading is right;
degrading *invisibly* is the bug. The fix is a `degraded` flag threaded
to the card.

```
  degrade (good)  +  no signal (bug)  =  confident wrong answer
  "flat all the way" for grades we never actually measured
```

Anchor: *fail-open without a degraded-signal manufactures a confident
lie — on a flat-routing app, the worst possible one.*

**Q: Why does the app use `retries: 1` but the build CLI uses
`retries: 3`?**

Different latency budgets. The CLI build is offline tooling — it can
afford to back off and wait out a throttle. The app is interactive — a
long backoff is a frozen screen, so it fails fast (1 retry) and degrades
to flat quickly. Same retry mechanism, budget tuned to whether a human is
staring at it.

Anchor: *same backoff code, retry budget set by whether a human is
waiting.*

---

## Validate

**Reconstruct.** Draw the fork at the catch: degrade (fail-open, safe
default) vs surface (fail-loud, typed UI state). Name which flattr
failure types go down each branch.

**Explain.** Why is `setLoadingStep(null)` in a `finally`
(`useTileGraph.ts:125`) and not just at the end of the `try`? What's the
exact bug if it were in the `try`?

**Apply to a scenario.** Open-Meteo starts 429ing for an hour. Walk what
the user sees: does the map render, what grades does a new tile have,
and what does the honesty card say for a route over a real hill? Name the
two `file:line` points that produce that (wrong) outcome.

**Defend the decision.** The app uses `retries: 1`
(`useTileGraph.ts:111`) while `pipeline/run-build.ts` defaults to
`retries: 3` (`elevation.ts:97`). Argue why that difference is correct,
and what would break if the app used 3.

---

## See also

- `03-route-honesty-signal.md` — the card that a silent elevation degrade
  can turn into a false "flat all the way" (this is the RF-1 link).
- `01-search-instrumentation-counters.md` — the in-process signal pattern
  the missing `degraded` flag would join.
- `00-overview.md` — the evidence map; this is the #4 ranked surface.
- `audit.md` — lens 6 (state/network boundaries), lens 8 (RF-1 silent
  degrade, RF-3 swallowed runtime errors).
- `../study-performance-engineering/` — the backoff/budget tuning read as
  a latency decision rather than a visibility one.
