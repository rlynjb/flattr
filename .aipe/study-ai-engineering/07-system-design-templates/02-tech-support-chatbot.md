# Tech Support Chatbot

An interview-reframe template. The same flattr code, viewed through the lens of a
support-chatbot system-design prompt. Answered honestly — and the honest answer is
that flattr is not this.

## The prompt

"Design a tech support chatbot that answers questions, escalates, and learns from
corrections."

## Standard architecture

The canonical answer is RAG plus a control loop: classify the incoming question,
retrieve grounding docs, generate a grounded answer, gate it on a confidence threshold,
escalate to a human when the gate fails, and feed the human's correction back into the
knowledge base.

```
              TECH SUPPORT CHATBOT — RAG + escalation control loop
  ┌──────────┐   ┌────────────┐   ┌──────────────┐   ┌──────────────┐
  │ user msg │──►│ classify / │──►│  retrieve    │──►│  generate    │
  └──────────┘   │ intent     │   │ (KB / RAG)   │   │ (grounded)   │
                 └────────────┘   └──────────────┘   └──────┬───────┘
                                                            │
                                          confident? ───────┤
                                          ┌──── yes ────────┘
                                          ▼                 │ no
                                   ┌────────────┐           ▼
                                   │  answer    │     ┌────────────┐
                                   └────────────┘     │  escalate  │
                                          ▲           │  to human  │
                                          │           └─────┬──────┘
                                   ┌──────────────┐         │ correction
                                   │ KB / feedback│◄────────┘
                                   │   store      │
                                   └──────────────┘
```

The defining edges are the escalation gate and the correction-write-back: the system
knows when it doesn't know, and it improves from human fixes.

## Data model

- **Conversation state**: turn history, current intent, resolution status, per session.
- **Knowledge base**: support docs / past resolved tickets, chunked and embedded for RAG.
- **Escalation queue**: unresolved threads handed to humans, with context.
- **Correction log**: human-edited answers, written back as new KB entries / fine-tune data.

## Key components

- **Intent classifier** — routes question type, decides early escalation. Choice:
  cheap classifier over a full LLM call when intent is a small fixed set, for latency.
- **Retriever (RAG)** — grounds the answer in real docs to suppress hallucination.
  Choice: retrieval over fine-tuning, because the KB changes faster than you can retrain.
- **Generator** — composes the grounded answer with citations. Choice: low temperature,
  because support answers want consistency, not creativity.
- **Escalation gate** — confidence threshold that prefers a human handoff over a wrong
  answer. Choice: tune toward recall of "I'm unsure" — a missed escalation costs trust.

## Scale concerns

Ordered by what hits first.

- **At low volume**: KB freshness dominates — stale docs produce confidently wrong
  answers long before throughput matters.
- **At ~thousands of conversations/day**: escalation queue management and human
  reviewer throughput become the bottleneck, not model inference.
- **At high volume**: per-conversation context windows and retrieval cost dominate
  spend; you cache common Q&A and compress history.

## Eval framing

- **Offline**: answer accuracy / groundedness against a labeled QA set; hallucination
  rate; escalation precision and recall.
- **Online**: deflection rate (resolved without human), CSAT, escalation rate, repeat-
  contact rate. Deflection and CSAT trade off — over-deflecting tanks satisfaction.

## Common failure modes

- **Hallucinated answers** — confident, ungrounded, wrong. Mitigation: strict RAG
  grounding, cite-or-abstain, answer only from retrieved context.
- **Under-escalation** — bot insists on answering what it can't. Mitigation: calibrate
  the confidence gate toward escalation; treat a missed handoff as a defect.
- **Stale KB** — docs lag reality. Mitigation: correction write-back plus freshness SLAs.
- **Prompt injection via user text** — user input steers the model. Mitigation: treat
  the message as untrusted data, never as instructions; structured tool boundaries.

## Applies to this codebase

**No.** flattr is a grade-aware routing tool, not a question-answering or support
system. There is no conversation, no user question, no knowledge base, no escalation,
and nothing that learns from corrections. The architecture above has no anchor in the
codebase: there is no intent classifier (`features/routing/classify.ts` is a static
grade-threshold table, not an NL classifier), no retriever in the RAG sense
(`nearest.ts` retrieves graph nodes by distance, not documents by relevance), and no
generator. The single generative-adjacent surface in the entire app is the route
description seam — `RouteSummary` is produced at `MapScreen.tsx:159` from
`features/routing/summary.ts:5` and rendered by `RouteSummaryCard` at
`MapScreen.tsx:368`. That is an OUTPUT-to-PROMPT seam where a model *could* one day turn
`{distanceM, climbM, steepCount}` into a sentence, but it is description, not dialogue:
no question comes in, no escalation goes out, nothing is corrected. Forcing flattr into
the support-chatbot mold would be inventing a product flattr is not.

## How to make it apply

This is a stretch, and worth naming as one in the interview. The only plausible bridge
is an "ask about your route" thought-experiment: a tiny Q&A surface over the
`RouteSummary` already produced at `MapScreen.tsx:159` — "how much climbing?", "any
steep sections?" — answered from `{distanceM, climbM, steepCount}` plus the
`path.steepEdges` flags. That reuses the route-describe OUTPUT seam (`summary.ts`) as
grounding context, which is the closest flattr has to a knowledge base.

But it stops well short of the template. There is no KB to retrieve from beyond a single
struct, no need to escalate (the answer is three numbers), and no correction loop —
flattr has no backend to write corrections to. The honest version: the route-describe
seam is the one generative attachment point, and even fully built it produces a captioner,
not a support chatbot. I've shipped genuinely conversational on-device assistants
elsewhere (dryrun, Gemini Nano), so I know the shape; here I'd say plainly that flattr's
problem doesn't ask for it, and a good staff engineer declines to bolt a chatbot onto a
routing app to satisfy a template.
