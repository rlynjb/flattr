# 02 — Partial Failure, Timeouts, and Retries

**Industry names:** partial failure / retry-with-backoff / deadline propagation
/ failure classification. **Type:** Industry standard.

## Zoom out, then zoom in

You know how a local function call has exactly two outcomes — it returns, or it
throws — and you can reason about both? Cross a network and you get a *third*
outcome that has no local analog: **it never answers.** Not success, not failure
— silence. Partial failure is that third outcome, and every retry/timeout
mechanism exists to convert silence back into one of the two outcomes your code
can actually handle.

Here's where flattr's defenses against it live. They're all clustered on the one
seam from `01`.

```
  Zoom out — where partial-failure handling lives in flattr

  ┌─ Client / Build (you own) ────────────────────────────────────┐
  │  pump() / main()  →  fetchOverpass()  →  openMeteoProvider()   │
  │                         ★ retry loop ★      ★ backoff loop ★   │ ← we are here
  └───────────────────────────┬───────────────────────────────────┘
                              │  HTTP — the third outcome lives here
                              ▼
  ┌─ Third-party fleet (uncontrolled) ────────────────────────────┐
  │  returns 200  ·  returns 429/503  ·  ...or never answers       │
  │   (success)      (retryable fail)      (THE GAP — see below)   │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **failure classification + bounded retry.** When the
remote node answers with a *retryable* status, flattr backs off and tries again.
When it answers with anything else, flattr gives up cleanly. The load-bearing
gap — the thing this file builds to — is the **third outcome flattr does not
handle: the call that never answers, because there's no client-side timeout
anywhere in the repo.**

## The structure pass

**Layers.** Three nested levels of retry: (1) the inner backoff loop inside one
elevation batch (`elevation.ts:108-119`), (2) the outer retry loop around one
Overpass fetch (`overpass.ts:32-47`), (3) the app-level self-heal that re-queues
a whole degraded region (`useTileGraph.ts:209-218`). Same word "retry," three
different altitudes.

**Axis — trace `what bounds the retry?` across the three layers.**

```
  One axis — "what stops this retry from looping forever?" — down the layers

  ┌─ inner: elevation backoff ──────────┐
  │ bound = attempt COUNT (retries=3)   │   → a counter, no clock
  └──────────────────┬──────────────────┘
                     │  same kind of bound ↓
  ┌─ outer: Overpass retry ─────────────┐
  │ bound = attempt COUNT (retries=3)   │   → a counter, no clock
  └──────────────────┬──────────────────┘
                     │  the bound CHANGES kind ↓
  ┌─ app: self-heal ───────────────────┐
  │ bound = retry COUNT (MAX_RETRIES=6) │   → a counter AND a 12s interval,
  │        + RETRY_MS interval          │     but STILL no per-call deadline
  └─────────────────────────────────────┘
```

The answer is the same at every layer and *that sameness is the finding*: every
bound in flattr is a **count of attempts**, never a **budget of wall-clock time**.
A retry that's bounded by count but not by time can still hang forever if a
single attempt hangs forever — because nothing makes an individual attempt give
up. Hold that thought; it's the seam.

**Seam.** The load-bearing seam is *inside one attempt* — between "I sent the
request" and "I got a response." That's where a deadline would live, and flattr
has nothing there. `fetchImpl(...)` at `overpass.ts:33`, `elevation.ts:109`,
`geocode.ts:21` is an un-timed `await`. The failure-containment axis is supposed
to flip at that boundary (a slow network should become a thrown error); in flattr
it doesn't flip — a slow network becomes an infinite hang.

## How it works

### Move 1 — the mental model: classify, then bound

Retry-with-backoff is a loop with three decisions per turn: *did it work? if not,
is this worth retrying? if yes, wait — longer each time — then try again.* The
"wait longer each time" is **backoff** (don't hammer a struggling server); a
real-world hardening adds **jitter** (randomize the wait so a thundering herd of
clients doesn't retry in lockstep).

```
  The pattern — bounded retry with backoff

  attempt = 0
  ┌──────────────────────────────────────────────┐
  │  send request ──────────────► response        │
  │      │                            │           │
  │      │                    ┌───────┴────────┐  │
  │      │                  success?         fail │
  │      │                    │                │  │
  │   ◄──┘ return ◄───────────┘         retryable │
  │                                  AND attempt   │
  │                                  < budget?     │
  │                            no ──┘     │ yes    │
  │                            │          ▼        │
  │                          throw   wait delay×f  │
  │                                  attempt++ ────┘  ← loop back
  └──────────────────────────────────────────────┘
       MISSING in flattr: a clock that fires while "send request"
       is still in flight and forces it to fail
