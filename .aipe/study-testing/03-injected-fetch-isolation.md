# 03 — Injected-Fetch Network Isolation

**Industry names:** dependency injection · seam-based testing · the
"humble object" / functional core–imperative shell · fake-at-the-boundary.
**Type:** Industry standard.

---

## Zoom out — where this lives

The build pipeline talks to three external APIs (Overpass for OSM, Open-Meteo /
Google for elevation, Nominatim for geocoding). Tests for this layer never touch
the real network — every I/O function takes its `fetch` as a parameter, and
tests pass a fake.

```
  Zoom out — the network seam, faked in tests

  ┌─ pipeline layer (build-time I/O) ───────────────────────────┐
  │  fetchOverpass(bbox, url, ★fetch★)                          │
  │  openMeteoProvider(★fetch★)   geocode(q, {★fetchImpl★})     │ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
                  real run │       │ test run
            ┌──────────────▼──┐  ┌─▼──────────────────┐
            │ global fetch    │  │ vi.fn() fake fetch  │
            │ → Overpass API  │  │ → canned Response   │
            └─────────────────┘  └─────────────────────┘
```

Zoom in: the function never reaches for a module-level `fetch`. It accepts one.
In production you hand it the real `fetch`; in tests you hand it a `vi.fn()` that
returns a canned `Response`. The exact same code path runs both times — the only
thing that changes is what's behind the seam.

---

## Structure pass

**Layers:** the pipeline logic (parse, retry, batch) on top; the network
transport underneath. The `fetch` parameter is the horizontal seam between them.

**Axis — "where does the non-determinism come from, and is it inside or outside
the seam?"**

```
  axis = "is this part deterministic?"

  ┌─ pipeline logic ─┐  seam (fetch param)  ┌─ network ──────────┐
  │ DETERMINISTIC    │ ════════╪═══════════► │ NON-DETERMINISTIC  │
  │ parse, retry,    │      (flips)          │ latency, 429s,     │
  │ batch, dedup     │                       │ quota, outages     │
  └──────────────────┘                       └────────────────────┘
         ▲ test THIS                              ▲ fake THIS away
```

The axis flips at the `fetch` parameter: everything above it is deterministic
and worth testing; everything below it is non-deterministic and gets replaced.
This is the same determinism seam the README draws between testing and AI evals
— here it's drawn between *your logic* and *the network*.

**Seam:** the `fetch` / `fetchImpl` parameter on every I/O function.

---

## How it works

### Move 1 — the mental model

You've passed a callback into a function so the caller controls part of the
behavior — `arr.map(fn)`. Injecting `fetch` is the same: the function does the
parsing and retry logic, but *you* supply how bytes arrive. In tests, "how bytes
arrive" is a function that returns whatever Response you want, instantly.

```
  the seam — same logic, swappable transport

         ┌──────────────────────────────┐
   call ─┤  fetchOverpass(bbox, url, F)  │
         │   F(url, init) → Response      │── parse ── retry ──► result
         └──────────────┬───────────────┘
                        │ F is...
            real:  global fetch  ───►  Overpass
            test:  vi.fn()       ───►  canned Response (no network)
```

### Move 2 — the walkthrough

**The parameter, not the import.** Every pipeline I/O function takes `fetch`:

```ts
// overpass.ts signature (tested at overpass.test.ts:21)
fetchOverpass(bbox, url, fetch, opts?)
// elevation.ts (tested at elevation.test.ts:33, :58)
googleProvider(key, fetch)    openMeteoProvider(fetch, opts?)
// geocode.ts (tested at geocode.test.ts:12)
geocode(query, { fetchImpl })
```

The test hands in a `vi.fn()` that returns a real `Response` object — not a mock
of Response, the actual web `Response`, so the parsing code under test runs for
real:

```ts
// overpass.test.ts:18-27 — fake fetch, real Response, real parsing
const body: OverpassResponse = { elements: [{ type: "node", id: 1, lat: 47.6, lon: -122.33 }] };
const fakeFetch = vi.fn(async (_url, _init?) =>
  new Response(JSON.stringify(body), { status: 200 }));
const res = await fetchOverpass(bbox, "https://example/api", fakeFetch as ...);
expect(res.elements).toHaveLength(1);
expect(fakeFetch).toHaveBeenCalledOnce();
const call = fakeFetch.mock.calls[0];
expect((call[1] as RequestInit).method).toBe("POST");   // ← assert the REQUEST
```

The fake isn't just a stand-in — it's an *observation point*. The test asserts
on what was *sent* (POST method, the URL, the query string) as well as what
comes back. That's the seam earning its keep in both directions.

**The payoff: deterministic testing of non-deterministic network behavior.**
The retry/backoff logic is pure control flow once you control the responses.
The fake fetch can return a 504 *then* a 200 to drive the retry path:

```ts
// overpass.test.ts:37-47 — transient 504 → retry → success, NO real network
let n = 0;
const fakeFetch = vi.fn(async () => {
  n++;
  return n === 1 ? new Response("busy", { status: 504 })
                 : new Response(JSON.stringify({ elements: [] }), { status: 200 });
});
const res = await fetchOverpass(bbox, "...", fakeFetch, { delayMs: 0 });
expect(fakeFetch).toHaveBeenCalledTimes(2);   // retried exactly once
```

