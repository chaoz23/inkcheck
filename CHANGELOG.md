# Changelog

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
