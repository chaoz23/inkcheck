# Inkcheck 0.7: Rules That Matter

Status: 0.7 foundation release contract. This document records the shipped author-defined-rule surface and the evidence required before assertion-directed search may become a promoted product claim. It does not change the current 0.6 scorecard targets.

## Product promise

> Tell Inkcheck what must always be true in this story. It looks for a violation within an explicit, bounded budget and returns an exact replay witness when it finds one.

Examples include `gold >= 0`, `health <= max_health`, and `key_found == true` before entering a vault or reaching an ending.

This is mechanical QA, not semantic understanding. Inkcheck does not infer whether a variable is desirable, use AI to decide story intent, or turn a bounded clean run into a proof. A clean bounded result means only that no violation was observed in that run; exhaustive verification is reported only when systematic traversal earns it.

## 0.7 foundation: author-defined mechanical rules

The foundation ships with its contract, validation, replay evidence, privacy boundary, and accessible hosted flow. It evaluates the rules an author explicitly configures during the ordinary bounded check. It does not claim that Inkcheck understands the story, and it does not spend extra search budget merely because a rule exists.

### One typed rule contract everywhere

Assertions remain typed data rather than executable JavaScript or arbitrary Ink expressions. The same versioned grammar must be accepted by `inkcheck.yml`, CLI validation, CI, MCP, and the hosted author experience:

```yaml
assertions:
  - id: gold_nonnegative
    description: Gold never goes negative
    when: always
    condition:
      left: { variable: gold }
      operator: ">="
      right: { literal: 0 }
```

Unknown variables or knots, invalid types, and unsupported operators must fail before exploration spends work. A violation must retain the observed values, stable identity, source/config binding, and an exact replay witness.

### Human intent without a configuration tax

The hosted checker provides a small rule-builder flow for one optional numeric rule. It offers browser-detected declared variables as a selection aid, a comparison, a numeric literal or another declared variable, and an `always` or `terminal` evaluation point. It shows the authored rule in plain language and generated configuration form before the run begins. The server remains authoritative and validates the same typed grammar against the compiled story before exploration.

The web flow must not expose raw explorer weights or imply that a clean partial run proves an assertion. It must preserve the existing consent, deletion, non-AI, progress, cancellation, and report-trust boundaries.

## Experimental 0.7 specialist: assertion-directed work

An assertion-directed specialist is a separate opt-in experiment. It may receive extra search budget only after the promotion gates below are met. Until then, it must not be enabled by default, change the current scorecard, or be described as an evidence-earned coverage improvement.

### Protected, bounded work

General QA remains protected. An assertion-directed specialist receives a separately reported additive probe budget; it must not silently take states from the baseline portfolio.

Each specialist run must have explicit state, depth, time, memory, frontier, disk, and deadline ceilings. It begins with a small probe and may expand only for a predeclared reason: a portfolio-new assertion violation, a validated explicit intent milestone, or a measured recovery signal that survives the release evaluation. No violation, raw state novelty, or detector confidence alone authorizes unbounded expansion.

Every result records the general budget, assertion budget, actual spend, stop reason, activation reason, marginal evidence, and whether the base report was preserved. A specialist that reaches its ceiling without qualifying evidence is a bounded negative result, not a coverage claim.

### Approval boundary for agents

Humans can author rules directly. An agent may inspect source structure and draft a typed rule proposal, but it may not silently authorize, add, or modify a rule. The proposal must name the variables and locations it used, state the intended invariant, disclose uncertainty, and wait for explicit human approval before a directed run.

## Report language

For every assertion, the report must use one of these meanings:

| Status | Meaning |
| --- | --- |
| `violated` | A reachable explored state broke the rule; the report includes an exact replay witness. |
| `not_observed` | No violation was seen before a declared limit bound the run. This is not verification. |
| `exhaustively_verified` | A systematic pass completed the reachable state space under the configured semantics without observing a violation. |
| `invalid` | The rule could not be safely evaluated and exploration did not proceed on its behalf. |

## Foundation release evidence

The author-defined rule foundation ships with all of the following:

1. Same source, configuration, seed, and policy reproduce assertion identities and replay witnesses across supported platforms.
2. Invalid variables, knots, types, and operators fail before exploration spends work; reports retain observed values, rule identity, source/config binding, and an exact witness for each violation.
3. The hosted flow is checked for keyboard access, mobile layout, cancellation, deletion language, and the distinction between observed, partial, invalid, and exhaustive evidence.
4. The public documentation includes adversarial fixtures for valid violations, clean partial runs, exhaustive verification, and validation failures.

## Specialist promotion gates

The assertion-directed specialist cannot become default behavior, receive a score increase, or claim an evidence-earned coverage improvement until all of the following are true:

1. Baseline general QA is retained exactly when the additive assertion child is enabled; runtime errors and existing assertion violations cannot be hidden by aggregate yield.
2. The specialist has deterministic probe, expansion, saturation, and stop decisions with all resource ceilings enforced.
3. A preregistered evaluation covers at least twenty structural synthetic families and at least three consent-safe authored public projects, with multiple seeds and budgets. A resource-bound cell is recorded as such rather than omitted.
4. The evaluation reports gains, neutral outcomes, regressions, duplicate rediscovery, cost, and every critical finding separately. A score increase for specialist advantage requires value in more than one family; a single attractive story is not enough.

## Scorecard target, not current score

The foundation improves author intent and report clarity, but the broader target movement below is conditional on the specialist promotion gates passing:

| Dimension | 0.6 baseline | 0.7 target | Why |
| --- | ---: | ---: | --- |
| Actionable, repeatable QA | 8 | 9 | Invariant violations become replayable, fixable regression evidence. |
| Honest bounded evidence | 8 | 9 | Assertion outcomes make observed, partial, invalid, and exhaustive states explicit. |
| Robust unknown-shape exploration | 6 | 7 | An additive rule probe contributes new evidence without replacing broad QA. |
| Structured specialist advantage | 4 | 7 | Probe-to-expansion economics become implemented and evaluated. |
| Anytime value per wall clock | 7 | 8 | Cheap probes earn additional work only when measured evidence supports it. |
| Author and agent intent | 8 | 9 | Humans express invariants directly; agents propose but do not authorize them. |
| Low-friction human trust | 7 | 8 | A nontechnical rule builder and precise report language make the capability usable. |
| Demonstrated generalization | 4 | 6 | Release evidence spans synthetic structural families and multiple authored projects. |

There is no overall average. In particular, a polished rule builder cannot compensate for lost baseline runtime errors, a specialist that consumes unearned budget, or evidence drawn from one favorable story.

## Out of scope

- Automatic semantic judgment of what a story "should" mean.
- AI-generated rules that run without human approval.
- An exhaustive-coverage promise for large stories.
- Replacing the current bounded portfolio before the separate search-promotion gate passes.
- Treating terminal-state variety as an assertion violation or a proxy for story quality.

## Initial work slices

1. Define the versioned hosted assertion request/report contract and its privacy boundary.
2. Implement the author-facing rule builder and ordinary assertion reporting against that contract.
3. Add adversarial fixtures for valid violations, clean partial runs, exhaustive verification, and variable/type validation.
4. Implement assertion-specialist probe, expansion, saturation, and accounting decisions behind an opt-in flag.
5. Run and publish the preregistered baseline-versus-additive evaluation before changing defaults, raising scores, or promoting the specialist.
