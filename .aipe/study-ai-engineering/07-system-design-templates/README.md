# 07 — System Design Templates

Interview-reframe templates. Each takes a canonical ML/AI system-design prompt and
answers it about flattr — the same hand-rolled A* router over a grade-annotated street
graph, viewed through a different framing each time. **The code does not change between
templates; the lens does.**

The point is rehearsal: in a system-design loop you get a generic prompt ("design a
ranking system", "design a support bot") and have to map it onto whatever you actually
built. These files practice that mapping honestly. flattr has no LLM, no RAG, no
embeddings, no ML — it is a deterministic shortest-path solver in TypeScript on
Expo/React Native — so most of these templates land at *partially* or *no*, and the
value is in saying *why* precisely, not in pretending otherwise.

Every template follows the same nine-bullet shape: the prompt, standard architecture
(box diagram), data model, key components, scale concerns, eval framing, common failure
modes, an honest **Applies to this codebase** verdict, and a concrete **How to make it
apply** refactor that names flattr's real files.

## Templates

- **[01 — Search & Ranking](01-search-ranking.md)** — *Applies: partially.* flattr's
  geocode autocomplete (`geocodeSuggest`, `MapScreen.tsx:82`) and `nearest.ts` spatial
  nearest-neighbor are genuine retrieval surfaces, but there's no learned ranker, no
  embeddings, and no click logs. flattr does stage-one retrieval and stops; its
  "ranking" is geographic distance, not relevance learning.

- **[02 — Tech Support Chatbot](02-tech-support-chatbot.md)** — *Applies: no.* flattr is
  a routing tool, not a Q&A/support system. The only generative-adjacent surface is the
  route-describe OUTPUT seam (`summary.ts` → `RouteSummaryCard`), and even fully built
  it's a captioner, not a chatbot. Included to practice declining a template cleanly.

## How to read these

Read the **Applies to this codebase** bullet first. It is the honest verdict — what
flattr actually exercises versus what the template assumes. The architecture and scale
sections are the generic textbook answer, kept so the template is reusable; the flattr-
specific truth lives in the last two bullets. Nothing here claims flattr does AI it
doesn't do.
