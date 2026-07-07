# Changelog

## 0.2.0 — unreleased

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
