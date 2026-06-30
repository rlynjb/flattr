# 03 — Injected-Fetch Network Isolation

**Industry names:** *dependency injection at the network seam* / *test double (mock/stub)
for I/O* / *hermetic testing*. **Type:** Industry standard.

---

## Zoom out, then zoom in

The build pipeline calls real HTTP APIs — Overpass for streets, Open-Meteo/Google for
elevation, Nominatim for geocoding. You cannot test against those: they're slow, they rate-
limit (the project context literally warns Open-Meteo 429s under heavy testing), and they
go down. So flattr never lets a test touch a socket. Every networked function takes `fetch`
as a *parameter*, and tests pass a fake.

```
  Zoom out — the injected-fetch seam in the pipeline

  ┌─ Build pipeline: pipeline/ (build-time only) ──────────────┐
  │   fetchOverpass(bbox, url, fetch?, opts)  ◄── fetch injected│
  │   openMeteoProvider(fetch?, opts)         ◄── fetch injected│
  │   googleProvider(key, fetch?)             ◄── fetch injected│
  │            │                                               │
  │   ★ tests pass a vi.fn() mock here ★  ← THIS CONCEPT       │
  └────────────────────────────────────────────────────────────┘
            │ real run uses global fetch │ tests use a fake
            ▼                            ▼
  ┌─ Network boundary ──────┐   ┌─ no network at all ─────────┐
  │ Overpass / Open-Meteo / │   │ vi.fn returns a canned       │
  │ Google / Nominatim      │   │ Response, delayMs: 0         │
  └─────────────────────────┘   └──────────────────────────────┘
```

The thing being tested isn't the network — it's *flattr's code around the network*: does it
build the right Overpass query, batch elevation requests by 100, parse the response shape,
and — the hard part — retry a 504 but not a 400? All of that is deterministic and testable,
*if* you can control what `fetch` returns. Injection is how you get that control.

---

## The structure pass

Layer it, pick the axis — **"who controls what the network returns?"** — and watch it flip.

```
  axis traced: "who controls the network response?"

  ┌─ pipeline fn: fetchOverpass (overpass.ts) ──────┐
  │  controls NOTHING — it just calls fetch()        │
  └───────────────────────┬──────────────────────────┘
                          │  seam: fetch is a PARAMETER
  ┌─ production ──────────▼──────────────────────────┐
  │  global fetch → the real internet decides         │  ← uncontrollable
  └──────────────────────────────────────────────────┘
  ┌─ test ────────────────▼──────────────────────────┐
  │  vi.fn() → THE TEST decides the response & status │  ← fully controlled
  └──────────────────────────────────────────────────┘
```

The seam is the `fetch` parameter, and the axis flips hard across it: in production the
internet decides, in test the test decides. That single injected parameter is what converts
an untestable I/O call into a deterministic, fully-controlled unit. Everything downstream —
the retry matrix, the batching, the parse — becomes assertable because the input is now in
the test's hands.

---

## How it works

### Move 1 — the mental model

You've passed a function as a prop to make a component testable — `onSubmit={mockFn}` so the
test can assert it was called without a real form post. Injecting `fetch` is the same move
at the network boundary: hand the function its dependency instead of letting it reach for a
global, and the test gets to choose what that dependency does.

```
  the injection shape — swap the dependency at the seam

   production:   fn( ..., fetch )         ──► real network ──► real, slow, flaky
   test:         fn( ..., vi.fn(canned) ) ──► no network   ──► instant, deterministic
                          ▲
                  same code path runs;
                  only the injected dep changed
```

Strategy in one sentence: **make the network a parameter so the test owns the response.**

### Move 2 — the walkthrough

**Part 1 — the function signature is the whole trick: `fetch` is an optional parameter.**
Default to the real one in production, override in tests:

```ts
// pipeline/overpass.test.ts:20-27  (annotated — the production fn takes fetch as a param)
const fakeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
  new Response(JSON.stringify(body), { status: 200 }));   // a canned 200 + body
const res = await fetchOverpass(bbox, "https://example/api",
                                fakeFetch as unknown as typeof fetch);  // ← injected here
expect(res.elements).toHaveLength(1);
expect(fakeFetch).toHaveBeenCalledOnce();
const call = fakeFetch.mock.calls[0];
expect(call[0]).toBe("https://example/api");              // assert the URL it called
expect((call[1] as RequestInit).method).toBe("POST");     // assert it POSTed
```

The fake is a `vi.fn()` returning a real `Response` object — so the *parsing* code runs for
real against a real `Response`, only the *transport* is faked. And because `vi.fn` records
its calls, the test asserts not just the parsed output but *how* `fetch` was called — URL
and POST method. You're testing the request-building, not just the response-handling.