```

The kernel — the irreducible parts that make this *the pattern*:

- **the loop** — without it, one failed call = one failure, no recovery.
- **failure classification** — *which* failures are worth retrying. Retry a
  permanent failure (a 400) and you waste attempts; don't retry a transient one
  (a 503) and you fail unnecessarily.
- **the budget** — without a bound, a permanently-down server loops forever.
- **the backoff** — without it, retries pile load onto a server that's failing
  *because* it's overloaded, making it worse.

Optional hardening on top of the kernel: **jitter** (flattr has none — see
below), and **a per-attempt deadline** (flattr has none — the gap).

### Move 2 — walk the three retry layers in flattr

**Layer 1 — Overpass: classify by status, retry the transient ones.**
`fetchOverpass` (`overpass.ts:21-48`) is the cleanest example of classification.

```
  overpass.ts:18 — the classification set is explicit

  const RETRYABLE = new Set([429, 502, 503, 504]);
                              │    │    │    │
              rate-limited ───┘    │    │    └── gateway timeout
              bad gateway ─────────┘    └─────── service unavailable
              (all transient: "try again, I might be fine next time")
```

```
  overpass.ts:32-47 — the retry loop, annotated

  for (let attempt = 0; ; attempt++) {        // unbounded counter, broken out below
    const res = await fetchImpl(endpoint, {…}) // ← UN-TIMED await: the gap lives here
    if (res.ok) return … as OverpassResponse   // success → done
    if (RETRYABLE.has(res.status)               // classify: transient?
        && attempt < retries) {                 // budget: attempts left? (retries=3)
      await sleep(delayMs * (attempt + 1))      // LINEAR backoff: 2s, 4s, 6s
      continue                                  // loop
    }
    throw new Error(`Overpass … ${res.status}`) // non-retryable OR budget spent → give up
  }
```

Read the backoff: `delayMs * (attempt + 1)` is **linear** (2s, 4s, 6s), not
exponential, and has **no jitter**. Linear is fine for a single-client build
tool — there's no herd of flattr instances to synchronize. The moment flattr
becomes a server with many clients, the missing jitter becomes a real
thundering-herd risk (all clients retrying Overpass at t+2s in lockstep). Name it
as a deliberate single-client simplification, not an oversight.

**Layer 2 — Open-Meteo elevation: exponential backoff, narrower classification.**
`openMeteoProvider` (`elevation.ts:92-126`) retries *only* 429, with exponential
backoff.

```
  elevation.ts:108-119 — inner backoff loop per batch, annotated

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url)            // ← again, UN-TIMED await
    if (res.ok) { json = …; break }             // success → leave the loop
    if (res.status === 429 && attempt < retries){// ONLY 429 is retryable here
      await sleep(delayMs * 2 ** (attempt + 1)) // EXPONENTIAL: 600ms,1.2s,2.4s…
      continue
    }
    throw new Error(`Open-Meteo … ${res.status}`)// anything else → give up immediately
  }
```

Why narrower than Overpass? Because the *only* transient failure Open-Meteo
throws in practice is throttling (429), and the project context confirms it:
"Open-Meteo free elevation API 429s when quota is exhausted." Classifying tightly
to the one failure you actually see is good practice — don't retry a 500 you've
never observed and can't reason about.

**Layer 3 — the app self-heal: retry the whole region, not the call.**
This is retry at a different altitude. When elevation came back flat (degraded),
`useTileGraph.ts:209-218` re-queues the entire region build later.

```
  useTileGraph.ts:209-218 — app-level self-heal retry, annotated

  if (degraded && retryCountRef.current < MAX_RETRIES) {  // budget: 6 region-retries
    retryCountRef.current += 1
    if (retryRef.current) clearTimeout(retryRef.current)
    retryRef.current = setTimeout(() => {                 // wait RETRY_MS (12s)
      if (viewRef.current?.degraded) pendingViewRef.current = {…, silent: true}
      if (corridorRef.current?.degraded) pendingCorridorRef.current = {…, silent: true}
      pump()                                              // re-run the build for that area
    }, RETRY_MS)
  }
```

The distinction worth holding: layers 1–2 retry *one HTTP call*; layer 3 retries
*the whole graph build for a region* once the elevation API has had 12s to
recover. `silent: true` means these retries don't flash the loading overlay — the
green grades just quietly fill in (`useTileGraph.ts:116`). And it's capped at
`MAX_RETRIES = 6` so a sustained outage doesn't loop forever — a real
non-degraded build resets the counter (`:238`, `:274`). This is the
eventual-consistency machinery; `04` walks it as a consistency story.

**The gap — no per-attempt deadline anywhere.** Trace every `await fetchImpl(...)`
above: none of them is wrapped in a timeout. There is no `AbortController`, no
`signal`, no `Promise.race` against a timer anywhere in the repo (verified by
grep across `pipeline/`, `mobile/`, `features/`). The `[out:json][timeout:60]` in
`overpass.ts:10` is **Overpass QL** — a server-side hint telling Overpass to
abandon *its own* query after 60s; it does nothing to your socket.

```
  the gap — count-bounded but not time-bounded

  what flattr bounds:   attempt 0 ─ 1 ─ 2 ─ 3 ─ STOP   ✓ (count works)
  what flattr does NOT: │
                        └─ if attempt 0's socket hangs and the server
                           never sends a byte, the await never resolves,
                           the loop never reaches "attempt < retries",
                           and the whole pump()/build hangs forever.
                           A retry budget can't fire if no attempt ever returns.