`delayMs: 0` is the second half of the isolation: the retry *delay* is also
injected, so the test doesn't actually sleep. Real backoff, zero wall-clock.
The full retry matrix (`overpass.test.ts:29-55`) is then trivially testable:
400 → no retry (called once), 504 → retry then succeed, persistent 429 → give up
after exact count. None of it touches a real server. → this is why `audit.md`
lens 4 (flakiness) and lens 5 (error paths) both come back clean.

```
  retry behavior, driven entirely by the fake

  fake returns:   404 ──► throw, 1 call      (not retryable)
                  504,200 ─► 2 calls         (transient → retry)
                  429,429,429 ─► throw, 3 calls (give up at limit)
                  delayMs:0 ──► no real sleep ever
```

**Same pattern, every API.** `elevation.test.ts:53` drives Open-Meteo batching
(150 points → exactly 2 calls of 100+50) by inspecting the fake's URL params;
`geocode.test.ts:12` asserts the Nominatim query encoding (`q=space+needle`) and
the no-results→null branch. One discipline, applied uniformly across the I/O
surface.

### Move 2 variant — the load-bearing skeleton

```
  I/O function with the transport as a PARAMETER
  +  a fake transport that returns canned responses
  +  injected timing (delayMs) so retries don't sleep
  +  assertions on BOTH the request sent and the response handling
```

What breaks without each:

- **Hard-code `fetch` instead of injecting** → the test must hit the real API:
  slow, flaky, quota-limited (the Open-Meteo 429-on-heavy-testing caveat in
  `context.md` is exactly this failure). The whole suite would be
  network-dependent.
- **Mock `Response` instead of using the real one** → you test your mock's
  shape, not the real parsing — the classic "tests the mock, not the code" smell
  (`audit.md` lens 2 marks this CLEAR *because* real Response is used).
- **Don't inject `delayMs`** → retry tests sleep for real backoff durations,
  slowing the suite and adding timing flake.
- **Only assert the response, not the request** → you'd miss a bug that sends
  the wrong bbox order or HTTP method.

### Move 3 — the principle

**Push non-determinism to the edge and inject it, so your logic stays a pure
function of its inputs.** This is the functional-core / imperative-shell split:
the parsing, retrying, and batching is the testable core; the network is the
shell, handed in as a parameter. The same move works for the system clock
(inject `now()`), randomness (inject the seed — see `02`), and the filesystem.
Anything non-deterministic becomes a parameter, and your test controls it.

---

## Primary diagram

```
  the injected-fetch discipline across the pipeline

  ┌─ pipeline functions (DETERMINISTIC, all tested) ────────────┐
  │  fetchOverpass · openMeteoProvider · googleProvider ·       │
  │  geocode · reverseGeocode · geocodeSuggest                  │
  │         each takes  fetch  +  delayMs  as parameters         │
  └───────────────────────────┬─────────────────────────────────┘
              prod │           │ test
       ┌───────────▼───┐   ┌───▼──────────────────────────┐
       │ global fetch  │   │ vi.fn() → canned Response     │
       │ real backoff  │   │ delayMs:0 → no sleep          │
       │ → live APIs   │   │ → asserts request AND response│
       └───────────────┘   └───────────────────────────────┘

  result: 307ms suite, zero network, full retry/error coverage
```

---

## Elaborate

This is dependency injection at the function level (no DI container, just
parameters) and the "humble object" pattern (Feathers / Fowler) — keep the
hard-to-test boundary (network) thin and dumb, move all logic into a testable
core. The honest gap: the *mobile* runtime re-runs these same functions but
*doesn't* preserve the seam — `mobile/src/useTileGraph.ts` calls
`openMeteoProvider(fetch, ...)` with the real `fetch` closed over inside a React
hook, so the hook's own orchestration (degraded fallback, self-heal retry) can't
be tested the way the pipeline can. The pattern exists and works; it just stops
at the mobile boundary. → `audit.md` lens 1 & 3, and the buildable target in
lens 7: a hook test that injects a fake fetch the same way the pipeline tests do.

---

## Interview defense

**Q: How do you test code that calls an external API without hitting it?**

> Inject the transport. Every I/O function in flattr's pipeline takes `fetch` as
> a parameter (`overpass.test.ts:21`), so in tests I pass a `vi.fn()` returning a
> canned `Response` — the real Response object, so the parsing runs for real.
> The function's logic is then a pure function of its inputs.

```
  fetchOverpass(bbox, url, FAKE) → canned Response → parse/retry → assert
```

**Q: How do you test retry/backoff without waiting for real timeouts?**

> Inject the delay too. `delayMs: 0` makes the backoff instant, and the fake
> fetch returns `504` then `200` to drive the retry path — I then assert it was
> called exactly twice (`overpass.test.ts:37`). Real retry logic, zero
> wall-clock. Anchor: "anything non-deterministic — network, clock, randomness —
> becomes a parameter the test controls."

---

## See also

- `02-property-invariant-tests.md` — injecting the *seed* is the same move for
  randomness.
- `04-fixture-driven-graph-tests.md` — the deterministic graph inputs paired
  with this.
- `audit.md` lens 2 (no over-mocking), lens 3 (design pressure), lens 4 (flake).
- siblings `study-networking` (the retry/backoff semantics),
  `study-software-design` (DI as a deep-module property).
