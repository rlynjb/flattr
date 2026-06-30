# Provider abstraction

**Industry name(s):** provider abstraction / model factory /
`getModel(provider)` / the inference adapter. **Type:** Industry standard
seam.

## Zoom out — where this would sit in flattr

When you call a model you call it *through* an interface, not a hard-coded
SDK: `getModel(provider).complete(prompt)`. That one seam lets you swap
on-device for cloud, OpenAI for Anthropic, mock for real, without touching
callers. flattr has **no provider layer** because it has no model at all.
But it is local-first Expo — so if a route-describe call is added, the
factory's *default* should be on-device (dryrun-style) with a cloud
*fallback*, and that factory is exactly the seam the call site would talk
to.

```
  Zoom out — the factory the describe call would talk to

  ┌─ engine ────────────────────────────────────────────────┐
  │ routeSummary() ─► RouteSummary {distanceM,climbM,steep}  │
  └────────────────────────────┬─────────────────────────────┘
                              │ summary.ts:5
  ┌─ ★ would-be call site ────▼─────────────────────────────┐
  │ const model = getModel();        ◄── the abstraction     │
  │ const blurb = await model.describe(summary);             │
  └────────────────────────────┬─────────────────────────────┘
                  ┌────────────┴────────────┐
            ┌─────▼──────┐            ┌──────▼─────┐
            │ on-device  │  default   │ cloud      │ fallback
            │ (dryrun)   │            │ (Anthropic)│
            └────────────┘            └────────────┘
```

flattr has **no provider abstraction**. The lesson: the moment you add the
first model call, route it through a factory so on-device-first is a config
choice, not a rewrite.

## Structure pass

- **Layers:** call site (engine/UI) → provider factory → concrete backend
  (on-device | cloud | mock).
- **Axis — trust/cost/availability:** on-device is private, free per call,
  and offline-capable but limited; cloud is more capable but costs tokens,
  needs network, and ships your prompt off-device. The factory is where you
  trade these. The axis flips from "local, free, private" to "remote, paid,
  networked" depending on which backend the factory returns.
- **Seam:** the abstraction *is* the seam — `getModel()` at the describe
  call site (adjacent to `MapScreen.tsx:159`). Callers depend on the
  interface; the factory picks the backend.

## How it works

### Move 1 — the mental model

You know dependency injection: callers depend on an interface, a factory
supplies the implementation, and you swap implementations without touching
callers. Provider abstraction is DI for models — `Model` is the interface
(`describe(summary): Promise<string>`), `getModel()` is the factory, and
on-device / cloud / mock are implementations.

```
  Pattern — one interface, swappable backends

  caller ─► getModel() ─► Model interface { describe(summary) }
                              ▲     ▲     ▲
                  ┌───────────┘     │     └───────────┐
            ┌─────┴─────┐    ┌──────┴─────┐    ┌──────┴─────┐
            │ OnDevice  │    │  Cloud     │    │  Mock      │
            │ (dryrun)  │    │ (Anthropic)│    │ (tests)    │
            └───────────┘    └────────────┘    └────────────┘
```

### Move 2 — the walkthrough

**No model means no factory — but the call site is known.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

A describe call would sit at `MapScreen.tsx:159` next to `routeSummary`.
Instead of importing an SDK there, it would call `getModel().describe(summary)`.
The call site never names a provider; the factory does.

```
  Layers-and-hops — caller depends on interface, not SDK

  ┌─ call site ──┐ getModel()  ┌─ factory ──┐  picks  ┌─ backend ──┐
  │ MapScreen:159 │ ─────────► │ env/config │ ──────► │ on-device  │
  │ describe(sum) │            └────────────┘         │ or cloud   │
  └──────────────┘                                    └────────────┘
        (swap backend = change factory config, not the call site)
```

**Local-first → on-device default.** flattr already runs offline-capable
Expo; the natural default backend is on-device (the dryrun pattern: Gemini
Nano / on-device model), with cloud as a *fallback* when the device model
is unavailable or the task is too hard. That choice keeps prompts private,
cost zero ([06-token-economics.md](06-token-economics.md)), and the app
working offline — all properties flattr already values.

