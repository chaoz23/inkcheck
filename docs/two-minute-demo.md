# Two-minute failure-path demo

This repository includes a small synthetic story with one intentional runtime failure and one intentionally unreachable knot. It is safe to inspect and exists only to demonstrate Inkcheck's report.

From a clone of this repository, run the exact released version:

```sh
npx -y inkcheck@0.2.0 examples/manor.ink
```

The useful signal is the reproducible choice trail, not merely the red status:

```text
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar]
⚠ 1 knot(s) never visited on any explored path:
    treasure_vault (manor.ink:35)
```

The full report also identifies five distinct terminal states and says whether exploration was truncated. Replay the two-choice failure path in the source, fix the faulty expression, and run the same command again.

Inkcheck generates and edits no prose. It uses the official Ink compiler and processes the story locally. Unvisited content is a review prompt—not an instruction to delete it—and bounded exploration is not proof that every possible playthrough is correct.
