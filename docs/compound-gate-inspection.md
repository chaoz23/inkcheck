# Compound Gate Inspection

`inkcheck inspect story.ink --json` and MCP `inspect_story` expose a bounded static inventory of Ink condition gates. This is source inspection only: it does not compile, execute, or claim a gate is reachable.

For an explicit `gates` section page, Inkcheck reports the authored condition, location, referenced declared variables, boolean/comparison operators, and factual declaration and assignment sites for those variables. Assignment sites are prerequisite hypotheses for a later search decision, not causal proof. A write to `gold` does not establish that a `gold >= 10` gate can be reached.

The first contract supports declared variables, literals, parentheses, `!`, `&&`, `||`, and `==`, `!=`, `<`, `<=`, `>`, `>=`. Function calls such as `TURNS()`, unknown identifiers, arithmetic, random behavior, external calls, and other dynamic Ink semantics are returned as unsupported rather than interpreted loosely.

Use this information to inspect likely prerequisites, write an author-defined assertion or goal when appropriate, and then run bounded exploration. Future directed search work must preserve the same distinction between static hints, observed witnesses, and proof.

## Explicit Gate Probe

After starting a durable MCP search, an agent may call `probe_gate` (or compact `inkcheck_workflow` with `operation: "probe_gate"`) with the gate's project-relative `file` and `line` from the explicit `gates` section plus a separate `maxStates` grant. Inkcheck accepts only a static gate that maps losslessly to the typed goal grammar. It runs a root-started shared goal probe, preserves the exact base checkpoint and base budget, and returns the selected source condition, factual assignment sites, and a reached witness or bounded miss.

This is experimental additive work. Assignment sites are not causal proof, an unreached probe is not proof of unreachability unless the result says so, and the probe never changes the default search allocation.
