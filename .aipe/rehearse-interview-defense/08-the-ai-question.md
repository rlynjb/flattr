# Chapter 8 — The AI Question

In 2026, this question is coming, and the interviewer already knows the
answer is yes. "Did you use AI to build this?" "Can you explain this section
line by line?" "What did the AI get wrong?" The senior interviewers asking
these aren't trying to catch you using AI — everyone uses AI. They're testing
whether you understand what you shipped well enough to *own* it. The candidate
who used heavy AI assistance and can defend every load-bearing decision beats
the candidate who wrote every line by hand but can't explain why.

You built flattr with Claude Code — significant AI assistance, by your own
account. This chapter teaches the calibrated-honest answer: matter-of-fact
about the AI's role, matter-of-fact about yours, and grounded in the fact that
you can defend the architecture, the algorithm, and the debugging. The worst
answer is defensive or evasive. The best is grounded.

---

## The "what AI did, what I did" split

This is the chapter's spine: a clean division of the work, so you can speak to
both halves without flinching. The point isn't to minimize the AI — it's to
show you own the decisions regardless of who typed them.

```
  flattr — who did what

  ┌─ AI HELPED HEAVILY WITH ────────┬─ I OWN ────────────────────────┐
  │ • TypeScript syntax, boilerplate │ • THE ARCHITECTURE: build-time │
  │ • Expo / RN / MapLibre wiring    │   vs runtime split, no backend │
  │ • test scaffolding               │ • THE ALGORITHM: one parametric│
  │ • refactors, type plumbing       │   search(), directional cost,  │
  │                                  │   admissible heuristic         │
  │                                  │ • THE DEBUGGING: disconnected-  │
  │                                  │   components bug, reachability  │
  │                                  │   probe, corridor pre-load fix  │
  │                                  │ • THE DESIGN CALLS: BLOCKED      │
  │                                  │   finite, directional cost,     │
  │                                  │   degrade-honestly              │
  └──────────────────────────────────┴────────────────────────────────┘

  THREE MODES OF EACH DECISION — be ready to label which
  ┌────────────────────────────────────────────────────────────────┐
  │ DELIBERATE             I decided. (directional cost, no backend) │
  │ EVALUATED & ACCEPTED   AI suggested, I weighed it, kept it.      │
  │ DEFAULTED-TO           AI's default, I didn't deeply evaluate.   │
  │                        ← riskiest to own, strongest when owned.  │
  └────────────────────────────────────────────────────────────────┘
```

The left column doesn't weaken you — owning that AI wrote the boilerplate is
honest and normal. The right column is where you live. And the three modes are
the tool that makes the whole chapter work: when you can label *which* mode a
decision came from, you sound like someone who watched their own decisions
get made, not someone who accepted a pile of code on faith.

---

## The headline — "did you use AI to build this?"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Did you use AI to build this?"                        │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   NOT "did you cheat." They assume you used AI. They're  │
│   testing: are you defensive about it (insecure), evasive│
│   about it (dishonest), or matter-of-fact about it       │
│   (mature)? And crucially — do you understand what you   │
│   shipped, or did you ship something you can't explain?  │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — matter-of-fact, then pivot to ownership:

> "Yes, heavily — I built it with Claude Code. It wrote a lot of the
> TypeScript, the Expo and MapLibre wiring, the test scaffolding. That's how I
> work now. What I own are the decisions that matter: the architecture is
> mine — the build-time-versus-runtime split and the call to have no backend
> were my design. The algorithm is mine — the directional grade cost, the
> single parametric `search()` that does Dijkstra through directional A*, the
> choice to keep the heuristic admissible. And the debugging is mine — when
> routing returned 'no route' on a connected-looking map, I formed the
> hypothesis, ran the reachability probe, and traced it to disconnected
> components. The AI didn't hand me that; I did the diagnosis.
>
> So the honest framing is: AI accelerated the typing, I own the thinking.
> And I can prove that — ask me about any load-bearing decision and I'll tell
> you why it's there and what it costs."

