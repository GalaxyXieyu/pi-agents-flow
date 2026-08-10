# Supervisor Loop

1. Restate the deliverable and release criteria internally.
2. Call `workflow.start` with the literal user goal and policy mode.
3. Call `workflow_assets` once when you are unsure which base Agents, skills, or MCP tools exist. Choose `baseAgent` and `skills` from that catalog; do not guess names.
4. Decompose the goal into human-level tasks plus a typed Work Unit DAG. When work and dependencies are knowable before execution, include the complete static DAG. Each Work Unit must have one bounded objective and a WorkflowDataContract; optional JSON Schemas belong on declared output ports, not on AgentSpec.
5. Submit that complete static DAG in one `workflow.apply_plan` call as `tasks` (human-level hierarchy) plus `workUnits` (schedulable units referencing their `taskId`); correct cycle, dependency, Agent, Skill, or preflight failures before execution. Do not stage a known plan, implementation, and verification chain through separate `apply_plan` calls.
6. Call `workflow.run_ready` to execute independent ready nodes concurrently.
7. Call `workflow.evaluate`. Inspect completed results, gaps, conflicts, failures, and the recommended next action.
   Use `workflow.get_result` when the compact evaluation truncates a node envelope or more evidence detail is required.
8. For each completed node, either:
   - accept it with a concrete evidence rationale;
   - reject it with a concrete defect;
   - add a targeted verifier or repair node.
	For failed/cancelled nodes, either fix the cause and call `run_ready` to retry the same node, or reject the obsolete node and its unused dependants before adding a replacement.
9. Repeat execution and evaluation until synthesis gates are satisfied. Extend the graph only when a completed result reveals a named gap, conflict, failure, release gate, or other topology decision that was not knowable before execution. `workflow.start` enforces a cumulative work-unit budget (`maxNodes`, default 64): once the run exceeds it, `apply_plan` rejects/supersedes obsolete non-accepted nodes or starts a new run instead of growing a repair loop forever.
10. Run one Writer against accepted material, then one Reviewer against the draft and registered evidence. Accept a sound Reviewer result even when it rejects the draft: acceptance records a valid audit, not document release.
11. If that accepted Reviewer finds document defects, append a new Editor revision depending on the accepted Editor and review, followed by a new Reviewer of that revision. Neither node uses `replaces`, because accepted nodes are immutable audit history. If residual gaps/conflicts are acceptable, the new Reviewer must return the relevant `extensions.release` flags in its result (e.g. `extensions.release={release:true, gapsAccepted, conflictsAccepted, rationale}`) rather than the Supervisor declaring them on the plan.
12. Call `workflow.complete` only after `workflow.evaluate` reports `nextAction=complete` and `readyToComplete=true`, using the final accepted Editor Markdown artifact.

Early reconnaissance is a valid first wave only when its results determine which later nodes or dependencies are required. If the later topology is already known, include it in the initial DAG and express ordering with `dependsOn`. Replanning must preserve completed attempts, identify the runtime result that changed the topology, and explain why each new node exists. Use script-driven workflow only for bounded runtime-dynamic topology such as repeated gap repair; static DAGs stay in the declarative Supervisor path.

The Workflow Store is an implementation detail. Never read, edit, or append its manifest/events directly and never import Store code from `bash`; use only the `workflow` tool for state changes.

## Stuck-node and loop guards

- A detached child that does not return within its wait deadline (node `agentSpec.timeoutMs` or a generous default) is failed as a retryable timeout instead of waiting forever.
- When Deep Research quality gates fail 3 consecutive `complete` calls, the run auto-stops and preserves the best available editor draft at `delivery/final.draft.md` so you have a usable artifact.
