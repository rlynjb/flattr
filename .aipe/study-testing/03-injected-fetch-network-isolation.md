# Injected Fetch — testing network code without a network

*Industry name: **dependency injection at the I/O boundary** + **fake/stub
HTTP** (a hand-rolled contract test, not `nock`/`msw`). Type: language-agnostic
technique.*

---

## Zoom out — where this sits

This is how flattr's build pipeline tests every external API — Overpass,
Open-Meteo, Google Elevation, Nominatim — without ever touching the wire. It's
the reason the 130-test suite runs in 282ms and never trips the Open-Meteo
rate limit the project memory warns about.

```
  Zoom out — the injected-fetch seam at the network boundary

  ┌─ Pipeline (pipeline/) BUILD-TIME ────────────────────────┐
  │  fetchOverpass / openMeteoProvider / geocode             │
  │      │  each takes `fetchImpl` as a PARAMETER             │ ← the seam
  │      ▼                                                   │
  └──────┼───────────────────────────────────────────────────┘
         │  ┄┄┄┄┄┄ NETWORK BOUNDARY ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
         │
   PRODUCTION                          TEST
   ┌──────────────┐                    ┌──────────────────────┐
   │ real fetch   │                    │ vi.fn() fake fetch    │ ← here
   │ → OSM / API  │                    │ → synthetic Response  │
   └──────────────┘                    └──────────────────────┘
```

The question it answers: **how do you test code whose whole job is to call a
flaky, rate-limited, slow external service — without the flakiness, the rate
limit, or the slowness?** You make the HTTP client a *parameter*, and in tests
you pass a fake that returns exactly the response you want to test against.

---

## The structure pass

**Layers.** The network code splits into two halves around one seam:

- outer (logic you own and want to test): build the query, batch the points,
  parse the response, retry on 5xx, throw on 4xx, dedupe by cell.
- inner (the I/O you don't own and can't trust in a test): the actual HTTP
  round-trip.

**The axis: trust / control — "who decides what comes back?"** Trace it across
the seam:

- In production: the *server* decides. You send a query, OSM decides whether
  to 200 with data, 429 you, or 504 under load. Zero control.
- In test: *you* decide. The fake `fetch` returns precisely the `Response` the
  test needs — a 504 then a 200 to exercise retry, a `REQUEST_DENIED` to
  exercise the error path. Total control.

**The seam:** the `fetchImpl` / `fetch` parameter in every network function's
signature. The control axis flips hard across it — from "server decides" to
"test decides" — which is exactly what makes it the load-bearing boundary. And
critically: **the seam is in the function signature, not hidden behind a module
mock.** No `vi.mock("node-fetch")`, no module-graph surgery. The dependency is
visible, so the test just hands over a different function.

---

## How it works

### Move 1 — the mental model

You know how a React component that takes its data as props is trivial to test
(pass props, assert render) but one that `fetch`es internally is a pain
(intercept the network)? Same fix here: **don't reach for `fetch`, accept it.**
The function that called `fetch` directly becomes a function that takes `fetch`
as an argument.

```
  The injection flip — reach-for vs accept

  BEFORE (hard to test)            AFTER (trivial to test)
  ┌──────────────────────┐        ┌──────────────────────────┐
  │ function geocode(q) { │        │ function geocode(q,       │
  │   fetch(url)  ◄──hard │        │   { fetchImpl }) {        │
  │ }            to swap   │        │   fetchImpl(url)  ◄── pass │
  └──────────────────────┘        │ }              any fn here │
                                   └──────────────────────────┘
   test must intercept the          test just passes a fake:
   global network                   geocode(q, { fetchImpl: vi.fn(...) })
```

The strategy in one sentence: **push the untrusted dependency out of the
function body and into its parameter list, so a test can substitute a trusted
fake.**

### Move 2 — the walkthrough

**Step 1 — the production default, the test override.** Each function defaults
to the real `fetch` so production callers pass nothing, but accepts an override
so tests pass a fake. One signature serves both.

```
  Pseudocode — the injectable signature

  function fetchOverpass(bbox, url, fetchImpl = globalThis.fetch, opts):
    response = await fetchImpl(url, { method: "POST", body: query })
    if not response.ok: ...retry-or-throw...
    return parse(response)

  // production: fetchOverpass(bbox, url)            → uses real fetch
  // test:       fetchOverpass(bbox, url, fakeFetch) → uses your fake
```

The boundary condition: the default has to be the *real* one, or production
breaks. Tests never rely on the default — they always pass the fake explicitly.