That last line is an *invitation*. You're not bracing against the line-by-line
follow-up — you're requesting it. That's the move that turns the AI question
from a threat into your strongest moment.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I mean, I used it for   │ "Yes, heavily — Claude  │
│ some boilerplate but I    │ Code wrote a lot of the │
│ wrote the important       │ TS and wiring. I own    │
│ parts myself, the AI      │ the architecture, the   │
│ just helped a little."    │ algorithm, and the      │
│                          │ debugging — ask me about │
│ (defensive, minimizing)   │ any decision and I'll    │
│                          │ tell you why it's there  │
│                          │ and what it costs. AI    │
│                          │ accelerated the typing;  │
│                          │ I own the thinking."     │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Defensive and minimizing.│ Matter-of-fact about    │
│ "Just helped a little"    │ the AI, specific about  │
│ reads as insecure — the  │ what YOU own, and ends  │
│ interviewer hears        │ by INVITING the         │
│ someone uncomfortable     │ line-by-line probe.     │
│ with how they work. It    │ Confidence, not         │
│ also invites suspicion    │ defense.                │
│ you CAN'T explain it.     │                         │
└─────────────────────────┴─────────────────────────┘
```

The weak answer's tell is the word "just." Minimizing the AI's role signals
you're uncomfortable with it — and in 2026 that discomfort itself reads as a
junior trait. The strong answer is *more* honest about the AI's role and
*more* confident about yours. Both at once.

```
┃ "AI accelerated the typing. I own the thinking. And I can
┃  prove it — ask me about any decision."
```

---

## The drill-down — "explain this section line by line"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Pick a non-trivial function and explain it to me      │
│    line by line."                                        │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   This is the verification. They want to know the AI     │
│   didn't ship you something you can't read. The test     │
│   isn't whether you memorized lines — it's whether you   │
│   understand the MECHANISM well enough to walk it.       │
└─────────────────────────────────────────────────────────┘
```

Pick `gradeCostDirected` — it's short, it's the heart of the project, and you
understand it cold:

> "Take the directional cost — `gradeCostDirected` in cost.ts:32. It returns
> `edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax))`.
> Walk it inside out: `directedGrade` (graph.ts:17) gives the signed grade in
> the direction you're actually traveling — positive `gradePct` if you're
> going from the edge's `fromNode`, negated if you're going the other way.
> That sign flip is the entire directional behavior. Then `penalty`
> (cost.ts:16) takes that signed grade: if it's at or below zero — flat or
> downhill — it returns 0, so downhill is literally free. Moderate uphill is a
> linear penalty, steep uphill is quadratic, and over your `userMax` it
> returns `BLOCKED`, which is `1e9`. Finally I multiply the penalty into the
> edge length, so a steep edge costs more than a flat edge of the same
> distance. That `1 +` matters — it means a flat edge still costs its real
> length, so the router doesn't collapse to 'minimize penalty, ignore
> distance.' I can walk any of these — the cost function is the part I
> understand best because it's the part that makes flattr flattr."

You walked it inside-out with file:line refs and named the *why* behind each
piece (the sign flip, the `1 +`). That's understanding, not memorization, and
it's verifiable on the spot.

---

