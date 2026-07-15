# Ink for mechanical QA

Read this only when project syntax or runtime semantics are unfamiliar.

## Structure and flow

- A **knot** is a named section: `=== market ===`. A **stitch** is a named subsection within a knot. Diverts such as `-> market` transfer control.
- A choice begins with `*` or `+`. Sticky choices (`+`) may be offered again. Choice display text can differ from text emitted after selection. Indexed witnesses use the offered choice index, not its label.
- A **gather** (`-`) rejoins choice branches. Misplaced gathers and missing diverts commonly cause content exhaustion.
- A tunnel returns to its caller; a thread runs alongside surrounding flow. `->->` and `<-` behavior should be inspected before replacing either with a terminal divert.
- `-> DONE` ends the current thread or tunnel flow. `-> END` terminates the entire story. Adding either without understanding the caller can hide reachable content.
- `INCLUDE chapter.ink` composes source files. Treat the configured root file as the entrypoint; inspect and compile follow includes.
- Functions should not produce ordinary narrative flow. External functions depend on the host application; Inkcheck discloses when it substitutes zero.

## State and eligibility

Variables use `VAR name = value`; assignments use `~ name = value`. Conditions in `{ ... }` can hide choices or diverts. A branch being unvisited may mean a state combination was not reached, a condition is impossible, or the run hit a bound.

Visit counts and turn functions make history part of state. `TURNS()` and `TURNS_SINCE()` require turn-sensitive exploration. Random functions require a fixed `storySeed` for reproducibility. Authored `SEED_RANDOM()` may intentionally change behavior.

Inkcheck assertions are a safe typed grammar over variables and literals. They are appropriate for mechanical invariants such as `gold >= 0`, `health <= max_health`, or `has_key == true` at a named knot. An assertion is not a request to infer game design from a variable name; obtain author approval for the rule.

## Common failure shapes

- **Compile failure:** missing target, malformed expression, or invalid structure. Compile first and repair the reported source location.
- **Content exhaustion:** an observed path reaches no choice, divert, `DONE`, or `END`. Replay before selecting terminal semantics.
- **Stale state:** a flag remains true or false across a path where the author expected a reset. This usually needs an approved assertion or stated intent.
- **Gate miss:** an ending requires a rare conjunction. A bounded miss is not proof of impossibility; use staged goals or source inspection only with declared intent.
- **Loop trap:** legal repeated states can consume depth, frontier, or memory. Binding limits are evidence about the run, not about reachability.
- **Storylet hub:** many eligible scenes recombine. State diversity can matter more than raw path count; preserve deterministic seeds and inspect unvisited authored content.

## Repair discipline

Prefer the smallest logic change that satisfies already-stated intent. Preserve prose and choice labels unless asked. Recompile after every edit. Replay the exact indexed witness, then rerun the same bounded check so a fixed path does not conceal a different regression. If the witness changes, report `path_changed`; do not call that fixed without further evidence.
