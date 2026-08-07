# Ephemeral Agent Factory

Every node requires an `EphemeralAgentSpec`:

- `id`: unique within the workflow.
- `baseAgent`: persistent Agent template that supplies tools, extensions, MCP, base prompt, and capability ceiling.
- `role`: narrow responsibility, not a generic title.
- `objective`: one observable outcome.
- `instructions`: sources or artifacts to inspect, exclusions, evidence requirements, and stop condition.
- `context`: use `fresh` for independent research/review; use `fork` only when parent conversation context is necessary.
- `skills`: only the process knowledge required by this node.
- `extraTools`: optional per-node tool grants layered on the base Agent's allowlist. Entries containing `/` are MCP direct-tool selectors (`server` or `server/tool`); the rest are builtin tool names. Extension paths are rejected.
- `denyTools`: optional per-node tool revocations.
- optional model, thinking, timeout, turn budget, and tool budget.

Every `WorkflowNodePlan` has these top-level fields: `id`, `kind`, `label`, `dependsOn`, `agentSpec`, and `dataContract`. `label` must be non-empty. `dependsOn` is an array of node ids and must remain acyclic.

## WorkflowDataContract

Every node must declare a `dataContract` with:

- `profile`: `"generic"` | `"research"` | `"writer"` | `"reviewer"`
- `inputs`: array of input bindings (may be empty for root nodes)
- `outputs`: map of named output ports

Input bindings:

```json
{
  "name": "sections",
  "from": [
    { "nodeId": "section-a", "port": "document", "select": "/optional/json/pointer" }
  ],
  "purpose": "accepted section draft to merge",
  "delivery": "auto | manifest | summary | inline | reference",
  "merge": "list | map-by-node | concat-text | first | error",
  "required": true,
  "maxInlineBytes": 0
}
```

Output ports:

```json
{
  "document": {
    "mediaType": "text/markdown",
    "description": "complete document output",
    "storage": "auto | inline | artifact",
    "required": true,
    "maxInlineBytes": 8192,
    "classification": "public | internal | sensitive | secret",
    "schema": { "type": "string" }
  }
}
```

Rules:

1. `inputBindings.from.nodeId` must appear in `dependsOn` — hidden dependencies are rejected.
2. `inputBindings.from.port` must match a declared output port on the producer — undeclared ports are rejected at plan time.
3. Fan-in (multiple sources) requires an explicit `merge` policy.
4. `delivery: "inline"` with content exceeding the budget fails the node.
5. `delivery: "auto"` falls back to `reference` when content exceeds the inline budget.
6. Classification higher than the node's `context.clearance` is rejected.

## WorkflowResult

The child returns a `WorkflowResult` through `structured_output`:

```json
{
  "version": 1,
  "summary": {
    "text": "bounded semantic summary (max 8 KiB)",
    "covers": ["output artifact digest or port name"],
    "omissions": ["what was not covered"],
    "confidence": "high | medium | low"
  },
  "outputs": {
    "document": { "kind": "value", "value": "..." },
    "metrics": { "kind": "file", "path": "...", "sha256": "..." }
  },
  "diagnostics": {
    "gaps": [{ "question": "...", "reason": "..." }],
    "conflicts": [{ "statement": "...", "alternatives": ["..."], "evidence": ["..."] }],
    "warnings": ["..."]
  },
  "recommendations": ["..."],
  "evidence": {
    "findings": [{ "claim": "...", "evidence": [{ "url": "...", "quote": "...", "kind": "primary" }], "confidence": "high" }],
    "search": { "queries": ["..."], "fetchedUrls": ["..."], "droppedSources": [{ "url": "...", "reason": "..." }] }
  },
  "extensions": { "com.example/custom@1": { ... } }
}
```

- `summary.text` is a bounded orientation, never the complete document or dataset.
- Large content goes in `outputs.<port>` as a `file` submission from the preallocated output slot.
- `evidence.findings` and `evidence.search` are required for `profile: "research"` and `profile: "writer"`.
- `extensions` use namespaced keys (`namespace/name@version`) and are persisted but never executed.

## Creation rules

1. Choose the smallest base Agent whose existing capabilities can complete the node. New Deep Research document plans use `research-section-writer` for non-overlapping `section-writer` nodes, `research-editor` for the sole `editor`, and `research-reviewer` for the independent `reviewer`; `verification` uses `research-verifier`. The hidden `research-writer` mapping remains only for replaying legacy persisted `kind: writer` nodes and must not be selected for a new plan. The runtime rejects mismatched Deep Research role mappings.
2. Never add extensions through the ephemeral spec. Tools may be adjusted with `extraTools` and `denyTools`, but only within the capability ceiling, which no node can widen. Both fields require a base Agent that declares an explicit tools allowlist; without one the child is already unrestricted and the launch fails rather than narrowing it. Prefer a reviewed persistent base Agent when a node needs a capability set that is broadly reusable.
3. Give parallel children distinct lanes, evidence seams, and decisions. Do not clone the same broad prompt.
4. Declare `dataContract.inputs` with explicit `from` bindings when the node consumes prior work. The runtime resolves only accepted direct dependencies and materializes a bounded Context Pack.
5. Writers put the complete Markdown in `outputs.document`. Reviewers report findings in `diagnostics`. Researchers return `evidence.findings` and `evidence.search`.
6. Use `contact_supervisor` only for material mid-run decisions or blockers. Ordinary completion returns through the structured result.

Reject an AgentSpec when its objective is unbounded, its dependencies are ambiguous, its required capability is unavailable in the base Agent, or its result cannot be evaluated deterministically.
