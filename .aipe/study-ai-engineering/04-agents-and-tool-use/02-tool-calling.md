# Tool calling — N/A: if an agent existed, geocode/route would be the tools

**Industry name(s):** tool calling / function calling.
**Type:** Industry standard.

## Zoom out — flattr has no LLM to call tools, but its functions are tool-shaped already

Tool calling is the protocol where an LLM emits a structured request to
run a function, your code runs it, and you hand the result back. flattr
has no LLM, so nothing emits tool calls. But the *functions an agent would
call* already exist as clean, typed, side-effect-bounded operations:
`geocode` (text → coordinate), `nearestNode` (point → node),
`directedAstar` (nodes → path). They're tool-shaped — they just have no
brain calling them.

```
  Zoom out — flattr's tool-shaped functions (no caller-LLM)

  ┌─ (NOT BUILT) agent / LLM ───────────────────────────────┐
  │  would emit: { tool: "geocode", input: { query } }       │
  │  ★ NOTHING emits tool calls — no LLM in flattr           │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine functions (tool-shaped) ▼ ───────────────────────┐
  │  geocode(query) → {lat,lng,label}        geocode.ts:9    │
  │  nearestNode(point) → nodeId             nearest.ts:5    │
  │  directedAstar(g,a,b,max) → SearchResult astar.ts        │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** (would-be) LLM caller → typed engine functions.
- **Axis — who invokes the function?** With tool calling: the LLM
  *requests* it, your code *runs* it. In flattr: the code calls it
  directly, no request step. The axis (who initiates the call) never
  involves a model.
- **Seam:** the function signatures themselves (`geocode.ts:9`,
  `nearest.ts:5`, `astar.ts`). These are the natural tool boundaries —
  typed in, typed out — but no tool-calling protocol sits above them.

## How it works

### Move 1 — the mental model

Tool calling is "the LLM is the brain, your functions are the hands."
The brain can't run anything itself — it emits a structured request
("call `geocode` with this query"), your code executes the function and
reports the result back, and the brain decides what's next. flattr has
hands and no brain: the functions are there, the *code* calls them
directly, and there's no model in the loop to issue requests.

```
  Pattern — tool calling (LLM requests, code runs)

  LLM ──emits──► { tool, input } ──► YOUR CODE runs it ──► result ──► LLM
        ▲ flattr has no LLM emitting this
  flattr: CODE calls geocode(query) directly — no request, no brain
```

### Move 2 — the walkthrough

**What a flattr "tool" would look like.** `geocode.ts:9` is already a
textbook tool: typed input, typed output, one job.

```ts
export async function geocode(query: string, opts = {}): Promise<GeocodeResult | null> {
  // ... fetch Nominatim ...
  return { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon), label: rows[0].display_name };
}
```

To make this a tool you'd wrap it with a schema declaration — name
`geocode`, input `{ query: string }`, output `GeocodeResult` — and let an
LLM emit `{ tool: "geocode", input: { query: "..." } }`. The function body
doesn't change; you add a calling convention on top. `nearestNode` and
`directedAstar` are the same story: clean signatures ready to be declared
as tools.

```
  Layers-and-hops — the tool-call loop that DOESN'T exist in flattr

  ┌─ (NOT BUILT) LLM ─┐ hop1: {tool:"geocode",input}  ┌─ code ────┐
  │                   │ ──────────────────────────────►│ run it    │
  │                   │ ◄──────────────────────────────│ result    │
  └───────────────────┘ hop2: GeocodeResult            └───────────┘
   today: this loop is absent — code calls geocode() directly
```

**The boundary condition.** Two honest points. (1) The geocode tool
returns `display_name` (`geocode.ts:27`), which is *untrusted OSM text* —
if it flowed back into a prompt, that's a prompt-injection surface; tool
*outputs* are an injection vector, not just tool inputs. (2) Tool calling
only earns its place if there's an LLM deciding *which* tool to call from
ambiguous input. flattr's flow is fixed (geocode, then route, always), so
even with an LLM you'd more likely have a chain than tool-calling — the
order is known, so there's nothing for the model to choose.

### Move 3 — the principle

Tool calling is the brain/hands split — the LLM reasons and requests,
deterministic code executes and reports. The functions are the durable
part; the tool-calling protocol is a thin, swappable layer on top. flattr
proves the functions can be perfectly tool-shaped (typed, single-purpose)
without any tool-calling at all. The principle: design functions as if
they'll be tools — typed, one job, bounded side effects — and adding the
tool layer later is cheap.

## Primary diagram

```
  flattr's functions are tool-shaped; the calling layer is absent

  ┌─ (NOT BUILT) LLM tool-call loop ─────────────────────────┐
  │ LLM emits {tool,input} → code runs → result → LLM         │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine functions (BUILT, tool-shaped) ▼ ────────────────┐
  │ geocode (geocode.ts:9)  ·  nearestNode (nearest.ts:5)     │
  │ directedAstar (astar.ts)  ·  typed in, typed out          │
  │ ⚠ geocode output (display_name) is untrusted → injection  │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Tool calling is how LLMs reach beyond text into the real world — search,
write, compute. The discipline that makes it safe is exactly good function
design: typed contracts and bounded side effects, so the model can't do
anything the function wouldn't let any caller do. flattr's engine
functions already meet that bar without an LLM. The transferable insight:
the hard part of tool use is the *functions and their trust boundaries*,
not the calling protocol — and flattr's untrusted `display_name` output is
a concrete example of a tool-output trust boundary.

## Interview defense

**Q: How would tools work in flattr?** Answer: there's no LLM, so no tool
calls — but the functions are already tool-shaped: `geocode`
(`geocode.ts:9`), `nearestNode` (`nearest.ts:5`), `directedAstar`
(`astar.ts`), each typed in and out. To make them tools you'd add a schema
declaration and let an LLM emit `{tool, input}`; the bodies stay the same.
Two things to flag: the route flow is fixed, so you'd likely want a chain
not tool-calling; and `geocode`'s `display_name` output is untrusted OSM
text — a tool-*output* injection vector. Load-bearing point: tool calling
is a thin layer over functions; flattr's functions already satisfy it.

```
  declare geocode/route as tools → LLM emits {tool,input} → code runs them
```

Anchor: *"flattr's functions are already tool-shaped — typed, one job; the
only missing piece is an LLM to call them, and its flow is fixed enough to
prefer a chain."*

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — why flattr's flow is a chain, not an agent.
- [04-tool-routing.md](04-tool-routing.md) — which tool to call; flattr's selection is heuristic.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — `display_name` as a tool-output injection vector.
