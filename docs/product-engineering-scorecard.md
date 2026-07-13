# Product and engineering truths

Updated 2026-07-13 against the Inkcheck 0.5.1 release plus unreleased 0.6 research on `main` and the first complete policy v2 promotion matrix.

This scorecard states where Inkcheck's intended value should come from, what engineering properties must remain true while building it, and how far the project believes it has progressed. It is deliberately candid. A score may go down when a stronger evaluation reveals a weakness.

There is no overall average. A strong score in privacy or reporting cannot cancel a lost runtime error, a structural-family blind spot, or a specialist that burns the budget without producing useful evidence.

## Scale

- **0/10:** absent.
- **2/10:** idea or narrow prototype.
- **4/10:** useful foundation with major product gaps.
- **6/10:** credible value in several real workflows, not broadly validated.
- **8/10:** strong, tested behavior with known bounded limitations.
- **10/10:** excellent within Inkcheck's declared contract, supported across the predeclared corpus and operational surfaces.

Ten out of ten never means “all paths in every story were tested.” Inkcheck's contract remains bounded mechanical QA. Exhaustiveness is reported only when a systematic pass actually proves it for the configured story semantics.

## Product truths

| Product truth | 10/10 target | Current | Evidence and principal gap |
| --- | --- | ---: | --- |
| **Actionable, repeatable QA** | Mechanical defects become stable findings with exact replay; fixes can be checked again in CLI, CI, web, or MCP. | **7/10** | Compile/runtime findings, assertions, indexed witnesses, stable report IDs, and CI exist. Repro persistence across source evolution and durable campaigns remain incomplete (#63, #84). |
| **Honest bounded evidence** | Every result distinguishes observed evidence, estimate, and proof; all binding limits and unavailable host behavior are explicit. | **8/10** | Truncation, memory/time/depth/state causes, externals, randomness, exhaustive proof, and shadow uncertainty are reported. Live stop detail and broader false-report evaluation remain (#41, #56). |
| **Robust unknown-shape exploration** | The default gives strong broad insurance across early choices, deep suffixes, variables, loops, gates, storylets, randomness, and sparse failures without one family dominating. | **6/10** | DFS, beam, seeded random, shared-frontier experiments, and adaptive rounds are materially stronger than DFS alone. After #118, all 228 non-random promotion pairs are evidence-identical; this removes a regression but still shows no broad policy-v2 advantage, so the fixed portfolio remains the default. |
| **Structured specialist advantage** | Ink-aware specialists exploit gates, loops, assertions, eligibility hubs, and behavioral diversity, earning budget only through portfolio-new value while broad probes remain protected. | **2/10** | Assertions, goals, staged goals, inspection, and variable-aware experiments are foundations. Automatic detection/dispatch and specialist execution are planned, not shipped (#107-#112). |
| **Anytime value per wall clock** | Users receive useful result windows early; allocation, long-tail probing, deadlines, and stopping adapt to measured yield and resources without hiding uncertainty. | **5/10** | Policy v2 adds window-normalized marginal yield, bounded renewal/decay, warm-up, priority gates, and truthful baseline parity while gated off. The corrected full synthetic matrix does not justify activation because it demonstrates parity, not portfolio-new value. |
| **Author and agent intent** | Humans and agents can safely declare invariants, goals, deadlines, and resource posture; Inkcheck verifies them mechanically and explains what it could not establish. | **6/10** | Typed assertions, additive goals, stages, MCP reports, capabilities, and scaffolding exist. Causal goal quality, checkpoint continuation, compact sessions, and the hosted assistant remain (#57, #60, #66, #81, #86, #87). |
| **Low-friction human trust** | A non-technical author can run, understand, cancel, and act on a check without learning search algorithms or wondering whether AI trained on the story. | **6/10** | Hosted async progress/cancel, deletion language, non-AI disclosure, and human findings exist. Intent presets, durable reconnect, accessibility, and clearer result windows remain (#40, #96). |
| **Demonstrated generalization** | Claims are supported across at least 20 consent-safe public stories or structural families, multiple budgets/depths/seeds, and medium/large projects as well as small-source/large-state stories. | **4/10** | The executable 20-family, 240-pair synthetic matrix is a useful foundation and exposes regressions honestly. It still lacks consent-safe medium/large public stories (#119), and *The Intercept* is considered a relatively small source file. |

## Engineering truths

| Engineering truth | 10/10 target | Current | Evidence and principal gap |
| --- | --- | ---: | --- |
| **Deterministic evidence and replay** | Fixed source/config/seed/policy/event log reproduces decisions, allocations, finding identities, and witness paths across supported platforms. | **8/10** | Fixed-seed engines, indexed witnesses, versioned schemas, decision logs, and cross-platform CI are strong. Resumable event-log replay and approximate-location identity need work (#63, #66, #84). |
| **Critical evidence cannot be averaged away** | Runtime errors and assertion violations remain separate, identity-based promotion gates; no aggregate score or terminal count can hide their loss. | **7/10** | Report/evaluator tiers and paired comparisons enforce the principle, and #105 removes the first semantic critical loss. The corpus remains too narrow and approximate-location identity drift is unresolved (#56, #84, #103). |
| **Portfolio-marginal value accounting** | Explorers and specialists earn discretionary work only for portfolio-new evidence or explicit intent progress; duplicate rediscovery is visible but not double-paid. | **5/10** | Portfolio reports retain own and portfolio-marginal curves, and policy replay reads marginal identity-based evidence (#105). Broad specialist integration and corpus evidence remain. |
| **Real protected probe floors** | Every active explorer receives an auditable cumulative integer service floor, with bounded debt across windows and no ceiling overrun. | **6/10** | Policy replay has an exact cumulative ledger, deterministic debt service, completion release, tiny-window rotation, exact 5M accounting, and requested-plan reconciliation that preserves small-story proof. It remains research-only pending #56. |
| **Bounded specialist economics** | Every specialist has evidence-based activation, a small initial probe, hard resource ceilings, marginal expansion, trap/saturation detection, and protected general/long-tail work. | **2/10** | The universal contract is specified in #107-#112; implementations and paired evidence remain ahead. |
| **Resource-safe execution** | State, depth, time, heap, frontier, disk, and campaign ceilings compose safely; constrained hosted deployments degrade cleanly. | **7/10** | Hard state/depth ceilings, memory/time guards, bounded curves, hosted limits, floor accounting, and partial reports exist. Checkpoint memory, concurrency, persistence, and campaign ceilings remain (#40, #93, #94, #98). |
| **Resumable shared search economy** | Diverse frontier/checkpoint states can be retained, compacted, resumed, partitioned, and shared across specialists without reparsing or restarting from the root. | **2/10** | Shared frontier and staged-goal foundations exist. Durable bounded checkpoints and resumable campaigns are not shipped (#63, #86, #98). |
| **Inspectable decisions** | Every automatic activation, allocation, forecast, contraction, and stop records policy version, factual inputs, uncertainty, reason, and binding constraint in compact human/agent forms. | **8/10** | Shadow decisions now expose grant/consumption scale, marginal yield rate, recency horizon, renewal/decay, and allocation gates. They are not yet live policy, and compact MCP forecasts/controls remain (#62, #95). |

## Durable product position

Inkcheck's defensible value is not “systematic search beats random search.” It is a reproducible hybrid:

1. Broad seeded probes vary early decisions and protect against traversal tunnel vision.
2. Systematic passes densely inspect regions and can prove finite reachable spaces when they truly finish.
3. Diversity search retains mechanically different states under bounded memory.
4. Ink-aware specialists target high-value structures such as gates, loops, assertions, and eligibility hubs.
5. Portfolio-marginal accounting funds useful new evidence rather than duplicate activity.
6. General and long-tail work remain protected because every specialist can become a budget trap.
7. Reports state exactly what was observed, estimated, bounded, or proved.

Random brute force remains complementary. Specialists are valuable when they exploit real Ink structure, but they must begin as bounded probes and earn expansion. Raw state novelty alone must not fund endless variable churn, loop unrolling, storylet permutations, or impossible-gate pursuit.

## Reassessment protocol

Each major epic or release should update this document in the same PR or an immediately linked scorecard PR:

1. Record the version/date and evidence artifacts that changed.
2. Re-score only dimensions affected by measured behavior.
3. Cite the fixtures, public corpus, budgets, resource measurements, and issues behind a change.
4. List critical and worst-family regressions before aggregate gains.
5. Permit scores to fall when a better test exposes a weakness.
6. File aligned issues for every newly material gap; close or reframe stale roadmap items.
7. Keep experimental behavior opt-in until the [search promotion policy](search-strategy-policy.md) passes.

This scorecard is a product-governance artifact, not a benchmark substitute. The machine-readable and Markdown evidence remains in the benchmark/evaluation outputs.
