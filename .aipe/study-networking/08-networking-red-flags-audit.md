# Networking red-flags audit

**Industry name(s):** network-failure risk audit. **Type:** Project-specific.

## Zoom out, then zoom in

This is the ranked-risk close. Every finding is grounded in a `file:line`, ranked by
**consequence** (what specifically breaks), and tagged observed vs inferred. The verdict
up front: flattr's networking is well-behaved for a single-user client against free APIs —
the resilience design (`07`) is genuinely good — but it has **one sharp structural edge**
(no timeout meeting a concurrency-of-one pump) and a handful of smaller gaps.

```
  Zoom out — where each red flag sits on the stack

  ┌─ flattr networking ────────────────────────────────────────┐
  │  #1 no request timeout ........... transport/resilience (07)│ ← sharpest
  │  #2 single host, no failover ..... addressing (02)          │
  │  #3 no backoff jitter ............ resilience (07)          │
  │  #4 unvalidated 3rd-party JSON ... HTTP body (05) → security│
  │  #5 build-time fatal-on-failure .. orchestration (01)       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **a consequence-ranked risk register** — not a checklist of
"missing features," but a list ordered by *what actually breaks first and worst.*

## The structure pass

**Axis traced: blast radius — when this fails, how far does the damage spread?**

```
  Axis: "how far does this failure propagate?"

  ┌─ #1 no timeout ──────┐  freezes the WHOLE runtime pipeline (widest)
  ┌─ #2 no failover ─────┐  whole feature down while one host is down
  ┌─ #5 build fatal ─────┐  whole build aborts (but build-time, re-runnable)
  ┌─ #3 no jitter ───────┐  one user: negligible · a fleet: thundering herd
  ┌─ #4 unvalidated JSON ┐  one bad area, contained (but a security seam)
  └──────────────────────┘
  rank by blast radius, not by how "wrong" it feels
```

**Seam.** Every flag sits at the same load-bearing seam from `01`: flattr-code →
third-party-server, the boundary flattr can't see past. The audit is really an inventory
of *what flattr failed to defend at that one seam.*

## How it works — the ranked register

### Move 1 — the mental model

You know a code-review "nit vs blocker" call — same idea, applied to network failure. The
pattern is **rank by blast radius**: the worst flag isn't the most "incorrect" one, it's
the one whose failure spreads furthest. flattr's worst isn't a missing feature — it's a
*combination* (no timeout × concurrency-of-one) that turns a slow request into a frozen
app.

```
  The pattern — consequence ranking, not severity-by-vibe

  for each gap:
     blast_radius = how far does its failure propagate?
     likelihood   = does flattr's usage actually hit it?
  rank by (blast_radius × likelihood), name the file:line, name the fix
```

### Move 2 — the findings, ranked

---

**#1 — No request timeout, and it meets a concurrency-of-one pump. (OBSERVED)**

*Evidence:* zero `AbortController` / `AbortSignal` in the repo (`pipeline/`, `mobile/src/`,
`lib/`, `features/`). The pump gates all runtime builds on one flag (`useTileGraph.ts:167`,
`busyRef`). The `[out:json][timeout:60]` (`overpass.ts:10`) is server-side, not a client
timeout.

*Consequence:* a server that accepts the TCP/TLS connection then hangs leaves `await
fetch` pending indefinitely (only the OS-level TCP timeout, minutes away, ever fires —
`03`). Because the pump is single-in-flight, `busyRef` stays `true`, `pump()` early-returns
on every future call, and **the entire runtime fetch pipeline freezes** — no viewport
loads, no route corridor builds, no self-heal. One hung connection, whole feature dead.

```
  Why this is #1 — the combination, not either part alone

  no timeout ALONE     → one slow request (annoying)
  pump=1 ALONE         → serialized builds (fine)
  no timeout × pump=1  → one hang freezes ALL builds forever  ◄ widest blast radius