**Step 2 — the fake returns a real `Response`.** The fake isn't a loose object;
it returns an actual `Response` (the same type the real `fetch` returns), so
the code under test runs its real parsing and `.ok` / `.status` logic. You're
testing the real code path, just with synthetic bytes.

```
  Layers-and-hops — what the fake substitutes

  ┌─ test ─────────────┐  hop 1: call with fakeFetch  ┌─ code under test ──┐
  │ fakeFetch =        │ ───────────────────────────► │ fetchOverpass(...)  │
  │  vi.fn(async url =>│                               │  builds query,      │
  │   new Response(    │ ◄─────────────────────────── │  calls fetchImpl    │
  │    JSON, {200}))   │  hop 2: synthetic Response    │  hop 3: parses .json│
  └────────────────────┘                               └────────────────────┘
       no real socket opens; the parse/retry/error logic runs for real
```

**Step 3 — drive the hard-to-reproduce responses.** This is where injection
pays off: the responses you most need to test (429, 504, malformed JSON) are
the ones you can't reliably *cause* against a real server. The fake produces
them on demand.

```
  Execution trace — testing retry on a transient 504

  call #  fake returns        code does                  assertion
  ──────────────────────────────────────────────────────────────────
   1      504 "busy"          retryable → sleep(0), retry  —
   2      200 {elements:[]}   ok → parse, return           returns []
  ──────────────────────────────────────────────────────────────────
  assert fakeFetch called exactly 2×  ✓   (initial + 1 retry)

  vs. non-retryable 400:
   1      400 "bad"           NOT retryable → throw        —
  ──────────────────────────────────────────────────────────────────
  assert fakeFetch called exactly 1×  ✓   (no retry on 4xx)
  assert throws /400/                 ✓
```

The fake also records *how many times* it was called (`vi.fn()` tracks this),
which is how the test verifies batching ("150 points → 2 calls of 100+50") and
retry counts ("persistent 429 → initial + 2 retries = 3 calls"). The call
count is itself an assertion target.

**Step 4 — kill the wall-clock wait.** The retry path sleeps with exponential
backoff in production. A test that waited real seconds would be slow and a
flake risk. So the same injection trick applies to *time*: the function takes
`delayMs`, and tests pass `delayMs: 0`.

```
  Pseudocode — backoff, neutralized in test

  if status == 429 and attempt < retries:
    await sleep(delayMs * 2^(attempt+1))   // prod: real backoff
                                            // test: delayMs=0 → instant

  // openMeteoProvider(fakeFetch, { delayMs: 0, retries: 0 })
  // exercises the retry LOGIC without the retry WAIT.
```

This is the detail that keeps the suite at 282ms total. The logic is tested;
the latency is dialed to zero.

### Move 2 variant — the load-bearing skeleton

The kernel of this technique is three parts:

1. **The dependency is a parameter.** Drop it (reach for `fetch` in the body)
   → the only way to test is global network interception or module mocking,
   both brittle. This is *the* load-bearing part.
2. **The fake speaks the real protocol.** Drop it (return a loose `{}` instead
   of a `Response`) → you test against a fiction; the real `.ok`/`.status`/
   `.json()` path never runs, so a parsing bug ships green.
3. **The fake is observable.** Drop the call-count/args tracking → you can't
   assert batching, retry counts, or that the URL was built right.

Optional hardening: injecting `delayMs`/`retries` to neutralize time, the
`fixtureProvider` abstraction (a higher-level fake that skips HTTP entirely for
the elevation step). The skeleton is "dependency-as-parameter + protocol-true
fake + observable fake."

### Move 2.5 — current vs future (the library upgrade)

flattr hand-rolls the fakes (`vi.fn()` returning `new Response(...)`). The
mature alternative is `msw` (Mock Service Worker) or `nock`, which intercept at
the HTTP layer.

```
  Phase A (now)                    Phase B (if it grows)
  ┌──────────────────────┐         ┌──────────────────────────┐
  │ inject fetchImpl,     │         │ msw intercepts real fetch │
  │ return new Response() │   →     │ with handler definitions  │
  │ per test              │         │ shared across the suite   │
  └──────────────────────┘         └──────────────────────────┘
   wins: zero deps, the seam        wins: realistic request
   is visible in the signature      matching, shared handlers
```

The honest call: **flattr's hand-rolled approach is correct for its size.**
Four endpoints, each tested in one file, with the seam visible in the
signature. `msw` earns its place when you have many endpoints, shared response
fixtures, and want to match on request bodies — not before. What *doesn't* have
to change if you migrate: the production code, because the seam (`fetchImpl`)
already exists.

### Move 3 — the principle

