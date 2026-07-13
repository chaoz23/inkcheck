# Authored promotion corpus

These source files are vendored solely to make Inkcheck's project-tier promotion evidence offline, pinned, and repeatable. `authored-promotion-manifest.json` records each upstream repository and commit, entrypoint, license and consent basis, compile setup, required host functions, randomness, and structural measures.

The size labels are predeclared workload tiers for this corpus, not claims about the wider Ink community:

- **small:** fewer than 1,000 authored Ink lines and fewer than 10,000 compiled words;
- **medium:** at least 1,000 authored Ink lines or 10,000 compiled words, without meeting the large threshold;
- **large:** at least 2,500 authored Ink lines, 20,000 compiled words, and 150 stitches or 350 choices.

The labels use multiple independent measures so a generated long file or a tiny combinatorial fixture cannot earn a large-project claim by one number alone. *The Intercept* remains a relatively small community project; its `medium` label means only that it occupies the middle rung of this deliberately modest first public corpus.

## Sources and attribution

- **Dog Ink Adventure**, Earok, commit `402b47c004c40c599877ae9dc75cc0aad7db887c`, MIT. The vendored `LICENSE` is the upstream license.
- **The Intercept**, inkle Ltd., commit `2a816b56e61ce4bf02bec1c638074645bdd871e3`, MIT. The upstream README containing the release statement and full MIT grant is vendored as `LICENSE-AND-PROVENANCE.md`.
- **Heresy II**, Randall Frank, commit `37b8a7804217bb40a9f69f6fd9c173f2017d550e`, Creative Commons Attribution 4.0. The vendored `LICENSE` is the upstream license. `item_globals.ink` is the upstream build output generated from the pinned `src/items.toml`; the remaining Ink sources are unchanged.

The 90k-word **Sky Caravan** repository was also screened as a stronger scale target. It is MIT licensed, but its author explicitly documents that the released Ink depends on unavailable Unity behavior and cannot run in Inky or inklecate. Current inklecate rejects its custom localization syntax. It is therefore recorded as a corpus gap, not transformed into a favorable runnable benchmark.