**Part 2 — the retry matrix: the genuinely valuable thing this unlocks.** Retry logic is
notoriously under-tested because you can't make a real server return a 504 on demand. With
an injected fetch you script the exact failure sequence. flattr tests all four cases:

```ts
// pipeline/overpass.test.ts — the full retry matrix (annotated)

// :29  400 is non-retryable → throws WITHOUT retrying
const f400 = vi.fn(async () => new Response("bad", { status: 400 }));
await expect(fetchOverpass(bbox, url, f400, { delayMs: 0 })).rejects.toThrow(/400/);
expect(f400).toHaveBeenCalledOnce();          // ← proves it did NOT retry a client error

// :37  504 is transient → retries once, then succeeds
let n = 0;
const f504 = vi.fn(async () => { n++;
  return n === 1 ? new Response("busy", { status: 504 })
                 : new Response(JSON.stringify({elements:[]}), { status: 200 }); });
await fetchOverpass(bbox, url, f504, { delayMs: 0 });
expect(f504).toHaveBeenCalledTimes(2);        // ← proves it retried exactly once

// :49  429 persists → gives up after exhausting retries
const f429 = vi.fn(async () => new Response("rate", { status: 429 }));
await expect(fetchOverpass(bbox, url, f429, { retries: 2, delayMs: 0 })).rejects.toThrow(/429/);
expect(f429).toHaveBeenCalledTimes(3);        // ← initial + 2 retries, then gives up
```

Read the matrix as a decision table:

```
  the retry decision table — each row is a test

  status   class         expected behavior         asserted call count
  ──────   ─────         ─────────────────         ───────────────────
  200      success       parse & return            1   (overpass.test.ts:18)
  400      client error  throw, do NOT retry       1   (:29)
  504      transient     retry, then succeed       2   (:37)
  429      rate limit    retry to exhaustion, fail 3   (:49, retries:2)
```

The call-count assertion is the load-bearing one: `toHaveBeenCalledOnce()` on the 400 case
*proves* the code distinguishes retryable from non-retryable — you can't fake that with a
real server.

**Part 3 — `delayMs: 0` kills the only source of slowness/flake left.** Retry logic has
backoff waits. In production those are real `setTimeout`s; in tests they'd add seconds and
nondeterminism. Every retrying call passes `{ delayMs: 0 }`:

```ts
// pipeline/elevation.test.ts:58  (annotated)
const p = openMeteoProvider(fakeFetch as unknown as typeof fetch, { delayMs: 0 });
//                                                                   ▲
//                          retry logic runs; the BACKOFF WAIT is zeroed → instant, no flake
```

So the retry *behavior* (does it back off and try again?) is tested while the retry *time*
(how long it waits) is eliminated. That's why the whole 22-file suite finishes in 306ms with
zero flake (`audit.md` lens 4).

**Part 4 — a provider abstraction makes the fake even cleaner.** Elevation goes one level
further: the code is written against a `provider` interface, so a test can inject a plain
object instead of even a fake fetch:

```ts
// pipeline/elevation.test.ts:81-90  (annotated — fixtureProvider / inline provider)
const provider = {
  async sample(pts) { calls.push(pts.length); return pts.map((_, i) => 1000 + i); }
};
const out = await sampleElevations(nodes, provider, { dedupePrecision: 0.0008 });
expect(calls[0]).toBe(2);   // ← asserts the DEDUP logic queried 2 unique cells, not 3 nodes
```

Here the injected double isn't even a fetch — it's the whole provider — so the test can
assert flattr's *dedup* logic (collapse nodes in the same ~90m cell to one query) without
any HTTP at all. Same pattern, higher seam.

### Move 2 variant — the load-bearing skeleton

Strip injected-fetch isolation to its kernel:

1. **The I/O dependency is a parameter, not a global** — `fetch` passed in. *Remove it*
   (call global `fetch` directly) and the test is forced onto the real network: slow, flaky,
   rate-limited, untestable retry logic.
2. **The double returns realistic shapes** — a real `Response`, the real JSON the API sends.
   *Make it too fake* (return a bare object) and the parsing code never runs, so the test
   proves nothing about parse correctness.
3. **Time is controllable** — `delayMs: 0`. *Remove it* and retry tests either take real
   seconds or go nondeterministic.

