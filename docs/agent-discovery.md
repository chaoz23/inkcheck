# Agent discovery contract

Use discovery before loading a large Ink project or relying on optional Inkcheck features.

## Capabilities

```sh
inkcheck capabilities --json
```

MCP: `inkcheck_capabilities`

The response is deterministic for an installed Inkcheck version and reports:

- `schemaVersion` and `inkcheckVersion`
- report, configuration, and project-inspection schema versions
- default and maximum state/depth limits
- supported search modes
- explicit feature flags, including `false` for features not yet available

Agents should check a feature flag instead of inferring support from missing documentation. Schema version `0` means that contract is not yet available.

## Project inspection

```sh
inkcheck inspect story/main.ink --json
```

MCP: `inspect_story { "file": "story/main.ink" }`

Inspection reads source only. It does not invoke inklecate, compile the story, execute inkjs, or spend exploration states. The response includes project-local includes, static shape, turn/random semantics, external functions, knot/function locations, and bounded variable summaries.

Variable locations are capped at 20 per read/write collection and the variable list is capped at 200. The `truncation` object says when those response limits were reached; this is response truncation, not search coverage truncation. Narrative prose and choice display text are not returned.

For a predictable trust boundary, includes must resolve within the entrypoint's directory tree. Missing files and attempts to leave that root fail inspection explicitly. This restriction applies to discovery; existing compile behavior is unchanged.

The successful response recommends `compile_story` as the next operation. Inspection is a map, not validation: compilation remains authoritative for Ink syntax and structure.