```

*Fix:* wrap each `fetch` in an `AbortController` with a ~15s timeout (build) / ~8s
(runtime). One change in each of the three clients closes it.

---

**#2 — Single hardcoded host, no failover. (OBSERVED)**

*Evidence:* one Overpass host (`overpass.ts:4`), one Open-Meteo host (`elevation.ts:106`),
one Nominatim host (`geocode.ts:5`). The `endpoint` parameter on `fetchOverpass`
(`overpass.ts:23`) exists for test injection, not production failover.

*Consequence:* when the one host is down or its DNS fails, flattr's retry/backoff (`07`)
hammers the same dead address and then throws — "backoff against a corpse" (`02`). The
whole street/elevation feature is down for the duration, with no second address to try.

*Fix:* a small ordered list of mirror hosts (Overpass has public mirrors); rotate on
exhausting retries against one.

---

**#3 — No jitter on backoff. (OBSERVED)**

*Evidence:* both backoff curves are deterministic — `delayMs * (attempt+1)`
(`overpass.ts:43`) and `delayMs * 2**(attempt+1)` (`elevation.ts:115`). No random
component.

*Consequence:* for flattr's single-user reality, **negligible** — there's one client, no
herd to synchronize. The risk is *latent*: if flattr ever ran many clients (a fleet, a
web deploy), they'd all retry in lockstep after a shared 429 and re-collide. Ranked low
because likelihood ≈ 0 today, but named because it's a one-line fix to pre-empt.

*Fix:* multiply the sleep by `(0.5 + Math.random())` — standard jitter.

---

**#4 — Unvalidated third-party JSON crosses the trust seam. (OBSERVED — owned by `study-security`)**

*Evidence:* responses are cast, not validated — `(await res.json()) as OverpassResponse`
(`overpass.ts:41`), `as { elevation: number[] }` (`elevation.ts:111`), `as NominatimRow[]`
(`geocode.ts:25`). No schema check (Zod, etc.).

*Consequence:* a malformed or hostile response (possible over a perfect TLS connection —
`04`) flows into graph-building as if well-formed. `json.elevation` is iterated assuming
it's a same-length array (`elevation.ts:120`); a wrong shape produces `undefined`
elevations or a throw mid-build. Contained to one area, but it's the network→app trust
boundary. **The mechanism is networking; whether it's *safe* belongs to `study-security`.**

*Fix:* runtime-validate each response shape at the seam before casting.

---

**#5 — Build-time treats any network failure as fatal. (OBSERVED — and partly deliberate)**

*Evidence:* `run-build.ts:44` calls `fetchOverpass(BBOX)` with no surrounding catch; a
throw aborts the whole build. Contrast runtime, which swallows and degrades
(`useTileGraph.ts:219`).

*Consequence:* a transient Overpass 5xx that outlasts the 3 retries kills `npm
run:graph`, losing all prior work in that run. **But** this is largely the right call:
the build is offline, re-runnable, and a partial graph is worse than no graph. Ranked
low because the blast radius is a re-run, not a user-facing outage.

*Fix (optional):* checkpoint partial progress, or widen retries for the one-shot build.

---

```
  Layers-and-hops — where each flag bites on a single live request

  ┌─ flattr ──┐ resolve ┌─ DNS ─┐  #2 no failover if this host is down
  │           │────────►│       │
  │           │ connect ┌─ TCP/TLS ─┐  #1 hang here = pending forever (no timeout)
  │           │────────►│           │
  │           │ request ┌─ HTTP ─┐  #5 build aborts on throw · #3 lockstep retry
  │           │────────►│        │
  │           │ ◄ body  └────────┘  #4 unvalidated JSON enters the app here
  └───────────┘
```

### Move 3 — the principle

A red-flags audit earns its keep by ranking on **blast radius × likelihood**, not on how
incomplete the code feels. flattr's resilience is good — the ranking surfaces that its one
*structural* flaw (#1) is more dangerous than several "missing best practices" precisely
because it's an *interaction* (no timeout × single-in-flight), and interactions are where
the worst failures hide. The principle: **audit for the combination, not the checklist —
the failure that freezes everything is rarely a single missing line, it's two reasonable
choices colliding.**

## Primary diagram

```
  flattr networking — risk register, ranked by blast radius

  RANK  FINDING                       EVIDENCE                  BLAST RADIUS
  ────  ────────────────────────────  ────────────────────────  ───────────────────
   #1   no request timeout × pump=1   no AbortController · :167  WHOLE pipeline frozen
   #2   single host, no failover      overpass.ts:4 et al.       feature down, no retry-host
   #3   no backoff jitter             :43 · :115 deterministic   latent (fleet only)
   #4   unvalidated 3rd-party JSON    `as` casts, no schema      app trust seam (→security)
   #5   build fatal-on-failure        run-build.ts:44 no catch   build re-run (deliberate-ish)

  fix order: #1 (AbortController) → #2 (mirror hosts) → #4 (validate) → #3 (jitter)
```

## Elaborate

Risk audits go wrong when they rank by "how textbook-wrong is this" instead of "what
breaks and how far." flattr is a clean case study: the resilience layer (`07`) would pass
most reviews, yet the single highest-consequence issue is an *emergent* one — two
defensible decisions (no client timeout; one build at a time) that are individually fine
and jointly capable of freezing the app. That's the kind of finding only a
consequence-ranked, seam-aware audit catches. Where to take this next: `study-security`
owns whether #4's trust boundary is actually exploitable; `study-distributed-systems` owns
the partial-failure framing of #1/#2/#5 across three independent providers.

## Interview defense

**Q: If you could fix one networking thing in flattr, what and why?**
> Add an `AbortController` timeout to every `fetch`. It's #1 not because a slow request is
> bad, but because no timeout *combined with* the single-in-flight pump means one hung
> connection freezes the entire build pipeline — `busyRef` never clears, nothing else ever
> runs. It's the widest blast radius for the smallest fix: ~15s build / ~8s runtime per call.

```
  no timeout × pump=1 ⇒ one hang freezes everything ⇒ AbortController fixes it
```
> Anchor: *the worst flag is an interaction of two reasonable choices, not a single mistake.*

**Q: How would you audit a network layer you didn't write?**
> Rank by blast radius × likelihood, not by how incomplete it looks, and trace one axis —
> "how far does each failure propagate" — across every hop. That's how flattr's emergent #1
> outranks several genuinely-missing best practices like jitter, which has near-zero
> likelihood for a single-user app.

```
  rank = blast_radius × likelihood ; trace propagation across hops
```
> Anchor: *audit the combination, not the checklist.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the resilience layer these flags grade.
- `02-dns-routing-and-addressing.md` — #2's single-host evidence.
- `01-network-map.md` — the seam every flag sits on.
- `study-security` — owns #4 (is the trust boundary safe?).
- `study-distributed-systems` — partial failure across three providers.