**Push I/O to a parameter and the rest of the function becomes a pure unit
test.** The boundary between "logic I own" and "I/O I don't" should be a
function argument, not a hidden import. Once it is, every hard-to-reproduce
failure mode (rate limits, timeouts, malformed responses) becomes a one-line
fake — and the network never gets touched.

---

## Primary diagram

The full recap: one seam, two sides, the four endpoints it isolates.

```
  flattr's injected-fetch isolation — full recap

  ┌─ logic under test (you own it) ──────────────────────────┐
  │  buildOverpassQuery · batch-by-100 · parse · retry/throw  │
  │  · dedupe-by-cell · viewbox bias                          │
  └────────────────────────────┬─────────────────────────────┘
                               │  fetchImpl(url, init)   ← THE SEAM
                ┌──────────────┴───────────────┐
                ▼                               ▼
  ┌─ PRODUCTION ───────────┐      ┌─ TEST ─────────────────────────┐
  │ globalThis.fetch       │      │ vi.fn(async => new Response(   │
  │ → Overpass / OSM       │      │   JSON.stringify(body),{status})│
  │ → Open-Meteo (429!)    │      │ controls status, body, count   │
  │ → Google Elevation     │      │ + delayMs:0 kills backoff      │
  │ → Nominatim            │      │ → 504-then-200, 400, 429×3 …   │
  └────────────────────────┘      └────────────────────────────────┘
       NETWORK BOUNDARY            no socket; real parse/retry runs
```

---

## Implementation in codebase

**Use cases.** Reached for in every pipeline module that calls out:
`overpass.ts` (street geometry), `elevation.ts` (three providers — Google,
Open-Meteo, fixture), `geocode.ts` (Nominatim forward + reverse + suggest).
These are *build-time* modules — they run when you `npm run build:graph`, not
in the mobile app — but they're the most failure-prone code in the repo
(external, rate-limited, flaky), so they're heavily tested.

The injectable signature, `pipeline/overpass.ts` via its test
(`pipeline/overpass.test.ts:18-27`):

```
  pipeline/overpass.test.ts  (lines 18-27)

  it("POSTs the query and returns parsed JSON", async () => {
    const body = { elements: [{ type: "node", id: 1, ... }] };
    const fakeFetch = vi.fn(async (_url, _init) =>            ← the fake
      new Response(JSON.stringify(body), { status: 200 }));   ← real Response
    const res = await fetchOverpass(
      bbox, "https://example/api",
      fakeFetch as unknown as typeof fetch);                  ← injected here
    expect(res.elements).toHaveLength(1);                     ← real parse ran
    expect(fakeFetch).toHaveBeenCalledOnce();                 ← observable
    const call = fakeFetch.mock.calls[0];
    expect((call[1] as RequestInit).method).toBe("POST");     ← asserts the
  });                            │                               request shape
                                 └─ note: a real Response, the real parser, a
                                    real assertion on method — only the socket
                                    is faked. This is a contract test, not a
                                    test of a mock.
```

The retry matrix, `pipeline/overpass.test.ts:29-55` — four cases, all driven by
the fake's chosen status: non-retryable 400 (1 call, throws), transient 504
then 200 (2 calls, succeeds), persistent 429 (initial + 2 retries = 3 calls,
throws). The call count *is* the assertion.

Time neutralized, `pipeline/elevation.test.ts:58,68`:

```
  pipeline/elevation.test.ts  (lines 51-70, condensed)

  const p = openMeteoProvider(fakeFetch, { delayMs: 0 });   ← no real backoff
  ...
  expect(fakeFetch).toHaveBeenCalledTimes(2);  // 100 + 50 ← batching asserted
  ...
  const p2 = openMeteoProvider(fakeFetch, { delayMs: 0, retries: 0 });
  await expect(p2.sample(...)).rejects.toThrow(/429/);      ← error path,
                               │                               instantly
                               └─ delayMs:0 is why the suite is 282ms and why
                                  the real Open-Meteo rate limit is never hit.
```

And the higher-level fake — `fixtureProvider` (`pipeline/elevation.test.ts:10-15`)
— skips HTTP entirely for tests that only care about the *downstream* logic
(dedup, snapping). `buildGraph` end-to-end (`pipeline/build-graph.test.ts:9-19`)
runs the whole pipeline on `fixtureProvider(sampleElevationFn)` + a hardcoded
Overpass fixture — a full integration test with zero network.

---

## Elaborate

This is plain **dependency injection** applied at the I/O edge — the oldest
testability move there is, and the reason "functional core, imperative shell"
is good advice: keep the pure logic inside, push the side effects to the
boundary, inject the boundary in tests. flattr does it with a function
parameter (the lightest form); larger systems do it with interfaces/DI
containers, but the principle is identical.

