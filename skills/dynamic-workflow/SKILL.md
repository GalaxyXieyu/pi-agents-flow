---
name: dynamic-workflow
description: Run a durable supervisor-owned workflow that dynamically creates bounded subagents, schedules a typed DAG, evaluates structured results, and converges through explicit acceptance and repair.
---

# Dynamic Workflow

Use this skill only in the root Pi session. The root Pi Agent is the sole Supervisor and owns planning, acceptance, replanning, and delivery. Child agents execute bounded nodes and return structured evidence; they do not control the workflow.

Read the references needed for the current transition:

| Need | Reference |
| --- | --- |
| Start, plan, execute, evaluate, and converge | `references/supervisor-loop.md` |
| Create an ephemeral AgentSpec | `references/agent-factory.md` |
| Accept, reject, verify, repair, and merge results | `references/result-evaluation.md` |
| Pause, stop, reload, branch safety, and user decisions | `references/recovery-and-stop.md` |

Always use the `workflow` tool as the state transition boundary. Do not claim a run or node changed state unless the tool result confirms it.

`workflow_assets` is the read-only companion tool. Call it to list available base Agents, skills, MCP direct tools, and model tiers (fast/standard/deep) before composing a dynamic plan; it never changes workflow state. Do not call it for `/coding`: Coding stages use a fixed persisted DAG and known hidden Agents.

Always-on constraints:

- Child completion is not acceptance.
- Keep one writer per cwd.
- Use parallel nodes only for independent work.
- `apply_plan` takes two layers: `tasks` (human-level task hierarchy with `parentId`/`order`) and `workUnits` (schedulable units, each with `taskId`, `order`, `dependsOn`, and one `agentSpec`). A task may own several work units and therefore several Agents; `dependsOn` orders work units and never implies task hierarchy.
- When every required node and dependency is knowable before execution, build the complete static DAG and submit it in one `workflow.apply_plan` call. Do not split a known plan, implementation, and verification chain across multiple `apply_plan` calls.
- Call `workflow.run_ready` only after the complete static DAG has passed planning and preflight validation.
- Extend the graph after execution starts only when a completed result determines nodes or dependencies that could not have been known at planning time. Name that runtime result dependency in the new node instructions.
- Reserve script-driven workflows for runtime-dynamic topology such as bounded gap-repair loops. Do not use script mode for a static DAG merely to reduce Supervisor context usage.
- Add verifier or repair nodes only for a named gap, conflict, failure, or release gate.
- Do not execute model-generated JavaScript or create another child executor.
- Extensions stay inherited from the selected base Agent and are never expanded per node. Node configuration may revoke tools with `denyTools` and may open additional tools with `extraTools`, but the capability ceiling is a hard cap that no node can widen. Both fields require a base Agent that declares an explicit tools allowlist.
- Omit `agentSpec.model` on every node by default so children inherit the current session model with the workflow fallback chain (`taqu/deepseek-v4-flash` -> `taqu/kimi-k2.7-code`). Set `agentSpec.model` only when a node explicitly needs a different tier; always pick from the `workflow_assets` model catalog, never guess a model name.
- Ask the user only when the answer changes scope, cost, safety, or the final product. Ordinary research uncertainty should be represented as a gap or accepted uncertainty.
- Route coding work with a known delivery shape through `/coding plan|build|verify|full`, which persists the complete preset DAG before execution. Use general dynamic planning only when the required topology cannot be known up front.
- Route by deliverable class. A source-grounded research report uses `deep-research` mode. A publishable article (公众号/长文, opinion, narrative prose) uses `general` mode and the article pipeline: `positioning` -> `writer` -> `human-writing` -> `qa`, with `human-writing`/`qa` as a required pre-delivery gate. Do not deliver an article through the research-report pipeline; the report gates optimize coverage and citations, not reading experience. See the scope guard in the `deep-research` `SKILL.md`.

## Evaluate feedback

When you call `workflow({ action: "evaluate" })` or `/workflow status`, the runtime may append repair guidance:

- prioritized next actions (`adjudicate_node`, `spawn_verifier`, `record_uncertainty`, `run_ready`, `complete`)
- suggested follow-up queries for unresolved gaps/conflicts
- accepted-lane search benchmark score

Use that guidance to plan the next bounded transition. Do not ignore unresolved conflicts just because research nodes completed.