**Why the abstraction matters even for one call.** The geocoding layer
already shows flattr's instinct here: `geocode()` takes a `fetchImpl`
(`geocode.ts:11`) so the network client is injectable for tests. A model
factory is the same move at the model boundary — inject a `Mock` model in
tests, on-device in prod, cloud on fallback. Without it, the SDK leaks into
the call site and every test needs a real model.

### Move 3 — the principle

Call models through a factory so the backend is a config decision, not a
code change. For flattr — local-first — the factory's default is
on-device, cloud is fallback, mock is test. The same injectability flattr
already uses for `fetchImpl` belongs at the model boundary.

## Primary diagram

```
  Provider abstraction — the seam flattr would add with its first call

  ┌─ call site: MapScreen.tsx:159 (NOT BUILT) ──────────────┐
  │ const blurb = await getModel().describe(summary)         │
  └────────────────────────────┬─────────────────────────────┘
                          getModel() factory
                  ┌────────────┼────────────┐
            ┌─────▼─────┐ ┌────▼─────┐ ┌─────▼─────┐
            │ OnDevice  │ │ Cloud    │ │ Mock      │
            │ default   │ │ fallback │ │ tests     │
            │ (dryrun)  │ │(Anthropic)│ │(geocode   │
            │ free,priv │ │ paid,net │ │ fetchImpl │
            └───────────┘ └──────────┘ │ analogue) │
                                       └───────────┘
```

## Elaborate

A good provider interface is *narrow* — `describe(summary): Promise<string>`
or `complete(prompt, opts)` — so backends are easy to implement and mock.
It also normalizes the differences (token limits, streaming support,
structured-output APIs) behind one shape. The danger is a leaky abstraction
that exposes provider-specific quirks; keep it thin. In Rein's portfolio,
dryrun already does on-device-default + cloud-fallback; porting that factory
into flattr's `MapScreen.tsx:159` call site is a near-direct lift.

## Project exercises

### B-PA.1 — the model interface + mock

- **Exercise ID:** B-PA.1
- **What to build:** a `Model` interface (`describe(summary):
  Promise<string>`) and a `getModel()` factory returning a `MockModel`
  (templated string), mirroring how `geocode` accepts an injectable
  `fetchImpl`.
- **Why it earns its place:** it builds the swap seam before any real
  backend, keeping the describe call site provider-agnostic.
- **Files to touch:** new `features/routing/model.ts`;
  `mobile/src/MapScreen.tsx:159` (call site); compare
  `pipeline/geocode.ts:11` (fetchImpl injection).
- **Done when:** the call site uses `getModel()`, a test injects the mock.
- **Estimated effort:** 1–2 hrs.

### B-PA.2 — on-device default, cloud fallback

- **Exercise ID:** B-PA.2
- **What to build:** extend `getModel()` to return an on-device backend by
  default and a cloud backend on fallback (stubbed), encoding flattr's
  local-first policy.
- **Why it earns its place:** it makes the local-first default explicit at
  the factory, matching the dryrun pattern.
- **Files to touch:** `features/routing/model.ts`; config in
  `mobile/src/MapScreen.tsx` (where the call resolves).
- **Done when:** default is on-device, fallback is cloud, both behind the
  interface; a test covers selection.
- **Estimated effort:** 2 hrs.

## Interview defense

**Q: How would flattr call a model without coupling to a vendor?** Answer:
Through a `getModel()` factory returning a narrow `Model` interface, the
same way `geocode` takes an injectable `fetchImpl` (`geocode.ts:11`). The
call site at `MapScreen.tsx:159` calls `getModel().describe(summary)` and
never names a provider. Because flattr is local-first, the default backend
is on-device (dryrun-style) with cloud as fallback and a mock for tests —
swapping is config, not a rewrite.

```
  call site → getModel() → { on-device default | cloud fallback | mock }
```

Anchor: *"flattr has no provider layer; the first model call should go
through a getModel() factory at MapScreen.tsx:159, on-device by default —
local-first."*

## See also

- [06-token-economics.md](06-token-economics.md) — on-device = $0 marginal.
- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — the lane the escalation picks.
- [04-structured-outputs.md](04-structured-outputs.md) — the interface returns typed output.
