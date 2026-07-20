# QA evidence pins

An evidence pin is a private, source-bound memory of one confirmed finding. It lets a human or agent recheck the same indexed witness after an edit without spending a new search budget.

`pin_regression` supports runtime errors, assertion violations, and goal witnesses. A runtime pin stores hashes of the expected error. Assertion and goal pins store the typed rule or goal condition, the zero-based choice indexes, and the Ink random seed. Pins do not store story prose, choice labels, transcripts, observed variable values, or the full report.

`check_regression` recompiles the current entrypoint and replays that exact witness. Runtime and assertion pins report `fixed`, `still_failing`, or `path_changed`. Goal witness pins report `still_reached`, `lost`, or `path_changed`.

This is deliberately narrower than a new QA run. A pin proves only the outcome of its one replay checkpoint; it does not prove that an assertion now holds everywhere or that a goal remains reachable by every route. After a meaningful edit, start a fresh bounded search to refresh story-wide evidence.

Goal and assertion findings may live in a directed report. Pass that current report's `reportId` to `pin_regression`; the report must belong to the same source entrypoint.
