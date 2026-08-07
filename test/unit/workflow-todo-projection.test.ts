import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateWorkflow } from "../../src/workflows/gates.ts";
import { nodeKindSemantics } from "../../src/workflows/node-kind.ts";
import { buildWorkflowTodoProjection } from "../../src/workflows/todo-projection.ts";
import type { WorkflowRun } from "../../src/workflows/types.ts";

function run(): WorkflowRun {
	return {
		version: 0,
		id: "workflow-12345678",
		mode: "deep-research",
		goal: "Research",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 2,
		createdAt: 1,
		updatedAt: 2,
		nodes: {
			research: {
				id: "research",
				kind: "research",
				label: "Research",
				dependsOn: [],
				status: "ready",
				attempts: [],
				agentSpec: { id: "agent-research", baseAgent: "researcher", role: "researcher", objective: "Research", instructions: "Research", context: "fresh", },
				dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
			},
		},
		decisions: [],
		appliedEventIds: ["started", "plan"],
	};
}

describe("workflow todo projection", () => {
	it("creates one user-level phase list and keeps exactly one phase in progress", () => {
		const workflow = run();
		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);

		assert.equal(projection.items.filter((item) => item.status === "in_progress").length, 1);
		assert.equal(projection.items.find((item) => item.phase === "planning")?.status, "completed");
		assert.equal(projection.items.find((item) => item.phase === "research")?.status, "in_progress");
		assert.equal(projection.operations.length, projection.items.length);
		assert.ok(projection.operations.every((operation) => operation.action === "create"));
	});

	it("keeps subagents out of the list so a task and its workers are never siblings", () => {
		const workflow = run();
		workflow.nodes["writer-1"] = {
			id: "writer-1",
			kind: "section-writer",
			label: "Overview",
			dependsOn: ["research"],
			status: "pending",
			attempts: [],
			agentSpec: { id: "agent-w1", baseAgent: "research-section-writer", role: "writer", objective: "Write", instructions: "Write", context: "fresh", },
				dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
		};
		workflow.nodes["writer-2"] = { ...workflow.nodes["writer-1"], id: "writer-2", label: "Costs" };

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);

		// Two section writers must not become two todo entries; they roll up into synthesis.
		assert.equal(projection.items.every((item) => item.phase !== undefined), true);
		assert.equal(projection.items.filter((item) => item.subject.includes("Overview") || item.subject.includes("Costs")).length, 0);
		assert.equal(projection.items.filter((item) => item.phase === "synthesis").length, 1);
	});

	it("names the active subagent on the phase it is carrying, with per-kind verbs", () => {
		const workflow = run();
		workflow.nodes.research = {
			...workflow.nodes.research!,
			status: "waiting",
			label: "Comparison lane",
			attempts: [{
				attemptId: "research:1",
				requestId: "request-1",
				number: 1,
				startedAt: 1,
				status: "waiting",
				childRunId: "child-1",
			}],
		};

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);
		const item = projection.items.find((candidate) => candidate.phase === "research");
		const operation = projection.operations.find((candidate) => candidate.action === "create" && candidate.metadata.workflowPhase === "research");

		assert.deepEqual(item, {
			phase: "research",
			subject: "[WF workflow] Research evidence",
			activeForm: "researching Comparison lane",
			status: "in_progress",
			activeNodeId: "research",
		});
		assert.deepEqual(operation && "metadata" in operation ? operation.metadata : undefined, {
			workflowId: "workflow-12345678",
			workflowPhase: "research",
			workflowNodeId: "research",
			workflowRevision: 2,
			childRunId: "child-1",
			attemptNumber: 1,
		});
	});

	it("covers every node kind so no kind falls outside a phase or loses its verb", () => {
		const kinds = ["research", "verification", "outline", "section-writer", "writer", "editor", "reviewer", "custom"] as const;
		for (const kind of kinds) {
			const semantics = nodeKindSemantics(kind);
			assert.equal(typeof semantics.phase, "string", `${kind} must map to a phase`);
			assert.ok(semantics.activeVerb.length > 0, `${kind} must have an active verb`);
			assert.ok(semantics.labelZh.length > 0, `${kind} must have a zh label`);
		}
	});

	it("completes the synthesis phase for deep-research section writers and editor", () => {
		const workflow = run();
		workflow.nodes.research = { ...workflow.nodes.research!, status: "accepted" };
		workflow.nodes["writer-1"] = {
			id: "writer-1",
			kind: "section-writer",
			label: "Overview",
			dependsOn: ["research"],
			status: "accepted",
			attempts: [],
			agentSpec: { id: "agent-w1", baseAgent: "research-section-writer", role: "writer", objective: "Write", instructions: "Write", context: "fresh", },
				dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
		};
		workflow.nodes.editor = { ...workflow.nodes["writer-1"], id: "editor", kind: "editor", label: "Lead edit", status: "accepted" };

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);

		// Before the shared kind table, synthesis grouped only kind === "writer",
		// so a real deep-research run left this phase permanently incomplete.
		assert.equal(projection.items.find((item) => item.phase === "synthesis")?.status, "completed");
	});

	it("emits only idempotent status updates for existing rpiv-todo tasks", () => {
		const workflow = run();
		const first = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);
		const tasks = first.items.map((item, index) => ({
			id: index + 1,
			subject: item.subject,
			status: "pending",
			metadata: { workflowId: workflow.id, ...(item.phase ? { workflowPhase: item.phase } : {}), workflowRevision: 1 },
		}));
		const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: tasks.length + 1 } } }];

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), branch, true);

		assert.deepEqual(projection.operations, [
			{ action: "update", id: 1, status: "completed", metadata: { workflowRevision: 2 } },
			{ action: "update", id: 2, status: "in_progress", activeForm: "researching evidence", metadata: { workflowRevision: 2 } },
		]);
	});

	it("does not request mutations when the todo tool is unavailable", () => {
		const workflow = run();
		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], false);
		assert.equal(projection.toolAvailable, false);
		assert.deepEqual(projection.operations, []);
	});

	it("tombstones a completed phase before recreating it for a repair round", () => {
		const workflow = run();
		const first = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), [], true);
		const tasks = first.items.map((item, index) => ({
			id: index + 1,
			subject: item.subject,
			status: item.phase === "research" ? "completed" : item.status,
			metadata: { workflowId: workflow.id, ...(item.phase ? { workflowPhase: item.phase } : {}), workflowRevision: 1 },
		}));
		const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: tasks.length + 1 } } }];

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), branch, true);
		const researchOperations = projection.operations.filter((operation) => operation.action === "delete" || (operation.action === "create" && operation.metadata.workflowPhase === "research"));

		assert.deepEqual(researchOperations, [
			{ action: "delete", id: 2 },
			{
				action: "create",
				subject: "[WF workflow] Research evidence",
				description: "Projection of workflow workflow-12345678 phase 'research'. Workflow Store remains authoritative.",
				activeForm: "researching evidence",
				owner: "workflow-supervisor",
				metadata: { workflowId: "workflow-12345678", workflowPhase: "research", workflowRevision: 2 },
			},
		]);
	});

	it("tombstones obsolete workflow-owned phase tasks after the graph shape changes", () => {
		const workflow = run();
		const branch = [{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					nextId: 2,
					tasks: [{
						id: 1,
						subject: "[WF workflow] Execute workflow",
						status: "pending",
						metadata: { workflowId: workflow.id, workflowPhase: "execution", workflowRevision: 1 },
					}],
				},
			},
		}];

		const projection = buildWorkflowTodoProjection(workflow, evaluateWorkflow(workflow), branch, true);

		assert.ok(projection.operations.some((operation) => operation.action === "delete" && operation.id === 1));
	});
});
