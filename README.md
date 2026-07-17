# inkcheck

**Mechanical QA for [ink](https://github.com/inkle/ink) stories.** Compile checks, bounded systematic branch exploration, runtime-error repro paths, and dead-content detection — as a standalone CLI for writers and teams, with optional CI and MCP integrations.

inkcheck is a QA tool, not a writing tool. It does not generate, rewrite, or send away a word of prose. It exists so that the story *you* wrote can be checked mechanically: compile it with ink's official compiler, explore choice paths within explicit limits, and reproduce failures before a player finds them.

## Does it use AI?

No. inkcheck itself does not use AI, machine learning, LLMs, or generative models to test stories. It does not train on your source, infer prose changes, rewrite story text, or send story content to an AI service.

It is designed so humans, CI systems, and optional AI coding agents can all drive the same mechanical QA checks. The actual checking is deterministic code: the official ink compiler, the ink runtime, bounded branch exploration, and structured reports.

## Product promise

Inkcheck is bounded mechanical QA for ink stories. It does not prove that every path works in a large story. It deterministically explores reachable story states within explicit limits, reports exact repro paths for the issues it finds, and shows where — and why — coverage was partial, so authors can use it as cheap, repeatable regression insurance.

Inkcheck will not prove that a large interactive story has no bugs. Combinatorial explosion is real: loops, variables, randomness, and host-game code can create more possible states than any tool can exhaustively visit.

The promise is narrower and more useful: make mechanical story QA cheap, repeatable, and actionable. Inkcheck walks real reachable choice states within explicit limits, tells you when the run was partial, and turns failures into repro paths you can run again after a fix. If it finds a broken path today, that same configured check should be able to look for that path again tomorrow.

This is an open-source QA project because that boundary matters. If a report overclaims, misses an obvious pattern, needs a better traversal strategy, or fails on a story shape you can share safely, please bring a fixture or issue. The roadmap is about making partial coverage more transparent and more valuable, not pretending partial coverage becomes proof.

### Product direction and self-score

Inkcheck's future value is planned to come from a reproducible hybrid: broad seeded probes, systematic local inspection, bounded diversity search, and Ink-aware specialists for gates, loops, assertions, and storylet eligibility. Specialists must remain bounded and earn more work through portfolio-new evidence because they can become budget traps too.

The same bargain applies to hardware. Local CLI and one-shot MCP portfolio checks default to a deterministic 1,024-state live pilot that keeps small, depth-bound, and authored-frontier-saturated jobs sequential and activates bounded workers only for an open sustained frontier. Every pilot state counts under the original global ceiling; the search is not restarted to make the decision. Matched evaluation retained exact evidence and improved one 5M-state depth-100 *The Intercept* run by 25.6%, while constrained and hosted jobs retain explicit sequential ceilings. See the [concurrency evaluation](docs/concurrency-evaluation.md).

| Dimension | Current | 10/10 direction |
| --- | ---: | --- |
| Actionable, repeatable QA | **8/10** | Stable findings and exact replay across edit/CI/agent campaigns |
| Honest bounded evidence | **8/10** | Facts, estimates, limits, uncertainty, and proof always separated |
| Robust unknown-shape exploration | **6/10** | Broad cross-family value without traversal or fixture overfitting |
| Structured specialist advantage | **4/10** | Gates, loops, boundaries, and hubs tested by bounded expert probes |
| Anytime value per wall clock | **7/10** | Early result windows and deadlines exist; first-window sizing is still fixed |
| Author and agent intent | **8/10** | Safe invariants, goals, resource posture, and compact explanations |
| Demonstrated generalization | **4/10** | Predeclared multi-project corpus, including genuinely medium/large work |

These are separate scores, not an average. A high trust score cannot offset a lost runtime error. The detailed [product and engineering truths scorecard](docs/product-engineering-scorecard.md) defines every 10/10 target, current evidence, engineering constraints, and the reassessment protocol used at each epic or release. The first complete [policy v2 promotion evaluation](docs/promotion-policy-v2-evaluation.md) keeps dynamic allocation experimental rather than turning mixed evidence into a launch claim.

### Inkcheck 0.6 scope

Inkcheck 0.6 ships the anytime QA foundation without claiming a universally better dynamic search policy. The established bounded portfolio remains the search default. Workload-aware concurrency may left-shift results when a live pilot shows enough sustained work; durable campaigns can return, resume, and inspect source-bound result windows; humans and agents can choose named time/resource postures; and every automatic decision remains attributable. Long-tail expansion, rotation, and stopping stay shadow-only because the three-family promotion gate did not establish author-facing value broadly enough to make them live.

This is a completed release contract, not a claim that the larger research problem is solved. Dynamic first-window sizing, compact large checkpoints, provider-attributed cost, broader agent evaluation, and bounded specialist explorers remain separately tracked roadmap work. A future release may replace the fixed portfolio only after checked evidence clears the same critical-retention, replay, resource, and honesty gates.

### Proposed 0.7: Rules That Matter

The proposed 0.7 epic starts with first-class author-declared invariants: a human can state rules such as `gold >= 0`, and reports can distinguish a violation, a bounded non-finding, an invalid rule, and an earned exhaustive verification. Agents may draft typed rule proposals but may not silently authorize them. A separate, opt-in assertion-directed specialist may eventually search for an observed violation with additive budget, but it will not become default behavior or a coverage claim until it passes its preregistered evidence gate. The [Rules That Matter contract](docs/rules-that-matter-0.7.md) defines both boundaries.

### Agent campaign policies

MCP agents can start a durable campaign with a high-level `quick`, `balanced`, `deep`, `overnight`, or `campaign` mode instead of inventing explorer weights. `balanced` is the fresh-agent default; `fixed` preserves explicit legacy controls. Bounded overrides can change state/window/time/memory/disk/deadline posture, scarce/balanced/abundant resources, preferred value (`broad_qa`, `runtime_assertions`, `outcomes`, or `approved_goals`), protected long-tail work, and `ceilings` versus `knee` stopping. Exact base windows remain assertion/goal-free and resumable. Protected long-tail allocations now launch deterministic root-started portfolio children with an alternate search seed and deeper bound, while preserving the exact base checkpoint. A `runtime_assertions` campaign can add validated assertion windows with `add_assertions`; an `approved_goals` campaign can add a validated goal with `add_goal`. Every child uses an explicit grant, saves a separate evidence report, and receives credit only for campaign-new critical, intent, authored-knot, or terminal evidence.

The first [authored-story campaign-child evaluation](docs/campaign-directed-child-evaluation.md) found one credible stale-variable review lead and one rejected assertion hypothesis on *The Intercept*. Its staged goal missed, both high-budget children stopped on memory before 5M, and a 500K shared base exceeded the durable checkpoint cap. That is promising assertion value plus a clear warning: agent-authored rules need human validation, specialists need probe-to-expansion economics, and compact checkpoints are required before large campaigns become routine.

The matched [independent long-tail evaluation](docs/long-tail-partition-evaluation.md) then compared a growing shared frontier with protected root-started portfolio partitions. On a 5M *Intercept* campaign, the shared arm stopped on memory at 786,559 total states; nine independent children completed all 5M at lower peak heap and credited 3,558 campaign-new terminal variants versus 407. They found no new critical issue, authored knot, or visible ending. This is evidence for resource-efficient diversity and measurable diminishing returns, not a universal QA-value claim.

The subsequent three-family 0.6 promotion gate did **not** promote dynamic stopping or expansion. Dog Ink Adventure and Heresy II both hit a resource ceiling before their 500K base produced a resumable checkpoint, so no long-tail policy could act. On *The Intercept*, independent partitions reached 4.66M states at 1.40 GiB peak heap while the growing frontier stopped at 787K states and 3.70 GiB; terminal rediscovery rose from 34% to 94%, with no new critical issue, authored knot, or visible outcome. Inkcheck keeps these recommendations shadow-only and treats dynamic first-window sizing as the stronger next product requirement.

Every result window returns a stable policy ID, allocation reason, measured preferred yield, throughput/resource evidence, an uncertainty-labelled empirical range for another window, any binding constraint, and the report ID used to inspect full curves or findings. Compact inspection also names the latest window's purpose, partition, and marginal yield. A knee requires three consecutive windows with no preferred yield and cannot consume protected probes. It remains a bounded observation over the trajectories actually run, not a claim that the story is covered or that later discoveries do not exist. See the [campaign policy contract](docs/campaign-policy-contract.md) and [MCP result-window guide](docs/mcp-search-sessions.md).

After independent children run, the compact decision also includes a versioned **shadow-only** long-tail recommendation: expand the same family, rotate to another partition, or stop after the protected floor. It uses campaign-new value under the selected preference, reports recent yield per state and second, requires progressively more dry probes for scarce/balanced/abundant postures, and exposes compact selected-value rediscovery plus factual report-local discovery gaps. Older ledgers mark those signals unavailable. Rediscovery is identity overlap with earlier campaign reports, not raw duplicate-state work; widening gaps are observations, not plateau proof. `liveEffect: false` means this evidence cannot change allocation yet.

Humans can use the same durable policy without learning its controls: `inkcheck campaign story.ink` runs the balanced intent, while `--mode quick`, `deep`, or `overnight` chooses an outcome-and-time posture. It returns immutable source-bound result windows as work progresses, preserves the latest partial report on a deadline or cancellation between windows, and keeps technical state/time/memory/disk ceilings available as expert overrides. Result windows separate work spent, actionable yield, forecast uncertainty, and whether search can continue. A quiet discovery interval or observed knee is never described as complete coverage.

## Quick start

With Node.js 18 or newer:

```sh
npx -y inkcheck path/to/main.ink
```

No global install is required. The first run downloads the pinned official ink compiler, verifies its SHA-256 hash, and processes the story locally.

Want to see the failure-path report before trying your own story? Run the [two-minute synthetic demo](docs/two-minute-demo.md).

### Project configuration

Commit an `inkcheck.yml` when a project should use the same entrypoint and bounded CI settings for every human or agent session:

```yaml
schemaVersion: 1
entrypoint: story.ink
ci:
  maxDepth: 100
  maxStates: 1000000
  goalMaxStates: 250000
  seed: 1
  storySeed: 1
  search: portfolio
  concurrency: auto
  strict: true
assertions:
  - id: gold_nonnegative
    description: Gold never goes negative
    when: always
    condition:
      left: { variable: gold }
      operator: ">="
      right: { literal: 0 }
goals:
  - id: depleted_gold
    description: Seek paths where the player runs out of gold
    condition:
      left: { variable: gold }
      operator: "<="
      right: { literal: 0 }
```

Run `inkcheck validate-config` to check it. From that directory, `inkcheck` uses the configured entrypoint and defaults; explicit CLI flags still win. Unknown keys fail validation so unsupported external behavior and edit-policy fields cannot appear implemented. The published contract is [config schema v1](docs/config-schema-v1.json).

Assertions are typed data, never JavaScript or arbitrary Ink expressions. Operands are variables or scalar literals; comparisons use `==`, `!=`, `<`, `<=`, `>`, or `>=`, and conditions can compose with `all`, `any`, and `not`. Rules run always, at terminal states, or when entering a named knot. Unknown variables/knots and invalid cross-type comparisons fail before exploration spends its state budget. A violation always fails CI and includes the observed values plus an exact indexed replay witness. A bounded clean run means only “no violation observed”; only an exhaustive run reports the rule as exhaustively verified.

Goals use the same non-executable condition grammar, but guide exploration instead of failing CI. General exploration always receives the full `maxStates` budget. Set `goalMaxStates` in config or `--goal-states` on the CLI to add an explicit deterministic goal-proximity slice; it defaults to zero and the combined budget may not exceed 100,000,000 states. Goals are still observed during ordinary exploration when no extra slice is requested. A reached goal includes exact choice indices; a miss says `not_reached_within_limits` unless exhaustive exploration actually proves it unreachable. Reports expose baseline, goal, and total budgets separately so steering cannot silently displace general QA findings. See the comparison evidence in [search experiments](docs/search-experiments.md).

For a late compound dependency, replace `condition` with two or more ordered `stages`. Each stage uses the same typed grammar. Inkcheck seeks the first unmet cumulative milestone, so a later stage is reached only on a path whose state also satisfies every earlier stage. A missed prerequisite leaves later stages `blocked_by_stage`; it does not call them unreachable. This first staged contract uses one shared additional goal budget and restarts deterministically from the story root rather than serializing runtime checkpoints.

For a new project containing one `.ink` file, `inkcheck init` creates this config. Multi-file projects must name the root with `--entrypoint`. `inkcheck agent-kit --format codex` adds the config when needed, a pinned GitHub Actions example, `.inkcheck/` artifact ignore rules, and compact version-matched agent instructions. Both commands are idempotent and preflight every target; they refuse the whole operation rather than overwrite or partially modify existing authored files. The npm artifact also includes the canonical `skills/inkcheck/SKILL.md`, progressive Ink/workflow references, and ten executable golden exercises. `inkcheck capabilities --json` advertises this as `features.bundledAgentSkill` and remains the authority for the installed schema contract.

`--save-report` atomically stores a versioned report under `.inkcheck/reports/` and returns its stable content-and-entrypoint-derived ID. A later session can use `inkcheck artifacts list --json` and `inkcheck artifacts show <report-id> --json`; reopening reports whether the saved evidence is `current`, `stale`, or `path_changed` against the present entrypoint. Reports can contain story text, variables, and exact witnesses, so the agent kit ignores them by default. See [local report artifacts](docs/local-artifacts.md) for the trust, privacy, and compatibility contract.

Long base-shared runs can also persist their exact live frontier locally. Start with `--search=shared --no-min-repro --save-checkpoint`, then continue later with `inkcheck resume <checkpoint-id> --max-states N`; `N` is the larger total grant, not extra hidden work. `inkcheck checkpoints list/show` reports bounded metadata, durable compressed size, storage encoding, and source freshness. New checkpoint files are streamed gzip artifacts; older plain schema-v1 JSON remains readable. Checkpoints are private, atomic, source/config-bound, ignored by default, and retention-capped; they may contain authored text and runtime state. See [local resumable checkpoints](docs/local-checkpoints.md). MCP agents can use the same exact foundation through durable [`start_search` / `inspect_search` / `continue_search` / `cancel_search` result windows](docs/mcp-search-sessions.md). They can also use `add_goal` for an explicit additive directed probe that starts from the story root and leaves that exact base frontier untouched. Portfolio, shared-variable, assertions, directed-frontier resume, and hosted jobs do not use this checkpoint contract yet.

## Hosted checker

The repository now includes a self-hosted web interface for writers who do not want to use a terminal. Hosted mode temporarily uploads authorized `.ink` source, offers Quick (earlier 250K-state result) and Balanced (deeper 1M-state result) intents, creates a short-lived private job, streams real work, yield, and uncertainty signals, and deletes the temporary job directory after completion, cancellation, or failure. Completed hosted checks return a source-bound result-window identity and stable finding IDs. It does not make reports public or retain story text in application logs. Optional first-party usage metrics keep only daily aggregate counts and can produce unattended weekly reports without an analytics vendor.

The local CLI remains the privacy-first option because no story upload occurs. See [Hosted checker deployment](docs/hosted-checker.md) for the threat model, Docker deployment, operating limits, and a current sub-$50/month budget.

## What it catches

- **Compile errors and warnings** — broken diverts, unresolved variables, loose ends, with file and line numbers (via [inklecate](https://github.com/inkle/ink/releases), the official compiler)
- **Runtime errors with a reproduction path** — the exact sequence of choices that triggers a divide-by-zero, a bad external call, or out-of-content, e.g. `repro: [Enter in darkness → Descend to the cellar]`
- **Unvisited content, triaged** — knots no explored path visits within the configured limits, each classified with an inbound-divert scan: "no authored divert points here — possible orphan" versus "has inbound diverts — likely beyond this run's limits"
- **Distinct terminal states** — with a choice trail that reaches each one; differing final variables are retained as distinct outcomes

## vs. the alternatives

| | Catches syntax errors | Explores choice branches | Finds unvisited content | Repro path for crashes | Runs in CI |
| --- | :---: | :---: | :---: | :---: | :---: |
| **`inklecate` (compiler)** | ✓ | — | — | — | ✓ |
| **Manual playtesting** | — | only what you click | by luck | if you remember your clicks | — |
| **Ink-Tester** | ✓ | random repeated runs | line coverage | limited | manual/CLI |
| **inkcheck** | ✓ | systematic + seeded random, bounded | knot coverage | ✓ | ✓ |

The compiler tells you the story is *valid*. Clicking through tells you the paths you *happened to click* work. [Ink-Tester](https://github.com/wildwinter/Ink-Tester) repeatedly samples random playthroughs and reports line-level frequency; inkcheck instead walks choice states systematically and returns short failure paths. The key difference is repeatability: after you fix a reported path, the same configured run can check that path again. The approaches are complementary, especially for stories with randomness or engine integrations.

## Example

```
$ inkcheck examples/manor.ink
✓ compiled — 92 words, 7 knots, 6 choices
✓ explored 18050 states within limits (depth 100, 10000000 states, seed 1) — exhaustive (every reachable state visited) — 5 distinct terminal state(s)
    terminal via [Enter in darkness → Search the study → Leave with your loot]: "You slip out the servant door, heavier by half a purse."
    ...
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar] (found by dfs:last)
⚠ 1 knot(s) never visited on any explored path — unreached is not necessarily unreachable:
    treasure_vault (manor.ink line 35) — no authored divert points here — possible orphan
```

When a run is cut short, the report names the limit that actually bound it — for example `⚠ coverage is partial, not a proof — paths were cut at 30 choices deep; raise --max-depth to follow longer trails`. Depth and state budget are separate axes: in local runs on *The Intercept*, raising `--max-depth` from 30 to 100 reached more late-story content with a 1,000,000-state budget than a 10× larger budget did at depth 30.

Exit code is non-zero on compile or runtime errors. Add `--strict` to also fail on warnings, unvisited knots, truncation, or external stubs, so partial coverage cannot silently pass CI.

A story does not have to be long to exceed the default budget. Inkle's published [*The Intercept*](https://github.com/inkle/the-intercept) is considered a relatively small source file by the community, yet Inkcheck still reports it partial at 5,000,000 states: branching plus persistent variables creates a reachable-state graph far larger than the visible choice count suggests. Exhaustion is an observed proof, not an expectation inferred from source size. A finite-valued story may be exhaustible in principle but impractical to enumerate; turn, random, or unbounded variable state can make the semantic graph unbounded. A bounded run stops on whichever comes first — state, depth, time, or memory — and says which. The hosted checker caps shared jobs at 1,000,000 states; larger jobs (up to the CLI's 100M ceiling) belong locally. See [Performance and memory](#performance-and-memory) for sizing guidance.

Within a single run, inkcheck spends its state budget across complementary search passes rather than betting everything on one traversal order. The current CLI portfolio explores last-choice-first, first-choice-first, and inside-out DFS slices, adds a seeded random-sampling slice that varies early-choice prefixes the deterministic passes tend to repeat, adds a frontier-capped diversity beam that advances level-by-level like BFS while keeping one state per variable-signature lineage, then reserves a small breadth-first slice to shorten repro paths. The random slice uses a fixed default seed and the beam needs no seed at all, so runs stay reproducible in CI; every reported ending and runtime error names the pass (and seed) that found it. This often finds more endings and reachable knots at the same `--max-states` limit, but it is still bounded QA: a truncated report is useful evidence, not an exhaustive proof.

`--search=shared` opts into an experimental alternative: deep, novelty-first, and seeded views draw from one deduplicated frontier and each reachable state is expanded at most once. This can spend a tight budget more efficiently when several strategies would otherwise rediscover the same state. JSON telemetry separates pending and active checkpoint JSON/variables, retained witness ancestry, dedupe and semantic indexes, frontier references, and findings; it also reports released ancestry and stale-view compactions. These are deterministic accounted payload/structural estimates, not exact V8 heap usage. It is not the default yet: some early-choice structures may still favor the portfolio's independent random and beam passes.

Library consumers evaluating long-running shared jobs can use `exploreSharedResumable(...)`. When budget remains, it returns a source-bound, versioned JSON checkpoint containing the exact live base-shared frontier; a later call raises the total grant (for example 100k to 1m) and continues without replaying the first 100k. Split-run equivalence is regression-tested against an uninterrupted run. This is an engine foundation, not yet a CLI persistence feature: checkpoints may contain authored text, variables, runtime state, and witness paths, and schema v1 deliberately excludes assertions, goals, and variable/goal-aware shared modes. See [shared checkpoint schema v1](docs/shared-checkpoint-schema-v1.md).

`--search=shared-variable` is a narrower experiment that gives 12.5% of shared-frontier selections to states reached through uncommon variable snapshots or transitions. The boost is bounded and the deep, novelty, and seeded views remain active. It can help mechanically driven storylet graphs, but it is not uniformly better; the checked-in [comparison table](docs/search-experiments.md) includes both gains and regressions.

The adaptive portfolio remains the general-purpose default. Experimental modes do not change its weights or behavior. Inkcheck's [search strategy policy](docs/search-strategy-policy.md) defines the benchmark breadth and regression gates required before any future default change.

### Bounded search vs random sampling

Inkcheck is not a promise to visit every possible state in a non-trivial story. Branches, loops, variables, random behavior, and host-game integrations can make exhaustive coverage physically impractical. Its practical advantage over random sampling is reproducibility: given the same story and limits, inkcheck walks the choice graph systematically, returns exact choice paths for failures, reports unvisited-knot clues, and says explicitly when the run was partial.

Random sampling remains useful, especially for stories with randomness or huge state spaces. Treat the approaches as complementary: random play can stumble into surprising paths, while inkcheck gives deterministic CI-friendly evidence inside a declared budget.

In a local test of *The Intercept* at a depth limit of 30, higher budgets found more terminal states but still did not prove complete coverage. Timings are from one local development machine and should be read as scale evidence, not a universal benchmark:

| State budget | Time | Distinct terminal states | Runtime errors | Unvisited knots | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 50,000 | 9.4s | 7 | 0 | 9 | truncated |
| 100,000 | 19.9s | 10 | 0 | 9 | truncated |
| 500,000 | 100.2s | 17 | 0 | 8 | truncated |
| 1,000,000 | 205.5s | 25 | 0 | 8 | truncated |

That is the intended interpretation: each run tests real reachable states and can surface real broken paths, but a truncated report is evidence about what was visited, not proof that everything was reachable or correct.

## Performance and memory

The default budget is 10,000,000 states and the ceiling is 100,000,000, so it is worth knowing what a big run costs. Two resources bound a run: **time** and **memory**. Small or exhaustible stories touch neither — the portfolio early-exits the moment a systematic pass proves the reachable space complete, so `inkcheck small.ink` finishes in the handful of states it has regardless of the default. The numbers below matter only for large, non-exhaustive stories.

**Time** scales roughly linearly with states explored. On one development machine, *The Intercept* ran about 200 seconds per million states (see the table above), so a 10M-state run is tens of minutes and a 100M run is hours. There is no wall-clock limit on the local CLI, so for CI or interactive use, pin `--max-states` to the coverage you actually need rather than relying on the default — or run the default with `--progress` (on by default in an interactive terminal) so you can watch and interrupt.

**Memory** is a sum of terms with different growth, and it is why the ceiling is high rather than dangerous:

| What grows | How it scales | Notes |
| --- | --- | --- |
| Deduplication hash set (`seenStates`) | **~linear**, ≈200 bytes per *distinct* state | The dominant term. inkcheck stores a hash per state, not the state, which is what makes millions of states affordable. |
| DFS / beam frontier | **flat** | DFS is bounded by depth; the beam has a hard frontier cap. Neither grows with the budget. |
| Random sampling | **flat** (O of findings) | Keeps no dedup structure. |
| BFS repro-shortening frontier | **the one super-linear risk** | On a deep, loop-light, branching story it can balloon (a research run queued ~631K full states). `--no-min-repro` removes this slice entirely. |
| Experimental shared frontier | **shape-dependent, potentially linear** | Retains serialized pending checkpoints plus witness ancestry. Reports expose component high-water marks; optional `--max-frontier-states` / `--max-frontier-memory` envelopes stop cleanly before this live queue exceeds an explicit bound. |

Two practical rules of thumb from that:

- **Budget heap, not just states.** As a worst-case estimate (no state deduplication), plan for roughly **2 GB of heap per 10M distinct states**. Stories with loops deduplicate heavily and use far less; a low-dedup story uses close to the worst case. So a 10M-state run's worst case (~2 GB) sits near Node's default heap limit: a loop-heavy story stays well under it, but a large low-dedup one can reach the memory guard before finishing even at the default budget. A 100M-state run exceeds a normal default heap and will stop at the guard unless you raise `--max-old-space-size`. Either way it stops cleanly with a partial report — the guard is what makes the high ceiling safe to point at, not a promise the run will complete.
- **The memory guard is the real limiter, not the ceiling.** A run stops cleanly at 85% of the V8 heap (or your `--max-memory`) and returns a *partial* report with `truncatedBy.memory` rather than crashing. So setting `--max-states 100000000` is not reckless — on a normal machine the guard, not the ceiling, decides where it stops. To go further, give Node more heap: `NODE_OPTIONS=--max-old-space-size=8192 inkcheck big.ink --max-states 100000000`.
- **Safety limits are not efficiency decisions.** State, time, and memory caps answer “how far may this job go?” They do not claim that using the whole machine is valuable or that an apparent plateau is complete. The 0.6 research path measures portfolio-new findings over time, throughput, recovery gaps, peak RSS, and retained-frontier bytes so future quick/balanced/deep policies can choose useful result windows while still reserving long-tail probes. Fixed limits remain available for CI and audit.

Levers, in order of impact, when a story is too big to finish: raise `--max-old-space-size` (more headroom), pass `--no-min-repro` (drops the super-linear BFS frontier), lower `--max-states` (bounds both time and memory), or split the story and check parts separately. In experimental shared mode, set `--max-frontier-memory` or `--max-frontier-states` when the pending-checkpoint queue itself needs a tighter bound, and raise that envelope only when its report shows useful evidence continuing to arrive. The `nextRun` verdict names the binding limit after each run so you know which lever applies.

The measured [resource-safe deep-run evaluation](docs/resource-guard-evaluation.md) records how the guards behave on authored 5M-ceiling jobs, including shared-frontier pending-state and serialized-byte high-water evidence.

## MCP server

Tools for AI agents working on ink stories:

| Tool or logical operation | What it does |
| --- | --- |
| `inkcheck_capabilities` | Versioned schemas, limits, search modes, and explicit feature availability |
| `inspect_story` | Source-only project map: includes, shape, semantics, externals, knots, and variables |
| `compile_story` | Structured compile issues (severity, file, line) |
| `start_search` | Start one durable exact shared-search result window and receive a bearer capability |
| `inkcheck_workflow` | Route post-discovery search, campaign, finding, replay, regression, assertion, goal, cancellation, and playtest operations through one bounded schema |

Add to Claude Code:

```sh
claude mcp add inkcheck -- npx -y inkcheck mcp
```

or to any MCP client config:

```json
{
  "mcpServers": {
    "inkcheck": { "command": "npx", "args": ["-y", "inkcheck", "mcp"] }
  }
}
```

The default MCP profile exposes five tools: `inkcheck_capabilities`, `inspect_story`, `compile_story`, `start_search`, and `inkcheck_workflow`. This keeps fresh-agent bootstrap context small; capabilities lists the router's logical operations and request fields. Set `INKCHECK_MCP_PROFILE=full` only for clients that require every operation as a separate named tool.

The compact agent loop is `inkcheck_capabilities` -> `inspect_story` -> `compile_story` -> `start_search` -> route finding/replay/regression operations through `inkcheck_workflow` -> fix -> compile and verify. Result-window sessions are the default agent path because they are durable, bounded, paginated, and source-bound. Logical `start_campaign` / `continue_campaign` operations add an aggregate policy and measured spend/provenance around the same exact shared frontier; ordinary `start_search` / `continue_search` retain explicit cumulative-grant control. Calls are synchronous, so cancellation is trustworthy at returned durable boundaries, not mid-window preemption. `inspect_search` stays privacy-minimal; `add_goal` can spend a separately reported directed budget without weakening the exact base search, and `replay_witness` is the explicit boundary that returns one current transcript, choice trail, and variable state. For runtime failures, `pin_regression` before editing and `check_regression` afterward provide a deterministic fixed/still-failing/path-changed verdict without another search run. See [the bundled skill](skills/inkcheck/SKILL.md) and [MCP result-window sessions](docs/mcp-search-sessions.md).

## CLI

```
inkcheck capabilities [--json]
inkcheck inspect <story.ink> [--json]
inkcheck <story.ink> [--max-depth N] [--max-states N] [--seed N] [--story-seed N] [--search=portfolio|shared|shared-variable] [--concurrency auto|N] [--max-frontier-states N] [--max-frontier-memory MB] [--auto] [--profile] [--next] [--no-min-repro] [--strict] [--save-report] [--save-checkpoint] [--progress=auto|human|ndjson|off] [--human|--json|--markdown]
inkcheck artifacts list [--json]
inkcheck artifacts show <report-id> [--json]
inkcheck artifacts findings <report-id> [--limit N] [--cursor C] [--json]
inkcheck artifacts finding <report-id> <finding-id> [--json]
inkcheck artifacts replay <report-id> <finding-id> [--json]
inkcheck artifacts delete <report-id> [--apply] [--json]
inkcheck artifacts prune --keep N [--apply] [--json]
inkcheck checkpoints list [--json]
inkcheck checkpoints show <checkpoint-id> [--json]
inkcheck resume <checkpoint-id> --max-states N [--json]
inkcheck mcp    # start the MCP server on stdio
```

`inkcheck capabilities --json` lets agents check schema versions, limits, search modes, and explicit supported or unavailable features before relying on them. `inkcheck inspect story.ink --json` performs deterministic source-only discovery without compiling or exploring: it follows project-local includes and returns a bounded map of story shape, semantics, externals, knots/functions, and variable declarations/reads/writes. See the [agent discovery contract](docs/agent-discovery.md).

JSON checks use the versioned [report schema](docs/report-schema-v1.md). Findings have stable IDs and normalized kinds; ending and runtime-error witnesses carry both human choice text and zero-based choice indices, so duplicate labels remain exactly replayable through `playtest_story`. The envelope records the Inkcheck version, compiled-story fingerprint, effective configuration, binding limit, and an observation-only `shadowDecision` while retaining the established `compile`, `stats`, `explore`, and `nextRun` sections.

`--concurrency auto` is the local portfolio default. It sets a four-lane ceiling, not four unconditional workers: one inside-out DFS pass runs for at most 1,024 states, then the versioned classifier stays sequential when the story exhausts, depth binds, authored knots are already saturated, hardware has one core, or memory cannot safely fund workers. An open sustained frontier keeps that live pass in the parent while untouched passes begin in persistent workers. `--concurrency 1` is a hard sequential opt-out; explicit values 2-16 preserve a fixed worker ceiling without workload classification. Shared search and additive-goal runs automatically stay sequential unless an incompatible fixed value was explicitly requested.

Reports expose `concurrencyMode`, the resolved ceiling, the activation policy/decision/reason, pilot work, effective workers, aggregate heap plan, and duplicate evaluations (zero for the production policy). Worker failure retains the latest completed evidence and reports `truncatedBy.worker`; it never masquerades as a state-budget stop. Hosted deployments pass their own explicit per-job ceiling, defaulting to one on the production container, and real child cancellation cleans temporary uploads. Peak RSS can be higher because V8/runtime overhead is not heap; the classifier estimates workload shape, not coverage completeness.

MCP uses [compact machine output](docs/machine-output.md) by default: inspection is capped at 16 KiB and compilation, statistics, one-shot exploration, and result-window responses at 32 KiB. Output omission is reported separately from bounded-search truncation. Full story-bearing reports remain available only through explicit detail or drill-down calls.

Saved reports support bounded finding drill-down without loading the full report. `artifacts findings` returns at most 20 privacy-minimal summaries by default (maximum 100) and a report-bound cursor; summaries omit story prose, variables, choice text, and witness paths. `artifacts finding` fetches one complete stable finding. `artifacts replay` recompiles the saved entrypoint and follows that finding's indexed choices with its saved story seed, but only while artifact freshness is `current`; stale or moved source fails closed.

Report storage is private and bounded: one report may use at most 256 MiB and all reports in one project may use at most 1 GiB. A save over either ceiling fails without deleting old evidence. `artifacts delete` and `artifacts prune --keep N` preview by default and mutate only with `--apply`; prune keeps the newest N reports for each entrypoint and removes at most 100 per invocation. This explicit lifecycle prevents a stable report ID from disappearing merely because another run finished.

Maintainers can compare shadow recommendations across independent budget runs with the manifest-driven [shadow policy evaluator](docs/shadow-policy-evaluation.md). The separate [search promotion benchmark](docs/promotion-benchmark.md) runs matched baseline/candidate matrices across a checked-in 20-family corpus plus a pinned consent-safe authored-project tier, reports resource observations and worst-family/project losses, and never declares a winner. The first [authored-project evaluation](docs/authored-project-promotion-evaluation.md) found parity where cells completed and meaningful project-shape resource limits, not a policy-v2 advantage. Neither tool calls a bounded larger run an oracle or changes the default policy.

`--max-depth` accepts 1–1,000 and `--max-states` accepts 1–100,000,000, with a **default budget of 10,000,000**. These hard ceilings prevent malformed automation inputs from accidentally disabling the exploration bounds. The default is deliberately ambitious because three things make a big budget safe rather than reckless: a fully-explorable story early-exits the moment a systematic pass proves it exhaustive (so small stories still finish in a handful of states), the memory guard stops cleanly before an out-of-memory crash, and progress reporting lets you watch and interrupt a long run. A large, non-exhaustive story will therefore *use* that budget — see [Performance and memory](#performance-and-memory) before running one in CI, and pin a smaller `--max-states` there if a bounded runtime matters more than depth of coverage.

`--max-states` is a total budget for the run, not a promise that one single DFS walk will spend all states. By default the CLI divides most of that budget across three complementary DFS views of the choice tree plus a seeded random-sampling slice, and keeps a small breadth-first slice for shorter failure and ending repro paths. Use `--no-min-repro` to spend that repro slice on the DFS portfolio instead when breadth-first shortening is less important than broader search.

`--seed` (default 1) controls only Inkcheck's random-sampling search slice. `--story-seed` (default 1) independently sets Ink's initial runtime RNG state for `RANDOM()` and shuffle behavior. Keep both fixed for repeatable CI and exact witness replay; change `--seed` to sample different choice walks, or deliberately change `--story-seed` to exercise another valid story-randomness sequence. Authored `SEED_RANDOM(...)` commands still take effect and can override the initial story seed. Inkcheck records both seeds and carries `storySeed` in replay instructions, but one run does not enumerate every possible story seed. Each finding's `foundBy` field in `--json` output names the pass that discovered it, e.g. `dfs:last` or `random:seed=1`.

`--search=shared` selects the experimental shared-state multi-frontier engine; `--search=portfolio` is the unchanged default. Shared mode remains deterministic for a fixed seed and still honors depth, state, memory, time, progress, and repro-shortening controls.

`--save-checkpoint` is deliberately narrower than ordinary shared search: it requires `--search=shared --no-min-repro` and no assertions, goals, `--auto`, `--next`, or report artifact in the same command. When live work remains, JSON output includes a source-bound checkpoint ID. `inkcheck resume <id> --max-states N` requires the source and search bindings to match and `N` to exceed the checkpoint's prior total grant; it automatically saves the next generation. Completed and resource-stopped searches return their report without inventing a resumable checkpoint.

`--search=shared-variable` adds a small variable-rarity frontier to shared search. It prioritizes observed uncommon variable values and changes mechanically; it does not use AI, understand story meaning, or infer which values are desirable.

`--max-frontier-states` and `--max-frontier-memory` are optional shared-search safety envelopes for retained pending checkpoints. Neither has a default: Inkcheck does not impose a low universal frontier cap. If an explicit envelope binds, the run keeps its findings, reports `truncatedBy.frontier`, and does not mislabel the stop as state-budget exhaustion. The same controls are available as `ci.maxFrontierStates` / `ci.maxFrontierMb` and MCP `explore_story` inputs.

`--max-memory <mb>` caps how much heap the run may use before it stops cleanly. A V8 heap out-of-memory abort cannot be caught after the fact, so inkcheck watches memory during exploration and — before it would crash — stops, keeps everything found so far, and reports `truncatedBy.memory` with a partial report rather than losing the run. The default cap is 85% of the V8 heap limit (which honors any `NODE_OPTIONS=--max-old-space-size` you set), so large runs on modest hardware degrade gracefully instead of dying; pass an explicit value to tighten or loosen it. On a memory stop the `nextRun` verdict is `investigate` (raise `--max-old-space-size`, lower `--max-states`, or split the story) — never `broaden`, since more budget would only hit the wall sooner.

`--max-time <s>` is the wall-clock counterpart: after `s` seconds the run stops cleanly and returns the partial report it has (`truncatedBy.time`) instead of running to the state budget. There is no default time limit on the local CLI. It's meant for CI or any context that needs a bounded runtime but still wants the findings so far — the same graceful-partial idea as the memory guard, applied to time. The hosted web checker sets this automatically, just under its hard timeout, so a slow story hands back a partial report rather than being killed.

`--profile` prints a cheap static shape profile of the story — variables and where they are assigned, choice density, the longest divert path — plus the depth limit and pass weights inkcheck would choose for that shape, without running any exploration. `--auto` applies those suggestions: it raises `--max-depth` when static divert paths outrun the default (never lowers it, and your explicit flags always win) and hands the profile's pass weights to the portfolio. On a story whose main path is 40 choices deep, default settings find nothing while `--auto` reaches the ending and proves the story exhaustive in ~111 states.

Interactive terminals show a concise live progress line by default: real phase, states explored against the configured **work budget**, discoveries, and elapsed time. `--progress=human` forces readable snapshots for CI logs; `--progress=ndjson` writes versioned events for agents and parsers; `--progress=off` silences progress. None of these percentages claim story coverage. The final stdout report remains authoritative, and progress never includes story prose, choices, variables, or source snippets.

Every report also carries a `nextRun` verdict — a small closed vocabulary (`stop`, `deepen`, `broaden`, `reseed`, `investigate`) computed deterministically from the report itself, with concrete flags, a rationale that cites the fields it used, and the evidence-backed expected gain. `--next` acts on it: after the check, inkcheck applies the recommended escalation and reruns, up to three times, stopping on a `stop`/`investigate` verdict, at the flag ceilings, or when an escalated run finds nothing new (fixpoint). The per-run trail lands in `--json` output as `runs`; hop narration goes to stderr so machine output stays clean. Recommendations never exceed the documented hard ceilings — when no flag increase has evidence behind it, the verdict degrades to `investigate` and points at the knots worth reviewing.

GitHub Actions:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- name: Check the story and publish a readable summary
  shell: bash
  run: |
    set -o pipefail
    npx -y inkcheck story/main.ink --strict --markdown --max-states 500000 | tee -a "$GITHUB_STEP_SUMMARY"
```

The example pins `--max-states 500000` so the job has a predictable runtime; the default budget is 10,000,000, which a large, non-exhaustive story would actually spend (see [Performance and memory](#performance-and-memory)). Pin a budget in CI whenever a bounded wall-clock matters more than maximum coverage.

`--strict` fails not only on warnings and unvisited knots, but also when exploration is truncated or an `EXTERNAL` function had to be stubbed. This prevents a partial check from wearing a green “complete” badge.

See the [InkJam QA guide](docs/inkjam-qa-guide.md) for a writer-friendly setup and help interpreting the report.

Found a misleading result? Use the public issue forms to [report an incorrect or missed result](https://github.com/chaoz23/inkcheck/issues/new?template=false-report.yml), [offer a licensed minimal fixture](https://github.com/chaoz23/inkcheck/issues/new?template=public-fixture.yml), or [request an opt-in QA clinic check](https://github.com/chaoz23/inkcheck/issues/new?template=qa-clinic.yml). Never attach private, embargoed, or jam-restricted story material to a public issue.

## For humans, CI, and agents

inkcheck can be driven by a human at a terminal, a CI job, or an optional AI coding agent. The tool itself still does not use AI; agents are just another caller of the CLI or MCP server.

- **Machine-readable interface:** `tool.json` at the repo root describes the CLI flags, MCP tools, exit codes, and `--json` output shape in one file.
- **`--json`** emits the entire report as a single JSON object (`{ compile, stats, explore }`) on stdout — parse that instead of scraping the pretty output. `explore.passes` keeps a bounded pass-local `discoveryCurve` (“what this explorer found”) plus a portfolio-only `portfolioMarginalCurve` (“what this explorer added first”), separating exact terminals, visible outcomes, runtime errors, assertions, goals/stages, knots, and comparable novelty. Summaries preserve first/latest discovery states and dry-gap facts despite compaction. Portfolio reports also include a run-wide curve in actual interleaved execution order; wall time stays observational in progress events. `explore.schedule` shows how adaptive rounds spent the budget. The versioned `shadowDecision` shows what the future anytime policy would recommend and why, including protected per-pass floors and uncertainty. It is observation-only (`applied: false`): it never changes today's search or claims bounded coverage is proof.
- **`--progress=ndjson`** emits versioned lifecycle and work-progress events on stderr for an agent or CI log parser. `statesExplored / stateBudget` is budget use, not story coverage; the final stdout report remains authoritative. See the [NDJSON progress contract](docs/progress-ndjson.md).
- **`--human`** emits a prioritized fix list grouped by errors, warnings, and notes, with file/line locations where available, choice paths for runtime failures, and a next step for each finding.
- **`--markdown`** emits a GitHub Step Summary-friendly report for humans reviewing CI.
- **Deterministic exit codes:** `0` clean · `1` compile/runtime errors (or, under `--strict`, warnings, unvisited knots, truncation, or external stubs) · `2` usage error. Branch on the exit code; don't grep the text.
- **MCP:** `claude mcp add inkcheck -- npx -y inkcheck mcp` exposes the compact five-tool agent profile. Use `INKCHECK_MCP_PROFILE=full` for the compatibility catalog.
- **The loop:** edit `.ink` -> `compile_story` -> `start_search` -> route the next evidence action through `inkcheck_workflow` -> fix -> compile and verify. inkcheck is a repeatable mechanical check for a story graph you generated or edited; use it to verify your own work before returning it.
- **The coverage loop:** `explore_story` (and CLI `--json`) returns `nextRun` — switch on its `recommendation` (`stop` / `deepen` / `broaden` / `reseed` / `investigate`) and rerun with `nextRun.flags` until `stop: true`. Or let the CLI drive it: `inkcheck story.ink --next`.

`llms.txt` at the repo root is a compact, model-friendly summary of all of the above.

## How it works

- **Compilation** uses `inklecate`, the canonical compiler — found via `$INKLECATE_PATH`, then `PATH`, then auto-downloaded from the pinned official ink 1.2.1 release into `~/.cache/inkcheck` on first run. Downloaded archives are verified against pinned SHA-256 hashes before extraction. Stories are compiled with `-c` so all knot visits are counted.
- **Exploration** runs the compiled story in [inkjs](https://github.com/y-lohse/inkjs) (the official JS runtime port), reusing pooled story instances so the compiled JSON is parsed once per pass and states rewind via `LoadJson`. Inkcheck initializes story randomness from `--story-seed` (default 1), then preserves Ink's RNG state in every saved branch; authored `SEED_RANDOM(...)` remains authoritative when executed. States are deduplicated by content hash. `INCLUDE`s are followed.
- The CLI uses a bounded, adaptive portfolio search. Complementary passes — last-choice-first, first-choice-first, and inside-out DFS, a diversity-first beam, and seeded random walks — run interleaved in ten deterministic rounds. Initial weights (roughly 20/20/26/15/20%, or a shape profile's suggestion under `--auto`) are reallocated each round toward passes whose findings are still growing, with an intended 8% fractional floor per active pass. Research-only policy replay turns that intent into auditable cumulative integer service and normalizes recency to each pass's observed execution windows instead of a global state count. It requires three windows before estimating yield, expires signals after one or two measured windows without renewal, and permits experimental allocation overlays only for renewed runtime/assertion evidence or explicit goal progress; broad coverage stays with the established scheduler. The production scheduler remains unchanged until the full promotion corpus passes. The passes are complementary: the DFS orderings systematically exhaust subtrees, the beam spreads budget across variable-state lineages within a hard frontier cap, and random walks re-roll every choice point so early-choice combinations get sampled instead of repeated. Findings merge into one report, each labeled with the pass that found it, and the executed schedule appears in `--json` output.
- Workload-aware `--concurrency auto` is the local portfolio default. Its live 1,024-state inside-out DFS pilot becomes the prefix of the normal first adaptive round, then either continues sequentially or overlaps untouched passes in bounded persistent workers. The 80-cell 100K gate retained exact findings, proof, and adaptive schedules with only two open-frontier activations; matched 5M *The Intercept* depth-30/depth-100 gates retained exact evidence, rejected the depth-bound job, and improved the sustained job from 657.7s to 489.0s. Every state remains inside one ceiling and duplicate pilot evaluations are zero. Explicit `1` preserves sequential execution; explicit 2-16 ceilings preserve fixed concurrency. See the [concurrency evaluation](docs/concurrency-evaluation.md).
- Experimental `--search=shared` keeps one global state identity and exposes the pending work through deep, novelty, and seeded frontier views. A state chosen by any view is expanded once; expanded checkpoint JSON is released immediately, compact parent links survive only while a pending descendant needs the exact repro path, and stale view IDs are periodically compacted. Reports expose component accounting and optional explicit checkpoint envelopes. Variable-state and variable-transition rarity are recorded as evaluation telemetry.
- Experimental `--search=shared-variable` replaces one of every eight shared-frontier selections with a variable-rarity view. Its score combines the observed frequency of the destination variable snapshot and the rarest change on that edge; it cannot consume more than its fixed slice, so graph novelty, depth, and seeded exploration remain represented.
- The moment any systematic pass visits every reachable state without hitting a limit, the whole portfolio stops: every further state would be redundant. A small fully-explorable story at the default 10,000,000-state budget still finishes in the handful of states it actually has — the large default costs nothing when a story is exhaustible.
- The beam pass answers "what should a beam optimize for" concretely: survivors are selected round-robin across variable-signature groups (diversity first), ranked within each group by novelty — newly visited knots, then new variable signatures, then new offered-choice sets. It is deterministic without a seed, and it reports the run as truncated whenever it had to prune a reachable state, so a beam never silently claims complete coverage.
- Unless skipped with `--no-min-repro`, the CLI reserves about 10% of the requested `--max-states` budget for a breadth-first repro-shortening slice. BFS reaches shared findings by shorter choice trails where possible and may contribute extra shallow findings.
- Bounds (`--max-depth`, `--max-states`) keep worst-case combinatorics in check; the report says explicitly when it was truncated.

## Coverage limits

- Exploration is bounded. A truncated report is evidence about visited states, not proof about the whole story.
- Reports state the limits they ran under (depth, state budget, search seed, and story seed) and, when truncated, which limit actually cut coverage (`truncatedBy` in `--json`, including `memory`) with targeted advice on which flag to raise.
- A large run that would exhaust memory stops cleanly and returns a partial report (`truncatedBy.memory`) rather than crashing — memory footprint is dominated by the deduplication hash set (~linear in distinct states) and, on deep loop-light stories, the breadth-first repro frontier, so `--no-min-repro` and a tighter `--max-states` are the levers when a story is too big to finish.
- Small stories often get the opposite guarantee: when a systematic pass visits every reachable state without hitting a limit, the report says so (`exhaustive`), and sampling-slice budget exhaustion no longer counts as truncation.
- `EXTERNAL` functions are stubbed to zero because the host game is unavailable. The report names every stub; strict mode fails rather than claiming complete coverage.
- Random behavior is repeatable for the reported story seed, but one run does not enumerate every possible story seed. Deliberately vary `--story-seed` and keep human playtesting in the loop when outcome frequency matters.
- An unvisited knot may be intentionally dormant, engine-entered, or unreachable. The inbound-divert triage separates likely orphans from probably-limit-bound content, but it is a review prompt, not an automatic deletion instruction.

## Roadmap

The roadmap is governed by the [product and engineering truths scorecard](docs/product-engineering-scorecard.md). Every epic should improve measured value without weakening bounded-coverage honesty, critical-evidence retention, deterministic replay, or resource ceilings.

- Coverage transparency: clearer reporting for truncation, depth limits, visited endings, skipped search space, and what was or was not explored.
- Report quality: better source locations, shorter repro paths, stable issue identities, and clearer grouping of runtime errors, unvisited knots, and coverage limits.
- Author-defined story assertions: deterministic project rules such as "gold never goes negative", "health never exceeds max", or "required variables are set before endings."
- Goal-directed variable search: let authors and agents seek approved states while preserving a protected general-search budget and exact bounded-coverage language.
- Optional hosted AI goal assistant: a first-class, explicitly enabled human interface that helps non-technical authors propose variable goals and assertions for approval, then delegates all execution and verification to Inkcheck's deterministic non-AI engine. Provider, consent, source-sharing, retention, cost, and disable controls must be explicit; generated rules are never silently trusted or applied.
- Repro persistence: remember known failing paths and make sure future runs keep checking them even as traversal strategies improve.
- Compact campaign checkpoints: retain and resume useful large-story frontiers without checkpoint artifacts dominating memory or disk, and degrade to an immutable partial report before serialization limits.
- Public compatibility fixtures: consent-safe examples and synthetic edge cases for regression testing, performance comparisons, and trust-building.
- Agent readiness: the executable [agent-readiness benchmark](docs/agent-readiness-benchmark.md) pins a no-hidden-hints protocol, deterministic runtime/assertion fixture, bootstrap/tool/reference/safety/proof targets, machine scorer, and separate tool/skill/model/environment attribution. Two passing observational runs from distinct agent implementations remain the release gate (#67).
- Search promotion harness: a broad, predeclared scorecard across structural families, budgets, depths, and seeds before any experimental strategy can change the default.
- Bounded specialist search: detect mechanical shapes and dispatch small expert probes for compound gates, loops/counters, storylet eligibility, assertion boundaries, and behavioral frontier diversity (#107-#112). Specialists earn expansion through portfolio-new value and retain protected general/long-tail work.
- Large-story performance controls: quick, standard, and deep check presets with clearer time/coverage tradeoffs.
- Structural lint checks: optional checks for missing tags, inconsistent tag schemas, or project-specific metadata conventions.

## License

MIT
