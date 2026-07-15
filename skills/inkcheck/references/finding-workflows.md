# Finding workflows

## Compile issue

Inspect the reported file and line, make the smallest structural correction, and call `compile_story` again. Do not explore a story that still fails compilation.

## Runtime finding

Fetch one stable ID, replay its indexed witness, and inspect the triggering neighborhood. Pin the finding before editing when the project needs a durable regression status. Recompile, run `check_regression`, and distinguish `fixed`, `still_failing`, and `path_changed`.

## Assertion violation

Confirm the assertion is author-approved. Replay its witness and inspect the observed values. Fix the story logic or revise the rule only when intent supports that choice. A partial run with no violation means only "not observed."

## Unvisited content

Check inbound-divert triage and the run's binding limit. Review conditions and source shape. Do not delete an orphan candidate automatically. For a known intended condition, use a typed staged goal with an explicit additive budget.

## Turns, randomness, and externals

Keep `storySeed` fixed for replay. Treat one random seed as one deterministic sequence. When externals are stubbed, reproduce in the real host before claiming the host-dependent path is correct.

## Bounded or resource-stopped run

Preserve every finding already observed. Name the binding state/depth/time/memory/frontier/disk limit. Continue an exact result-window frontier when available; otherwise start a separately identified run. Never describe a knee, dry interval, or large state count as completeness proof.
