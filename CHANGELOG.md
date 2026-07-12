# Changelog

## Unreleased

- Add deterministic discovery summaries for 0.6 shadow-mode consumers (#91): event count, first/latest discovery positions, current dry distance, latest gap, and longest observed gap survive bounded curve compaction and stream through NDJSON. These are measured facts only; no plateau, knee, or stopping inference is introduced.
- Extend 0.6 discovery curves with meaningful QA value classes and actual portfolio order (#91): exact terminal states remain separate from normalized visible outcomes, while assertion violations, reached goals/stages, runtime errors, and authored knots have independent counters. Portfolio reports retain a bounded merged curve, and NDJSON progress streams the new privacy-safe counts. Scheduling and stopping remain unchanged.
- Begin the Inkcheck 0.6 anytime-decision measurement foundation (#91): every exploration pass records a deterministic discovery curve with separate ending, runtime-error, and authored-knot counts. Curves compact to at most 64 samples regardless of state budget, preserve early/latest evidence and dry-gap measurements, and do not yet alter scheduling or stopping behavior.
- Stop hosted `humanFindings` from advising CLI flags a web user cannot set (#49). `buildHumanFindings` takes an `audience: "cli" | "hosted"` option; the hosted server passes `"hosted"`, so the limit-bound unvisited-knot next step now says to run inkcheck locally for a deeper check instead of naming `--max-depth`/`--max-states`. CLI output is unchanged.
- Add safe typed search goals with an explicit additive budget. General exploration keeps the full `maxStates` allocation; `goalMaxStates` / `--goal-states` optionally adds deterministic goal-proximity work and defaults to zero. Reports, progress events, config validation, discovery, CLI, and MCP expose baseline, goal, and combined budgets, with a shared 100,000,000-state ceiling.
- Add ordered staged goals for late variable dependencies. Each cumulative milestone has a deterministic witness and status; a bounded prerequisite miss blocks downstream stages instead of claiming they are unreachable. Stages share the explicit additive goal budget and never displace baseline exploration.

## 0.5.1 — 2026-07-11

- Add safe author-defined story assertions (#64): versioned config and structured MCP input accept typed variable/literal comparisons composed with `all`, `any`, and `not`, scoped always, at terminal states, or on entering a named knot. Every search engine evaluates the same prevalidated rules on visited states; violations fail CI and carry stable IDs, observed values, exact indexed witnesses, and replay operations. Reports distinguish violations, bounded runs where no violation was observed, and exhaustive verification. No JavaScript, shell, or arbitrary Ink expressions are accepted.
- Add strict project configuration schema v1: `inkcheck.yml` can commit a project-relative entrypoint and bounded CI defaults, `inkcheck validate-config [path] [--json]` reports actionable path-specific errors, explicit CLI flags win, and unknown keys fail rather than pretending future assertions/goals are active. The JSON Schema is packaged and `capabilities` now advertises config schema v1.
- Add idempotent project bootstrap commands: `inkcheck init` creates a validated minimal config after unambiguous entrypoint discovery, and `inkcheck agent-kit --format codex` scaffolds pinned CI, generated-artifact ignore rules, and compact version-matched agent instructions. All writes are preflighted; a conflicting target aborts the operation before any file is created or overwritten.

## 0.5.0 — 2026-07-11

- Report portfolio-wide cumulative counts in live progress (#55). The portfolio scheduler emitted each progress event from the just-run pass's snapshot, so the endings/errors/unvisited-knots counts a consumer showed as a running total bounced up and down as passes interleaved. Progress now comes from the scheduler's portfolio-wide dedup sets, which are monotonic by construction: endings and runtime errors only rise, unvisited knots only fall, within a run. Fixes the hosted web progress indicator and the CLI `--progress=human`/`ndjson` output together.
- Raise the default choice-trail depth from 30 to 100 (`DEFAULT_MAX_DEPTH`), shared across the exploration engines, the shape profiler, the CLI, and the MCP `explore_story` tool. A depth of 30 cut off ordinary stories out of the box — *The Intercept*'s paths pass ~19 choice-bearing knots and real playthroughs go deeper — so the plain `inkcheck story.ink` run under-explored unless the author knew to reach for `--auto`. 100 is generous headroom over real story depths; a story deeper than that still truncates cleanly with `truncatedBy.maxDepth` and a `deepen` recommendation, and `--auto` raises the limit per-story from the shape profile. Explicit `--max-depth` still wins and `--auto` still never lowers a limit. (`examples/deep-chain.ink` is now 130 knots deep so it keeps demonstrating that plain defaults truncate while `--auto` reaches the ending and proves exhaustiveness.)
- Stop the hosted web checker from timing out on normal-sized stories and returning a misleading "your story is so detailed and long" limit error (#71). Three changes: the hosted `--max-depth` default drops from 1,000 (the system's escalation ceiling, which let one deep-loop trail consume the whole state budget) to **100**, ample headroom over real story depths — The Intercept's deepest pass reaches depth 65 and its result is byte-for-byte identical at depth 100 vs 1,000; the graceful `--max-time` now reserves a real margin below the hard SIGKILL deadline (15%, at least 30 s, vs a fixed 10 s that was too tight to flush a multi-MB partial report), so the partial report the engine already computed is returned instead of discarded; and the hosted timeout ceiling drops from 450 s to **300 s** — a 5-minute cap that returns a strong partial report beats a 7m30s wait that returned nothing. A genuinely wedged run that still has to be killed now gets an honest time-limit message that does not blame the story's size.
- Add versioned agent report schema v1 (#59): JSON reports now identify Inkcheck/schema versions, fingerprint the compiled story, record effective configuration and binding limit, and enrich compile/runtime/ending findings with stable IDs, normalized kinds, suggested actions, and documentation identifiers. Every explored ending/runtime witness carries zero-based `choiceIndices` alongside human choice text and exact `playtest_story` replay instructions; duplicate labels are unambiguous, and playtest reports `path_changed` for stale indexed witnesses.
- Add versioned agent discovery foundations (#58): `inkcheck capabilities [--json]` and MCP `inkcheck_capabilities` expose schemas, limits, modes, and explicit unavailable feature flags; `inkcheck inspect <story.ink> [--json]` and MCP `inspect_story` return a deterministic, bounded, source-only project map without compiling or exploring. Inspection follows project-local includes, reports shape/semantics/externals/knots/variables, and rejects missing or outside-root includes.
- Add opt-in `--search=shared-variable` (and matching MCP mode), which dedicates 12.5% of shared-frontier selections to uncommon observed variable snapshots and transitions while retaining novelty, deep, and seeded views. The heuristic is deterministic, bounded, and mechanical; it does not interpret variable meaning. A checked-in comparison table records both improvements and regressions, so portfolio remains the default.
- Document the search-strategy promotion policy: default portfolio allocation is frozen until an alternative passes a broad predeclared matrix with structural-family regression gates, multiple budgets/depths/seeds, resource measurements, and no lost runtime-error or assertion evidence at the largest comparable budget.
- Add opt-in `--search=shared` (also available as MCP `explore_story.search`) for an experimental shared-state multi-frontier engine. Deep, novelty-first, and seeded views share one deduplicated graph and expand each state at most once while compact parent links preserve repro paths. New pass telemetry records unique states, peak pending states/bytes, variable states/transitions observed, and rare variable transitions. The existing adaptive portfolio remains the default while benchmark evidence accumulates; variable rarity is observed but does not steer search yet.
- Add a wall-clock time budget so a slow run degrades gracefully instead of being killed. `--max-time <s>` stops exploration cleanly at the deadline and returns the partial report it has (new `truncatedBy.time` cause), mirroring the memory guard for time. The hosted web checker now passes `--max-time` just under its hard SIGKILL timeout, so a story too slow to finish returns a partial report with its findings-so-far instead of failing with a timeout and losing them; the hard kill remains only as a backstop for a wedged process. On a time stop the `nextRun` verdict is `investigate` (raise `--max-time` or use the local CLI), never `broaden`.
- Drop internal "beam width" / "frontier cap" jargon from human-readable truncation advice. A pure beam prune still means the story is bigger than the run covered — which the depth/state hints and the states-explored count already convey — so `truncationAdvice` no longer surfaces the beam's internal cap in `--human`/text/Markdown reports (or in the `humanFindings` the hosted web checker renders).

## 0.4.1 — 2026-07-10

- Raise the state-budget ceiling to 100,000,000 and the CLI/MCP default to 10,000,000 (from 1,000,000 / 100,000). The large default is safe because exhaustible stories early-exit, the memory guard stops cleanly before an out-of-memory crash, and progress reporting lets you watch and interrupt a long run — so the practical limiter on a big run is memory (or the wall clock you choose), not the ceiling. The hosted web checker keeps a 1,000,000-state default and cap so one story cannot monopolize the shared server; larger jobs belong on the local CLI. Pin `--max-states` in CI when a bounded runtime matters more than depth of coverage.
- Add a **Performance and memory** section to the README: per-million-states timing, the memory-term breakdown (dedup hash floor ~200 B/distinct state and dominant; DFS/beam/random flat; BFS repro frontier the one super-linear risk), a "~2 GB heap per 10M distinct states" worst-case rule of thumb, and the levers (`--max-old-space-size`, `--no-min-repro`, `--max-states`) for a story too big to finish.

## 0.4.0 — 2026-07-10

- Add a memory guard so large runs degrade gracefully instead of crashing. A V8 heap out-of-memory abort cannot be caught after the fact, so exploration now watches heap use and stops cleanly before the wall, keeping every finding so far and reporting `truncatedBy.memory` in a partial report. The cap defaults to 85% of the V8 heap limit (honoring `--max-old-space-size`) and is overridable with `--max-memory <mb>`; the guard is active in the CLI and the MCP `explore_story` tool. On a memory stop the `nextRun` verdict is `investigate` (raise the heap, lower `--max-states`, or split the story), never `broaden`, since more budget would hit the wall sooner.
- Recommend the next run (#30): every report now carries a `nextRun` verdict from a small closed vocabulary — `stop`, `deepen`, `broaden`, `reseed`, `investigate` — computed as a pure, deterministic function of the report (plus the static shape profile for the deepen target), with ready-to-use flags, a rationale citing the report fields that drove it, and an evidence-backed expected gain. Proposed flags never exceed the hard ceilings; when no increase has evidence behind it, the verdict degrades to `investigate` and points at the unvisited knots worth reviewing. Available in CLI `--json`, the MCP `explore_story` tool, and as one-line advice in text and Markdown reports.
- Add `--next` (#30): after the check, the CLI applies the recommendation and reruns automatically — up to three escalations, stopping on a `stop`/`investigate` verdict, at the flag ceilings, or when an escalated run finds nothing new (fixpoint). On the 40-deep chain fixture, `--next` takes a defaults run that found nothing to a proven-exhaustive result in one automatic escalation. The per-run trail is recorded in `--json` output as `runs`; hop narration goes to stderr so machine output stays clean.
- Add truthful human progress for local terminal runs: interactive terminals show the current phase, configured work-budget use, discoveries, throughput where stable, and elapsed time; `--progress=human` prints log-friendly snapshots, while `--progress=off` remains silent. Progress explicitly describes work budget rather than story coverage.
- Make hosted checks asynchronous with private short-lived jobs, real CLI-derived progress events, SSE reconnect plus status polling, and server-side cancellation. Uploaded source is still deleted after success, cancellation, timeout, or failure; retained job metadata contains only progress/report data and expires quickly.
- Emit lifetime per-pass telemetry in JSON reports (#28): a `passes` array with, per pass, states explored vs granted, own finding counts, portfolio-marginal first discoveries (consistent with the schedule's per-round sums), dedupe hits, max depth reached, `lastDiscoveryAtState` (the cheap discovery-curve signal), truncation causes, and exhaustiveness — plus peak frontier size and prune count for the beam. Standalone pass runs and the CLI's BFS repro slice attach their own entry, so `--json` consumers see every pass that contributed to a report without parsing progress logs. Telemetry reports facts and leaves stop/continue judgments to the consumer: a long gap since a pass's last discovery does not prove the pass is done.

## 0.3.3 — 2026-07-10

- Spend the exploration budget adaptively (#29): portfolio passes now run interleaved in ten deterministic rounds, with each round's grants reallocated toward passes whose findings are still growing (guaranteed per-pass floor so dry spells never defund a pass), and the whole portfolio stops the moment a systematic pass proves every reachable state visited — a small fully-explorable story at the default 100,000-state budget now finishes in the ~10 states it actually has instead of resampling for the full budget. The executed schedule (grants, consumption, and marginal discoveries per pass per round) is recorded in `--json` output. Runs remain fully deterministic; a budget-bound random slice is now always reported truncated (sampling never proves completeness) unless a systematic pass proved exhaustion.
- Profile story shape before exploring (#27): new `--profile` prints a static scan — variables and where they are assigned, choice density, the longest divert path — plus the depth limit and pass weights inkcheck would choose; `--auto` applies them, raising `--max-depth` when static divert paths outrun the default (explicit flags always win, limits are never lowered), dropping sampling passes for variable-free stories, and boosting beam/random weights when variable state is set early. On a 40-choice-deep chain, default settings find no endings while `--auto` reaches the ending and proves the story exhaustive in ~111 states. Adds `examples/deep-chain.ink`.
- Make bounded-coverage limits explicit in every report (#22): all output modes state the limits the run used (depth, state budget, seed); truncated runs name the limit that actually cut coverage (`truncatedBy`) with targeted raise-this-flag advice, informed by local *The Intercept* evidence that depth and state budget are separate axes.
- Triage unvisited knots with an inbound-divert source scan (#22): each unvisited knot reports `inboundDiverts` and `staticOrphanCandidate`, so reports distinguish "no authored divert points here — possible orphan" from "has inbound diverts — likely beyond this run's limits", with matching next-step advice in `--human` output.
- Report `exhaustive: true` when a systematic pass visits every reachable state without hitting a limit, and stop counting sampling-slice budget exhaustion as truncation in that case. This also fixes small fully-explored stories failing `--strict` (and being reported as partial) because the random slice always spends its whole sub-budget.
- Label runtime-error repro paths with the pass that found them in text and Markdown reports (previously JSON-only).
- Add a frontier-capped, diversity-first beam-search slice (~15%) to the exploration portfolio (#21). The beam advances level-by-level like BFS but keeps at most 64 states per level, selected round-robin across variable-signature groups (novelty-ranked within each group: new knots, new variable signatures, new offered-choice sets). It is deterministic without a seed, bounds the frontier memory that made naive BFS impractical on large stories, and marks the run truncated whenever it prunes a reachable state. On the early-choice grid fixture, the beam alone finds all seven endings in ~2.2K states.
- Add a seeded random-sampling slice (~20%) to the exploration portfolio so early-choice state combinations get sampled instead of repeated; the deterministic DFS portfolio alone missed 4 of 7 endings on an adversarial early-choice fixture even at a 1M state budget (#20, #21).
- Add `--seed` to the CLI and a `seed` input to the MCP `explore_story` tool; a fixed default seed keeps CI runs reproducible, and the used seed is reported in `explore.limits.seed`.
- Label every reported ending and runtime error with the search pass that found it (`foundBy`, e.g. `dfs:last`, `bfs`, `random:seed=1`).
- Add `examples/early-choice-grid.ink`, the community-motivated fixture behind issue #20, plus regression tests that the portfolio now reaches all seven endings within a bounded budget.

## 0.3.2 — 2026-07-09

- Raise the default exploration state budget to 100,000 and the maximum accepted `--max-states` value to 1,000,000 across CLI, MCP, and hosted checker validation.
- Add a technical coverage/performance note for bounded exploration. The CLI spends each state budget across a deterministic portfolio of last-choice-first DFS, first-choice-first DFS, inside-out DFS, and a small BFS repro-shortening slice. In local *The Intercept* runs at default depth 30, higher budgets found more terminal states but still reported truncation: 50,000 states in 9.4s found 7 terminal states and 9 unvisited knots; 100,000 states in 19.9s found 10 terminal states and 9 unvisited knots; 500,000 states in 100.2s found 17 terminal states and 8 unvisited knots; 1,000,000 states in 205.5s found 25 terminal states and 8 unvisited knots. These results document real bounded QA behavior rather than exhaustive verification.

## 0.3.1 — 2026-07-09

- Map content-exhaustion runtime errors to the authored choice that triggered the dead end when inkjs does not provide a runtime address, so CLI and human reports can include an approximate file/line reference for “ran out of content” failures.

## 0.3.0 — 2026-07-09

- Add a self-hosted web checker with direct `.ink` upload or paste, optional unchanged `INCLUDE` files/folders, consent gates, safe path validation, pilot access codes, rate limits, one-job concurrency, child-process timeouts, and immediate temporary-file deletion.
- Support an exact browser-origin allowlist so a static community page can call the checker without opening the API to arbitrary websites.
- Add a hardened Docker/Caddy deployment whose application container has no runtime internet route.
- Document a production budget under $50/month and keep residential Windows hosting for development rather than the public trust boundary.
- Improve bounded exploration coverage with a complementary DFS portfolio and a smaller BFS repro-shortening slice while keeping the same public state limits.
- Document that `--max-states` is a total portfolio budget and that truncated reports can still contain useful endings, runtime errors, and coverage clues.
- Keep human reports focused on actionable findings by omitting the hosted truncation coverage note from the finding list.

## 0.2.0 — 2026-07-07

### Trustworthy coverage

- Preserve turn and random runtime state whenever the source uses those Ink features.
- Exclude crashing terminal states from successful outcome counts.
- Disclose truncation, random behavior, and every `EXTERNAL` function stubbed to zero.
- Make `--strict` fail when traversal is truncated or external behavior is unavailable.
- Replace ambiguous “ending” counts with distinct terminal-state language.

### CI and packaging

- Add `--markdown` reports for GitHub Actions Step Summaries.
- Validate CLI limits and reject unknown options with usage exit code 2.
- Verify downloaded official inklecate 1.2.1 archives with pinned SHA-256 hashes.
- Test Ubuntu, macOS, and Windows.
- Include the InkJam guide and machine-readable manifests in the npm package.

### Community readiness

- Lead with mechanical, non-generative QA rather than AI integration.
- Add an InkJam-oriented guide for interpreting errors and coverage limitations.
- Document Ink-Tester as a complementary random-coverage tool.
- Remove an unreproducible large-story result from the README.

## 0.1.1 — 2026-07-06

- Add published package authorship metadata.

## 0.1.0 — 2026-07-06

- Initial CLI and MCP release.
