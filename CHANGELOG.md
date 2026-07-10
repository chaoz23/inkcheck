# Changelog

## Unreleased

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