## The sharpest version — "what did the AI get wrong?"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What did the AI get wrong, and how did you catch it?" │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you REVIEW what the AI produces, or accept it on    │
│   faith? The candidate who can name a specific thing the │
│   AI got wrong and how they caught it proves they're the │
│   engineer in the loop, not a passenger.                 │
└─────────────────────────────────────────────────────────┘
```

This is where the three modes earn their keep. The strongest material here is
a `defaulted-to` decision you later caught and corrected, or an AI suggestion
you evaluated and *rejected*:

> "The most useful thing is the stuff I had to push back on. The AI's instinct
> on the 'no flat route' case was to treat over-limit edges as impassable —
> effectively infinite cost. That would've been wrong for the product: it
> would collapse 'too steep' into 'no route' and leave the user with a dead
> end instead of a flagged steep path. I made `BLOCKED` a large *finite*
> number — `1e9`, cost.ts:5 — precisely so an only-steep path is still
> returned and flagged. That distinction is mine, and it's the kind of thing
> the AI won't get right because it's a product decision, not a code pattern.
> More generally, the algorithm correctness — admissibility, the directional
> sign convention, the disconnected-components diagnosis — is where I'm the
> reviewer. The AI is fast at syntax and weak at 'is this the right behavior
> for *this* product,' so that's exactly the line I watch."

The `BLOCKED`-finite example is perfect because it's a real design decision
where the obvious (AI-default) move was subtly wrong, and you can articulate
*why* a product decision is the kind of thing AI gets wrong. That's the mature
read on the tool.

```
┃ "The AI is fast at syntax and weak at 'is this the right
┃  behavior for THIS product.' That line is exactly where I
┃  stay the reviewer."
```

---

## When the AI question pushes past your depth

Even here, there's an honest-gap version — when they ask about a part where
you genuinely *did* lean on the AI's default without deep evaluation.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW (the defaulted-to honesty)               ║
║                                                               ║
║   They probe a part you didn't deeply evaluate: "Why did you  ║
║   structure the bidirectional search's potential function     ║
║   exactly this way? Did you derive it or accept it?"          ║
║                                                               ║
║   This is the riskiest mode — defaulted-to — and the          ║
║   bidirectional proof is exactly where you're least confident ║
║   (Chapter 6). The honest answer is the strong one.           ║
║                                                               ║
║   Say:                                                        ║
║   "I'll be straight: the balanced-potential formulation is a  ║
║    place where I worked it out with the AI and verified it    ║
║    empirically rather than deriving it cold myself. I          ║
║    understand the mechanism — forward and reverse potentials  ║
║    that stay consistent, the stopping rule when the frontiers ║
║    meet — and I trust it because it returns the same paths as  ║
║    my single-direction A* across the tests. But the formal    ║
║    consistency proof is something I'd want to derive carefully ║
║    before I claimed I owned it from first principles. So       ║
║    that one is 'evaluated and accepted on evidence,' not       ║
║    'derived from scratch,' and I'd rather tell you that than   ║
║    pretend I proved it on a whiteboard."                      ║
║                                                               ║
║   What this signals: you can label the EXACT mode a decision  ║
║   came from (defaulted-to / accepted-on-evidence), you don't  ║
║   inflate your ownership, and you back the gap with empirical ║
║   evidence. Owning a defaulted-to decision honestly is the    ║
║   single most senior-positive move in the whole AI            ║
║   conversation — most candidates can't admit one exists.      ║
╚═══════════════════════════════════════════════════════════════╝
```

For the algorithm internals you'd want to derive cold — A* admissibility,
bidirectional consistency, heap mechanics — point yourself at
**`.aipe/study-dsa-foundations/`**.

---

## What you'd change

In how you *talk about* the AI, the thing to tighten is to label the mode
proactively. Don't wait to be asked "did you evaluate this or accept it" —
volunteer "this one I decided, this one the AI suggested and I kept after
weighing it, this one I defaulted to and verified by tests." Naming the mode
before you're asked is the difference between sounding like you watched your
decisions get made and sounding like you're reconstructing them under
pressure. The three modes aren't a defense — they're how you prove you were
the engineer in the loop the whole time.

---

## One-page summary — read this the night before

**Core claim:** The AI question isn't "did you cheat" — it's "do you
understand what you shipped." Be matter-of-fact about the AI, specific about
what you own, and invite the line-by-line probe.

**Questions covered:**
- *"Did you use AI?"* → Yes, heavily, Claude Code. AI accelerated the typing;
  I own the architecture, algorithm, and debugging. Ask me anything.
- *"Explain it line by line"* → `gradeCostDirected` (cost.ts:32) inside-out:
  signed `directedGrade` (graph.ts:17), `penalty` 0-for-downhill (cost.ts:16),
  the `1 +` that keeps distance in the cost.
- *"What did AI get wrong?"* → the `BLOCKED`-finite call (cost.ts:5) — AI's
  default treated steep as impassable; I made it finite so steep stays a
  flagged path. Product decisions are where AI is weak and I stay reviewer.
- *"Did you derive the bidirectional potential?"* → no — evaluated and
  accepted on empirical evidence, not derived cold. Said plainly.

**The three modes:** deliberate (I decided) · evaluated-and-accepted (AI
suggested, I weighed it) · defaulted-to (AI's default, verified not derived).
Label the mode before being asked.

**Pull quotes:**
- "AI accelerated the typing. I own the thinking."
- "The AI is fast at syntax and weak at 'is this right for THIS product.'"

**What you'd change:** Label the decision mode proactively — don't wait to be
asked whether you decided, accepted, or defaulted.
