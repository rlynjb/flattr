# The router-as-agent-tool seam (the one place an agent would attach)

**Industry name(s):** tool calling / function calling — wrapping an existing
deterministic function as a tool an LLM agent can invoke. **Type label:**
Industry standard.

> **State: `not yet exercised`.** There is no agent and no tool registry in
> this repo. But there is exactly **one** real place an agent could ever attach
> — the spec names it: *"a 'describe my route' or natural-language destination
> parse — out of scope now"* (`docs/flattr-spec.md` §8, line 254) and *"the LLM
> destination parser. All later."* (§13, line 380). This file walks that single
> seam concretely: which existing functions become the tool, what the agent
> would consume and feed, and the one risk that bolting an LLM onto a router
> introduces. Every "would attach" claim below is grounded in a real file and
> line range.

---

## Zoom out — the seam, and the trust boundary it opens

Today the engine is a closed deterministic pipeline. The future agent doesn't
go *inside* it — it sits *above* the UI, turns free text into the structured
inputs the engine already accepts, and reads the structured output back. That
"above the UI" band is a new provider layer, and it's a new trust boundary:
untrusted user prose now reaches a model that decides which tool to call.

```
  Zoom out — where the agent layer would attach (planned, gated)

  ┌─ Provider layer — DOES NOT EXIST (planned) ──────────────────┐
  │  [gated]  LLM agent: parse "flat route to the library" →      │
  │           decides: call route(from, to, userMax) tool         │
  │           ── NEW TRUST BOUNDARY: user prose → model ──         │
  └───────────────────────────┬───────────────────────────────────┘
                              │  structured (from, to, userMax)
  ┌─ UI layer (Expo / RN) ────▼───────────────────────────────────┐
  │  ★ mobile/src/AddressBar.tsx ★  (free-text input lives here)   │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Engine layer (the TOOL, unchanged) ──────▼───────────────────┐
  │  pipeline/geocode.ts:9 geocode()  →  features/routing/astar.ts │
  │  → ★ features/routing/summary.ts:11 routeSummary() ★ (output)  │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in.** Tool calling is the seam where a model emits *intent* ("call
`route` with these args") and your harness runs the actual function. The
flattr router is an unusually clean tool candidate: it's already a pure
function with typed inputs and a typed summary output. Wrapping it is mostly
writing a JSON schema around `search()` + `routeSummary()` — the hard part
isn't the wrapping, it's the new trust boundary the model introduces.

---

## How it works — wrapping a pure function as a tool

### Move 1 — the mental model

You've called a typed function before: `routeSummary(graph, path, userMax)`
returns `{ distanceM, climbM, steepCount }`. A tool is that same function with
a JSON-schema description wrapped around it so a model knows it exists, what
args it takes, and what it returns. The model never runs the function — it
*asks* your code to, by name, and your code runs it and hands back the result.

```
  Pattern — the model emits intent, the harness runs the tool

  user prose ──► ┌─ LLM agent ──────────────┐
                 │ "I should call route(...)"│  ← model decides (intent only)
                 └───────────┬───────────────┘
                             │ tool_call: route{from,to,userMax}
                 ┌───────────▼───────────────┐
                 │ HARNESS (your code)        │  ← runs the real function
                 │ geocode → search → summary │
                 └───────────┬───────────────┘
                             │ result: {distanceM, climbM, steepCount}
                 ┌───────────▼───────────────┐
                 │ LLM agent observes result  │  ← reasons / replies / re-calls
                 └────────────────────────────┘
```

### Move 2 — the parts of the seam, in this repo

**The tool definition — schema around an existing function.**
The tool is the existing route computation. Its input schema is exactly what
the engine already takes: `from` and `to` strings (geocoded via
`pipeline/geocode.ts:9` `geocode()`), and `userMax` (the single grade knob the
whole system keys off). Its output schema is exactly `RouteSummary` —
`{ distanceM, climbM, steepCount }` from `features/routing/summary.ts:5`. **No
engine code changes** to expose this; you write a JSON schema describing
functions that already exist and return already-typed values.

```
  Layers-and-hops — the NL request, hop by hop (planned)

  ┌─ Provider ─┐ hop 1: prose "flat way to the park"  ┌─ Harness ──┐
  │  LLM agent │ ─────────────────────────────────────►│ your code  │
  │            │ hop 4: {distanceM,climbM,steepCount} ◄─│            │
  └────────────┘                                        └─────┬──────┘
                                          hop 2: geocode(from),│
                                                  geocode(to)  ▼
                                              ┌─ Engine ───────────┐
                                              │ geocode.ts:9        │
                                              │ → astar.ts:22 search│
                                  hop 3: route ◄ summary.ts:11      │
                                              └─────────────────────┘
