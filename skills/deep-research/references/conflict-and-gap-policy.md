# Conflict And Gap Policy

Create a targeted verifier when two material claims cannot both be true, when a source is stale relative to another source, or when the final recommendation depends on an unverified mechanism.

The verifier prompt must include:

- the exact conflicting statements;
- the registered source URLs or artifact paths;
- the fact that would resolve the conflict;
- preferred primary sources;
- a stop condition.

Do not create a verifier for harmless wording differences. Normalize terminology first.

A gap can be accepted as uncertainty when evidence is not publicly available, the cost of another round exceeds its decision value, or the user explicitly accepts the limitation. Accepted uncertainty must appear in the final report.

## Runtime gate mapping

Deep Research defaults are machine-enforced by `WorkflowPolicy`:

- `gates.maxUnresolvedGaps = 0`
- `gates.maxUnresolvedConflicts = 0`
- `gates.minAcceptedResearchLanes = 3`
- `gates.requireWriter = true`
- `gates.requireReviewer = true`

A gap becomes non-blocking only after an explicit Supervisor decision:

- `accepted_uncertainty` when public evidence is unavailable or further search has low decision value
- `gap_resolution` when a targeted verifier or local check closed the gap

A conflict becomes non-blocking only after `conflict_resolution`.

To relax or tighten completion behavior for a run, pass `policy` overrides on `workflow({ action: "start", ... })`. Do not bypass gates by accepting weak prose.
