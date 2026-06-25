# Problem Selection — flattr

This brief answers the question that comes *before* "is the code good?" — namely, "was this problem worth solving at all, and can you defend the choice to invest in it?" That's the staff-level skill: not just building the thing, but justifying why the thing deserved your time over everything else you could have built.

Here's the honest frame you have to hold, because a skeptical reviewer will test it in the first minute: **flattr is a learning/portfolio project, not a product with users.** The repo proves the *technical* premise — you can route for flat instead of fast over a real elevation graph — but it contains no evidence that anyone is currently in pain over hilly routes, no usage data, no market signal. So this brief does two things at once: it makes the genuine case for the problem (grade-aware routing is real and underserved), and it's straight about where that case is *inference* rather than *evidence*. The strongest version of you in a review room is the one who says "here's what I can prove, here's what I'm assuming, and here are the discovery questions I'd answer before betting real resources."

```
  THE BRIEF AT A GLANCE — claim, and where it stands

  PROBLEM        grade-aware routing for self-powered travel
                 ("flattest comfortable," not "shortest")
       │
       ├─ EVIDENCE (provable from repo) ──────────────────┐
       │   the technical premise works: directional A* over │
       │   an elevation graph, userMax knob, honest fallback │
       │                                                    │
       ├─ INFERENCE (plausible, unproven) ─────────────────┤
       │   scooter riders / wheelchair users / cargo-bike   │
       │   commuters avoid hills — real, but no user data    │
       │   in this repo                                      │
       │                                                    │
       └─ GAP (must discover before investing) ────────────┘
           who, how many, how often, would they switch?
```

That diagram is the whole posture: separate what the repo proves from what you're inferring, and name the gap out loud.

## The five files

| File | What it answers |
|------|-----------------|
| `01-problem-brief.md` | Who hurts, what evidence exists vs is inferred, why now, who benefits, the constraints. |
| `02-scope-cuts-and-non-goals.md` | The smallest useful slice, and everything deliberately not built. |
| `03-options-and-opportunity-cost.md` | The real alternatives — including *do nothing* — and what each costs. |
| `04-success-metrics-and-feedback-loop.md` | What observable outcome would prove the premise, and how you'd measure it. |
| `05-skeptical-reviewer-questions.md` | The review-room questions and the answers that hold (or honestly don't). |

## How to use it

Read `01` first — it's the spine. `05` is the one to rehearse out loud, because the skeptical-reviewer questions are exactly what gets asked when you propose investing in *anything*, not just flattr. The transferable skill this brief trains is justifying a problem under scrutiny without overclaiming — pair it with the design docs (`.aipe/rehearse-design-doc/`) which take over once the problem is justified and the decisions need writing down.