```

**The argument-extraction step — what the model is actually for.**
The only thing the model adds that the deterministic app lacks: turning "a flat
route to the library, nothing over a gentle hill" into
`{ from: <current location>, to: "library", userMax: 4 }`. Today
`mobile/src/AddressBar.tsx:29` requires the user to type a literal address into
the From/To fields and pick a `userMax` preset. The model's job is to populate
those same fields from prose — it's a parser feeding the *existing* inputs, not
a new engine.

**The observe step — reading the tool result back.**
The agent gets back `RouteSummary` (`summary.ts:5`) and can reason on it:
"steepCount is 3 — that's not flat; re-call with a lower `userMax`." That
re-call is the loop turning agentic — and it's exactly the contrast from
[`01-control-loop-contrast.md`](01-control-loop-contrast.md): the *outer*
decision (re-route?) becomes model-driven, while the *inner* A\* search stays
the deterministic tool.

**The result-to-UI hop — where the route surfaces.**
The tool's structured result flows back to the same components that render it
today: the route geometry to `MapScreen.tsx`, the summary to
`RouteSummaryCard.tsx`. The agent doesn't draw anything — it produces the same
structured route the deterministic path produces, so the rendering layer is
untouched.

### Move 2.5 — current state vs future state

```
  Comparison — how a route request is shaped, now vs agentic (planned)

  ┌─ NOW (shipped) ───────────────────┐  ┌─ FUTURE (planned, gated) ────────┐
  │ user types literal From/To        │  │ user types free-text prose        │
  │ AddressBar.tsx:29                 │  │ LLM extracts {from,to,userMax}    │
  │ picks userMax preset (GradeSlider)│  │ model picks userMax from intent   │
  │ MapScreen calls geocode → search  │  │ agent CALLS route tool (same fns) │
  │ no model, no trust boundary       │  │ NEW: user prose → model boundary  │
  │ → spec §8: "No LLM layer in v1"   │  │ → spec §13: "LLM destination …"   │
  └───────────────────────────────────┘  └───────────────────────────────────┘
```

**What doesn't have to change — the whole point.** The router, the cost
function, the A\* loop, the graph, and the rendering components all stay
exactly as they are. The agent is purely additive: a parsing/decision layer
above the UI that produces the same structured inputs a human types today. This
is the clean version of "wrap, don't rewrite."

### Move 3 — the principle

A deterministic function with typed inputs and a typed output is the ideal
agent tool: the model supplies *judgment* (parse intent, decide args, decide
whether to re-call), the function supplies *correctness* (the route is computed
by code, not hallucinated). The seam is cheap to build and the engine stays
trustworthy — but the moment user prose reaches the model, you've opened a trust
boundary that didn't exist before, and that's the part that needs the most care,
not the wrapping.

---

## Primary diagram

The full recap: the one seam, what's new, what's reused, and the risk.

```
  Router-as-tool — the single agent seam in flattr (planned, gated)

  ┌─ Provider (NEW, gated) ───────────────────────────────────────┐
  │ LLM agent: prose → extract {from,to,userMax} → call route tool │
  │            observe RouteSummary → reply or re-call             │
  │ ⚠ NEW trust boundary: untrusted prose → model → tool args      │
  └───────────────────────────┬───────────────────────────────────┘
                              │ reuses, does not modify ▼
  ┌─ Engine (UNCHANGED, the tool) ───────────────────────────────┐
  │ geocode.ts:9 → astar.ts:22 search() → summary.ts:11           │
  │ pure functions, typed in, typed RouteSummary out              │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case (today, deterministic).** A user types a literal address into the
From and To fields of `mobile/src/AddressBar.tsx`, taps a `userMax` preset, and
taps Route. `MapScreen.tsx` geocodes both endpoints and runs the search. There
is no model anywhere; the "intent" is fully specified by the form.

**The functions that would become the tool (unchanged).**

```
  features/routing/summary.ts  (lines 5, 11–19) — the tool's OUTPUT schema

  export type RouteSummary =
    { distanceM: number; climbM: number; steepCount: number };  ← tool return schema
  export function routeSummary(graph, path, _userMax): RouteSummary {
    ...
    if (directedRise > 0) climbM += directedRise;  ← uphill total (the product metric)
    return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
  }                                                  ← already typed; no change needed
```

```
  pipeline/geocode.ts  (lines 9–14) — the tool's INPUT resolution

  export async function geocode(
    query: string,                          ← the model would supply this from prose
    opts: { viewbox?: ...; fetchImpl?: ... } = {}
  ): Promise<GeocodeResult | null> {        ← {lat, lng, label}, feeds search()
```