```

The consequence is concrete: TCP's own timeout is on the order of minutes, so a
black-holed connection (server accepted the socket, then went silent) stalls a
graph build for *minutes*, and on the client the single-flight pump (`06`) means
*no other tile can build* while it's stuck — one hung Overpass call freezes all
background loading. The fix is one wrapper: an `AbortController` with a
`setTimeout(() => controller.abort(), DEADLINE)` passed as `signal` into every
`fetchImpl`, so a hung call throws and *becomes* a retryable failure the existing
loops already handle. That's the single highest-value distributed-systems change
in the repo (`09` ranks it #1).

### Move 3 — the principle

A retry budget counts attempts; a timeout bounds *time*. You need both, because
they fail closed on different things: the budget stops a *fast-failing* server
from looping, the timeout stops a *silent* server from hanging. flattr has the
first at three different altitudes and is missing the second everywhere — which
is the single most common distributed-systems gap in real codebases, because the
silent-failure case is the one you never see in local testing. **"It works on my
machine" is exactly the environment where the third outcome never happens.**

## Primary diagram

The full picture: three retry altitudes, what bounds each, and the missing
deadline that cuts across all of them.

```
  flattr — retry layers + the cross-cutting gap

  ┌─ app self-heal (useTileGraph.ts:209) ─────────────────────────┐
  │  degraded region → wait 12s → re-queue build  (cap: 6)        │
  └───────────────────────┬───────────────────────────────────────┘
              wraps ↓ (a whole build, not one call)
  ┌─ Overpass retry (overpass.ts:32) ─────┬─ Open-Meteo backoff (elevation.ts:108) ─┐
  │  classify {429,502,503,504}           │  classify {429 only}                    │
  │  linear 2s·4s·6s, no jitter, cap 3    │  exp 0.6s·1.2s·2.4s, no jitter, cap 3   │
  └───────────────┬───────────────────────┴───────────────┬─────────────────────────┘
                  │  await fetchImpl(...)                  │  await fetchImpl(...)
                  ▼                                        ▼
        ╔═══════════════════════ THE GAP ════════════════════════╗
        ║  no AbortController / no timeout on EITHER await:       ║
        ║  a silent server hangs the call → hangs the retry loop  ║
        ║  → hangs the build → (client) hangs the single-flight   ║
        ║  pump → all background tile loading freezes.            ║
        ╚═════════════════════════════════════════════════════════╝
```

## Elaborate

Retry/backoff/jitter is the canonical distributed-systems hardening — AWS's
"timeouts, retries and backoff with jitter" is the reference write-up, and the
jitter half exists specifically to break the thundering herd that flattr's
single-client model lets it skip. Deadline *propagation* (a request carries "you
have 200ms left" down through every hop, each hop subtracting its own time) is
the next level up; it's what keeps a slow leaf service from blowing a whole
request's latency budget. flattr has no hop chain — one client, one call — so
there's nothing to propagate a deadline *through*, but the per-call deadline it's
missing is the atom that propagation is built from. Learn the atom here; the
propagation becomes relevant the day flattr fronts these calls with its own
server that calls them on the user's behalf.

## Interview defense

**Q: "This code retries on failure. What's missing?"**
Verdict first: "It bounds the *number* of attempts but not the *time* per
attempt — there's no client-side timeout, so a server that accepts the socket and
goes silent hangs the call indefinitely, and a count-based retry budget can't
fire because no attempt ever returns to check it." Then the fix: one
`AbortController` per call, `abort()` on a `setTimeout`, which converts the hang
into a thrown error the *existing* retry loop already classifies and retries.
Naming that the timeout and the retry budget guard *different* failures — silent
vs fast-failing — is the senior signal.

```
  the sketch you draw

  retry budget  ─► stops:  fail ─ fail ─ fail ─ STOP   (fast failure)
  timeout       ─► stops:  ...silence... ─ ABORT       (no failure at all)
  you need both — flattr has only the first
```

**Q: "Why retry 429 but not, say, 400?"**
Because failure classification is the load-bearing part: a 429 is transient (rate
limit — wait and it clears), a 400 is permanent (malformed request — retrying
sends the identical bad request forever and burns the budget). `overpass.ts:18`'s
`RETRYABLE` set is exactly this judgment encoded. Retrying a permanent failure is
a classic bug that turns one error into a retry storm.

**Anchor:** *Count-bounded, not time-bounded — the retry budget guards a
fast-failing server, the missing timeout guards a silent one.*

## See also

- `03` — why retrying these calls is *safe* (pure reads, no duplicate side
  effects).
- `04` — what the self-heal retry (layer 3) converges toward.
- `06` — why one hung call freezes everything: the single-flight pump.
- `09` — the missing-timeout gap ranked #1, with the one-wrapper fix.
- sibling **networking** — where the timeout would actually sit in the transport
  stack; sibling **performance-engineering** — backoff/delay as a latency budget.