The fakes are **stubs returning canned responses**, and because they return
real `Response` objects and the test asserts on the request shape (method,
URL, body), they double as lightweight **contract tests** — they pin "we send a
POST with the query in the body and parse `.elements` out." If the Overpass
contract changed, these would catch the request-side break (they wouldn't
catch a server-side schema change — that needs a recorded real response, which
is the next tier up).

This composes with everything else in the suite: the network is faked here so
that `build-graph.test.ts` can run the *whole* pipeline deterministically,
which feeds a real graph into the routing oracle (`01-optimality-oracle.md`).
Isolation at the boundary is what makes the integration test above it possible.

Cross-links: `.aipe/study-networking/` covers the actual HTTP semantics being
faked (status codes, retry/backoff, the 429 rate-limit behavior). The "push
I/O to the boundary" design that makes this possible is a
`.aipe/study-software-design/` finding (deep modules, info hiding).

---

## Interview defense

**Q: How do you test code that calls a rate-limited external API?** Never call
it. The HTTP client is a *parameter* (`fetchImpl`), defaulting to real `fetch`
in production; tests pass a `vi.fn()` that returns a synthetic `Response`. The
load-bearing detail: the seam is in the function *signature*, not behind a
module mock — so the dependency is visible and a test just hands over a
different function. flattr's Open-Meteo provider is rate-limited; the suite
never hits it because the fake stands in.

```
  fetchOverpass(bbox, url, fetchImpl)
                          └── prod: real fetch │ test: fake → chosen Response
```

**Q: Your fake returns a 504 then a 200. Why bother?** Those are the responses
I can't reliably cause against a real server — and they're exactly the failure
modes that break in production (transient 5xx, rate-limit 429). The fake
produces them on demand, and `vi.fn()`'s call count lets me assert the retry
*count* (504-then-200 = 2 calls; persistent 429 with retries:2 = 3 calls; 400 =
1 call, no retry because 4xx isn't retryable). Anchor:
`overpass.test.ts:29-55`.

**Q: Don't you risk testing the mock instead of the code?** No — two guards.
The fake returns a *real* `Response`, so the code's real `.ok`/`.status`/
`.json()` parsing runs; and I assert on the *request* the code built (POST,
URL, body), not just the response it got back. That makes it a contract test on
the request side, not a tautology. The gap it can't cover is a server-side
schema change — that'd need a recorded real response, the next tier up.

**Q: Why not `msw` or `nock`?** Four endpoints, each in one test file, seam
visible in the signature — hand-rolled fakes are less machinery for the same
coverage. `msw` earns its place with many endpoints and shared request matching.
The migration is free if needed because the `fetchImpl` seam already exists.

---

## Validate

**Reconstruct.** Write the injectable signature for a new `fetchWeather(coord,
fetchImpl)` and the three-part kernel (parameter / protocol-true fake /
observable fake) and what breaks without each.

**Explain.** Why does `openMeteoProvider` take `delayMs` (`elevation.test.ts:58`)?
What two things would break in the suite if the backoff used a hardcoded sleep?

**Apply.** flattr's mobile app calls Nominatim live for autocomplete
(`AddressBar`). Today that's untested. How would you make `geocodeSuggest`'s
*caller* testable the same way? (Answer: the engine already injects `fetchImpl`
— `geocode.test.ts:63-86`; the gap is the mobile component reaching for it
directly, so inject there too.)

**Defend.** A reviewer says "just record real Overpass responses and replay
them." When is that better than synthetic responses, and when is it worse?
(Hint: recorded responses catch server-schema drift; synthetic ones are easier
to drive into error states and don't rot.)

References: `pipeline/overpass.test.ts:18-55`,
`pipeline/elevation.test.ts:26-71`, `pipeline/geocode.test.ts:4-86`,
`pipeline/build-graph.test.ts:9-58`, `pipeline/elevation.ts:92-121`.

---

## See also

- `01-optimality-oracle.md` — the integration test (`build-graph.test.ts`)
  this isolation makes possible feeds the routing oracle.
- `04-fixture-driven-graph-tests.md` — `sampleOverpass()` /
  `fixtureProvider`, the higher-level fakes for the build pipeline.
- `audit.md` §2 (mocking is surgical), §4 (no network → no flakiness), §5
  (error-path coverage).
- `.aipe/study-networking/` — the HTTP semantics (status codes, retry,
  rate limits) being faked here.
- `.aipe/study-software-design/` — push-I/O-to-the-boundary as a design move.
