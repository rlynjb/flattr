# Structured Outputs
*Structured outputs / constrained decoding — Industry standard*

## Zoom out

A raw LLM hands you a string and wishes you luck parsing it. Structured outputs constrain the model to emit valid JSON matching a schema you supply — turning a freeform text boundary into a typed one. This is the same instinct that makes you put TypeScript types on function boundaries: the schema *is* the contract, and the model is forced to honor it. For flattr, this is the load-bearing concept, because the riskiest seam is an *input* one.

```
LAYERS — schema constrains the model boundary
┌──────────────────────────────────────────────┐
│ free text in  → [ LLM + schema ] → typed JSON  │
│                       │                         │
│   constrained decoding rejects any token that   │ ◄── invalid JSON
│   would break the schema, token by token        │     is unreachable
└──────────────────────────────────────────────┘
        ▼
  { destination: "Dolores Park", kind: "poi" }  ← parseable, validated
```

## How it works

**Move 1 — the mental model.** Instead of "please reply in JSON" (a hope), constrained decoding masks the token sampler so only tokens that keep the output valid-against-schema are allowed. The model literally cannot emit a stray prose preamble or a missing brace. You hand it a JSON Schema / Zod-shaped type; you get back something that parses, every time. Validation still happens after — but the failure surface shrinks from "anything" to "semantically wrong but well-typed."

```
PATTERN — types at the boundary
  TS fn:   geocode(query: string): GeocodeResult   ← compiler enforces
  LLM:     extract(text): { destination, kind }     ← schema enforces
           ─────────────────────────────────────────
           same idea: the boundary has a shape, not vibes
```

**Move 2 — the mechanism, step by step.** At each decode step the model proposes a distribution; a grammar/state-machine derived from your schema computes which next tokens are legal (e.g. after `{"destination":"` only string-continuation or a closing quote is valid). Illegal tokens get their probability zeroed before sampling. The output is therefore guaranteed parseable; what it is *not* guaranteed is correct or safe — a well-typed `destination` can still be a hallucinated place or carry injected instructions.

```
MECHANISM — constrained decode
  schema ─► grammar/state machine
                │ legal-token mask
                ▼
  logits ─► mask illegal ─► sample ─► append ─► (schema advances)
                                                     │
                              guaranteed-valid JSON ◄┘
```

The discipline: schema gives you *shape* safety, not *value* safety. Validate ranges, allow-list enums, and treat any string field as untrusted text (it may have come from, or echo, an injection source).

**Move 3 — principle.** Put a schema on the LLM boundary the way you put a type on a function — then validate values as if the typed thing still lied to you.

## In this codebase

**Not yet exercised in flattr.** No schema-constrained calls exist. But this is *the* concept for the input→prompt seam at `pipeline/geocode.ts:9`: `geocode(query, opts)` shoves raw user text straight at Nominatim. Called from `mobile/src/AddressBar.tsx` → `mobile/src/MapScreen.tsx:82,182,189`, it can't handle "somewhere flat near the park." A natural-language wrapper would extract a **typed destination** — say `{ destination: string, kind: "address" | "poi", maxGrade?: number }` — via constrained decoding, *then* feed `destination` into `geocode`. That converts free text into a validated struct before it touches the network.

Two cautions that make the schema necessary, not optional:
- The extracted `destination` is still attacker-adjacent user text — validate before use.
- The geocoder's return label (`pipeline/geocode.ts:27,52,69`, OSM `display_name`) is server-controlled and crowd-edited. If it ever flows into a prompt (e.g. "confirm: did you mean {label}?"), it's a prompt-injection vector — a schema on the *output* of that step won't sanitize the *value*.

## See also
- [09 — User override locks](09-user-override-locks.md)
- [03 — Sampling parameters](03-sampling-parameters.md)