The part people forget is **asserting the call shape, not just the return value**. A weak
version of this pattern checks only the parsed output and never inspects `fetch.mock.calls`
— so it can't tell a retry from a non-retry, or a correct Overpass query from a wrong one.
flattr asserts both sides of the seam: what went in (`call[0]`, `call[1].method`,
`toHaveBeenCalledTimes`) and what came out.

**Skeleton vs hardening:** the kernel is inject + realistic-double + controllable-time. The
provider abstraction (Part 4) is hardening — a cleaner seam — but plain injected fetch is
already the pattern.

### Move 3 — the principle

**Push every uncontrollable dependency to a parameter at the boundary, and the boundary
becomes a place you can stand.** Networks, clocks, randomness, the filesystem — anything the
test can't control is something it can't test *around* until you inject it. Once injected,
the hard-to-test behaviors (retry, backoff, batching, dedup, error classification) turn into
plain deterministic units. This is the same determinism discipline as the seeded RNG in
`02-property-invariant-tests.md`, applied to I/O instead of randomness — and it's exactly
the seam an LLM client would slot into if flattr grew an AI feature (`audit.md` lens 6).

---

## Primary diagram

```
  INJECTED-FETCH ISOLATION — full recap

  ┌─ pipeline code (overpass.ts / elevation.ts) ───────────────┐
  │  fetchOverpass(bbox, url, fetch, opts)                      │
  │      build query → call fetch → classify status → retry?   │
  │      → parse Response → return                              │
  └─────────────┬───────────────────────────┬──────────────────┘
                │ fetch param                │ delayMs / retries opts
                ▼                            ▼
  ┌─ TEST controls the seam (vi.fn) ───────────────────────────┐
  │  scripts the response per call:                            │
  │    200 → parse & assert output + assert URL/method         │
  │    400 → assert throws, called ONCE (no retry)             │
  │    504 → assert retried, called TWICE                      │
  │    429 → assert exhausted, called 3× (initial + 2)         │
  │  delayMs:0 → retry logic runs, backoff wait eliminated     │
  └─────────────────────────────────────────────────────────────┘
        result: zero sockets · zero flake · 306ms whole suite
```

---

## Elaborate

This is dependency injection used as a *test seam* — the cleanest application of the
technique. The double here is specifically a **mock** (it records calls, and assertions
check those calls: `toHaveBeenCalledTimes`) layered over a **stub** (it returns canned
data). The retry matrix is **contract testing** of flattr's side of the HTTP contract: "on
504 we retry, on 400 we don't" is a contract, and the test pins it.

It connects straight to the **`study-networking`** sibling guide, which owns the *why* of
the retry/backoff/idempotency semantics this pattern *tests*. The seam also generalizes:
the provider abstraction in elevation (`fixtureProvider`, `googleProvider`,
`openMeteoProvider` all implementing one `sample` interface) is the same shape you'd use to
swap an LLM provider — which is why the AI-eval seam (`audit.md` lens 6) notes the
infrastructure is already here even though the AI feature isn't.

Where to read next: `02-property-invariant-tests.md` (determinism, applied to RNG), and
`study-networking` for retry/timeout semantics.

---

## Interview defense

**Q: "How do you test code that calls an external API with retries?"**

> "I inject `fetch` as a parameter — production passes the global, tests pass a `vi.fn`
> double that returns canned `Response` objects. That lets me script the exact failure
> sequence: a 504 then a 200, and I assert `fetch` was called twice — it retried. A 400, and
> I assert it was called *once* — it correctly did not retry a client error. A persistent
> 429 with `retries: 2`, and I assert three calls then a throw. I pass `delayMs: 0` so the
> backoff runs but doesn't wait, keeping it instant and deterministic. That's
> `overpass.test.ts:29-55`."

```
  sketch while you talk:

  fetch param ─► vi.fn scripts status per call
       │
   200→parse  400→throw,1×  504→retry,2×  429→exhaust,3×
                    │
            assert mock.calls count = the retry contract
```

**Anchor:** *"The injected double lets me assert the call count — and the call count is how
I prove it distinguishes retryable from non-retryable, which you can't fake with a real
server."*

**Q: "Why not just hit the real API in a test?"** Slow, flaky, rate-limited — the project
context literally warns Open-Meteo 429s under heavy testing. A test that depends on a third
party's uptime isn't testing your code; it's testing their server.

---

## See also

- `02-property-invariant-tests.md` — the same determinism discipline applied to randomness
- `04-fixture-driven-graph-tests.md` — the no-mock half of flattr's testing (real fixtures)
- `audit.md` lens 4 (determinism), lens 5 (error paths), lens 6 (the AI seam this prefigures)
- sibling guide **`study-networking`** — retry/backoff/timeout semantics this pattern tests