The agent supplies `query` strings; `geocode()` turns them into coordinates;
`search()` (`astar.ts:22`) routes between them; `routeSummary()` produces the
result the agent observes. The wrapping is a schema; the work is already
written.

---

## Elaborate

Tool calling / function calling is how a model takes actions in the world
without being trusted to *perform* them — it emits a structured request, your
code executes it. MCP (Model Context Protocol) standardizes that contract so a
tool defined once is usable across agents. For this repo, the genuinely
important adjacent concern is **not** the mechanics of tool calling — it's the
**trust boundary** the seam opens.

**Cross-link — the injection risk (`.aipe/study-security/`).** Today this app
has no LLM and no prompt-injection surface. The moment the router becomes a
tool, untrusted user prose reaches a model that decides tool arguments. The
attack to reason about: a user (or content reflected through one) crafts input
that manipulates the agent into calling the route tool with attacker-controlled
args, or — worse, if more tools are ever added — into calling a different tool
entirely. The flattr-specific saving grace is that the *only* tool is a
read-only route computation over a static graph with no side effects, so the
blast radius is small today. That stays true only as long as no
side-effecting tool (save, share, account mutation — all named out of scope in
§13) joins the registry. The control envelope (validate extracted args against
a schema before calling the tool; never let model output trigger a side effect
directly) is the security-side concern — walked in `.aipe/study-security/`,
which owns the trust-boundary and injection analysis this seam would create.

The deterministic-router-as-tool pattern is the cleanest on-ramp from a
classical engine to an agentic feature precisely because the tool can't lie:
the route is computed, not generated. Read
[`01-control-loop-contrast.md`](01-control-loop-contrast.md) for why the inner
A\* loop stays deterministic even when the outer loop goes agentic.

---

## Interview defense

**Q: "How would you add a 'describe my route' feature to this app?"**
Wrap the existing router as a tool — don't touch the engine. The model parses
prose into `{from, to, userMax}`, calls a `route` tool backed by
`geocode()` (`geocode.ts:9`) + `search()` (`astar.ts:22`), and observes the
typed `RouteSummary` (`summary.ts:5`). The route is still computed by
deterministic code; the model only supplies the parse and the decision to
re-call.

```
  prose → LLM extract args → route tool (geocode→search→summary) → observe
```

**Q: "What's the new risk that introduces?"**
A trust boundary: untrusted prose now reaches a model that picks tool args.
The mitigation is to validate extracted args against a schema before calling
the tool and never let model output trigger a side effect directly. Today the
only tool is a read-only computation, so blast radius is small — it grows the
moment a side-effecting tool (save/share/account, all §13 out-of-scope) joins.

```
  prose ──► model ──► [validate args] ──► tool   (never model → side effect)
                          ▲
                  the injection gate
```

One-line anchor: *the router is an ideal tool because it's a pure typed
function — the model adds judgment, the function keeps correctness — but the
day user prose reaches the model, you own a new injection boundary.*

---

## Validate

1. **Reconstruct.** Name the two existing functions that become the tool's
   input resolution and output schema. (`pipeline/geocode.ts:9` `geocode()`;
   `features/routing/summary.ts:5` `RouteSummary` / `:11` `routeSummary()`.)
2. **Explain.** Why does wrapping the router as a tool require *no* engine
   changes? (It already has typed inputs and a typed output; the tool is a JSON
   schema over functions that already exist.)
3. **Apply.** The agent gets back `steepCount: 3` and the user asked for flat.
   What should the agent do, and which file's value drives that? (Re-call the
   tool with a lower `userMax`; `summary.ts:5` `steepCount` is the signal. This
   is the outer loop going agentic — see [`01`](01-control-loop-contrast.md).)
4. **Defend.** A teammate wants the agent to also "save favorite routes"
   directly from its output. Why push back? (That adds a side-effecting tool;
   model output triggering a mutation is a prompt-injection liability — validate
   and gate through your code; see `.aipe/study-security/`. Also §13
   out-of-scope.)

---

## See also

- [`00-overview.md`](00-overview.md) — the no-agent verdict and full inventory.
- [`01-control-loop-contrast.md`](01-control-loop-contrast.md) — why the inner
  A\* loop stays deterministic even when the outer loop goes agentic.
- `.aipe/study-security/` — the trust boundary and prompt-injection analysis
  this seam would open (the cross-link this file's risk section points to).
- `.aipe/study-prompt-engineering/` — the prompt that would drive the NL parser
  (not yet generated; sibling of this folder).
- `.aipe/study-ai-engineering/` — tool-calling and function-calling mechanics
  (not yet generated; sibling of this folder).
