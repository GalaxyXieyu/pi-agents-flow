# Result Evaluation

Evaluate structured fields, not rhetorical confidence.

Accept a research or verification node only when:

- `summary.text` answers its assigned lane;
- each important claim in `evidence.findings` has a URL or artifact reference;
- confidence matches the evidence;
- `diagnostics.gaps` and `diagnostics.conflicts` are explicit;
- the result does not exceed the assigned scope.
- every evidence URL appears in `evidence.search.fetchedUrls` for web research;
- the search trace records queries and rejected candidate sources;

Reject a result when it is malformed, unsupported, duplicated without new evidence, outside scope, or contradicted by stronger evidence.

Negative-feedback actions:

- Missing dimension: add one focused research node.
- Conflicting claims: add one verifier whose prompt names both claims and sources.
- Weak source: search for a primary source rather than adding more secondary sources.
- Failed or cancelled node: fix the named preflight/capability problem, then call `workflow.run_ready` to create a new immutable attempt on the same node. If a replacement node makes the old node obsolete, explicitly reject the old failed node and any obsolete pending dependants with a rationale.
- Draft problem: add one Writer repair node based on Reviewer findings.

After verifier acceptance, record `gap_resolution` for a closed gap and `conflict_resolution` for a resolved conflict. Use `accepted_uncertainty` only when the gap remains unresolved but is explicitly allowed in delivery.

Do not concatenate child prose into the final answer. Normalize findings into accepted claims, registered evidence, explicit uncertainty, and writing constraints before synthesis.

Before Deep Research completion, call `workflow.quality`. Treat its blockers as release gates. Primary-source ratio, quote coverage, duplicate-source rate, and low-confidence rate are quality warnings that should trigger a focused improvement round when they affect the recommendation.

Never edit `.pi/agents-flow/workflows` (legacy: `.pi-agents-flow/workflows`), append Workflow events from `bash`, or import the Workflow Store from a Supervisor shell. All state transitions must go through the `workflow` tool. Deep Research quality rejects accepted nodes that lack correlated delegation provenance.
