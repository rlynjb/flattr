# Tokenization
*Tokenization — Industry standard*

## Zoom out

The model doesn't see your string; it sees tokens — sub-word chunks. This is the unit everything is priced and bounded in: context windows are token counts, cost is per-token, latency tracks tokens generated. You've felt this already trimming RAG context in AdvntrCue; here it's worth seeing the seam where token cost would (barely) matter in flattr.

```
LAYERS — tokenization sits at the model boundary
┌──────────────────────────────────────────┐
│ your text:  "80m climb"                    │
│        │ tokenizer (BPE)                   │
│        ▼                                    │
│ tokens: ["80","m"," climb"]  → ids[...]    │ ◄── what the model
│        │                                    │     actually counts
│        ▼ embeddings → transformer          │
└──────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Rule of thumb: ~4 characters per token for English, or ~0.75 words per token. A 2000-token prompt is roughly 1500 words. Numbers, punctuation, and rare words fragment into more tokens than common words. Context windows ("128k") and bills are both denominated in this unit, not characters.

```
PATTERN — chars → tokens (rough)
  "A short ride with one solid hill."  (33 chars)
        │  ~4 chars/token
        ▼
   ≈ 8 tokens
```

**Move 2 — the mechanism.** Most models use BPE (byte-pair encoding): start from bytes, greedily merge the most frequent adjacent pairs into a fixed vocabulary (~50k–100k entries). Common substrings become single tokens; oddball strings stay fragmented. This is why `" climb"` (with leading space, common word) is one token but a hex color like `#2e9e3f` shreds into many.

```
MECHANISM — BPE merge intuition
  bytes:   c l i m b
  merges:  cl  imb        (frequent pairs fused)
  token:   "climb"        (one vocab id if common enough)
  ── rare string ── stays split ──► "#","2e","9e","3f" (4+ tokens)
```

The engineering takeaway: token count is not proportional to "how much info" — structured/numeric payloads can be denser or sparser than you'd guess. Count, don't estimate, when budgets are tight.

**Move 3 — principle.** If you can't count it in tokens, you can't budget it; the tokenizer is the ruler.

## In this codebase

**Not yet exercised in flattr.** There's no tokenizer and nothing tokenized. If the output→prompt seam at `features/routing/summary.ts:11` were wired to an LLM, the payload (`{distanceM, climbM, steepCount}` — three numbers) is tiny: even with a system prompt and instructions you'd be in the low hundreds of tokens. Token cost would be trivial and never the bottleneck. The injection-vector caveat lives elsewhere: `pipeline/geocode.ts:27` returns an arbitrarily long, attacker-influenceable `display_name` — *that* string's token length is unbounded and untrusted.

## See also
- [06 — Token economics](06-token-economics.md)
- [01 — What an LLM is](01-what-an-llm-is.md)
