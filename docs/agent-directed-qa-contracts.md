# Agent-Directed QA Contracts

Inkcheck gives a human or agent a durable, auditable QA memory for an Ink story. It does not silently decide story intent, rewrite prose, or replace broad QA with a narrow target search.

## Review Before Approval

After `inspect_story` and `compile_story`, use the compact MCP router's `review_contract` operation with proposed typed assertions and goals. It validates the proposal against the compiled story, summarizes source inventory and any existing committed contract, and returns the required author-approval boundary.

```json
{
  "operation": "review_contract",
  "request": {
    "file": "story.ink",
    "assertions": [{
      "id": "gold_nonnegative",
      "when": "always",
      "condition": {
        "left": { "variable": "gold" },
        "operator": ">=",
        "right": { "literal": 0 }
      }
    }]
  }
}
```

The response is read-only. It never writes `inkcheck.yml`, starts a search, consumes a directed budget, or treats an agent proposal as approval. The author decides whether to commit the validated typed contract.

## Execution Rule

Run ordinary broad QA first. Approved assertions run during that base search. An approved goal may be observed during broad QA, but a goal-only probe is separate, explicitly budgeted work used only when an author or agent needs a particular witness. It never replaces general QA.

When Inkcheck finds a runtime error, assertion violation, or approved goal witness, pin the confirmed finding before editing and check the pin after the repair. This keeps the evidence chain stable across agent sessions and CI: source/config/seed, observed witness, fix, and regression verdict. A pin rechecks one exact witness; it never substitutes for a new broad search. See [QA evidence pins](qa-evidence-pins.md).

Bounded clean results remain bounded: say "no violation observed within this run" unless the report explicitly establishes exhaustive verification.
