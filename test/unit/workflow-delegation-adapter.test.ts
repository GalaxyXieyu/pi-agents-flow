import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	type SubagentDelegationRequest,
} from "../../src/api/delegation.ts";
import { CODING_PREAPPROVAL_READONLY_ANNOTATION } from "../../src/workflows/coding-preset.ts";
import {
	buildWorkflowDelegationRequest,
	createWorkflowDelegationAdapter,
	type WorkflowDelegationEvents,
	type WorkflowPreflight,
} from "../../src/workflows/delegation-adapter.ts";
import { workflowResultSchema, WORKFLOW_RESULT_SUBMISSION_GUIDE } from "../../src/workflows/result-contract.ts";
import { reduceWorkflowEvents } from "../../src/workflows/reducer.ts";
import type { WorkflowAttempt, WorkflowNode } from "../../src/workflows/types.ts";

class FakeEvents implements WorkflowDelegationEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();
	emitted: Array<{ event: string; data: unknown }> = [];

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

const run = reduceWorkflowEvents([{
	id: "event-start",
	type: "workflow.started",
	at: 1,
	runId: "workflow-1",
	mode: "deep-research",
	goal: "Research workflow systems",
	cwd: "/repo",
	sessionId: "session-1",
	branch: "main",
}]);

const node: WorkflowNode = {
	id: "research-a",
	kind: "research",
	label: "Research architecture",
	dependsOn: [],
	status: "ready",
	attempts: [],
	agentSpec: {
		id: "agent-research-a",
		baseAgent: "researcher",
		role: "architecture researcher",
		objective: "Compare workflow architectures",
		instructions: "Use primary sources and report gaps.",
		context: "fresh",
		model: "kimi/k2",
		thinking: "high",
		skills: ["deep-research"],

		timeoutMs: 10_000,
		turnBudget: { maxTurns: 8, graceTurns: 1 },
		toolBudget: { soft: 10, hard: 20 },
	},
	dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
};

const attempt: WorkflowAttempt = {
	attemptId: "research-a:1",
	requestId: "request-1",
	number: 1,
	startedAt: 2,
	status: "running",
};

describe("workflow delegation adapter", () => {
	it("maps an ephemeral AgentSpec to the existing delegation v2 contract", () => {
		const expectedSchema = workflowResultSchema(node.dataContract);
		const request = buildWorkflowDelegationRequest(run, node, attempt, {
			agent: "researcher",
			model: "kimi/k2",
			thinking: "high",
		});
		// assert key fields instead of deepEqual
		assert.equal(request.version, 2);
		assert.equal(request.agent, "researcher");
		assert.equal(request.context, "fresh");
		assert.deepEqual(request.result.schema, expectedSchema);
		assert.ok((expectedSchema.properties as Record<string, unknown>).evidence, "evidence schema should exist");
	});

	it("generates a V1 result schema from a research data contract", () => {
		const schema = workflowResultSchema(node.dataContract);
		assert.equal(schema.type, "object");
		assert.ok((schema.required as string[]).includes("summary"));
		assert.ok((schema.required as string[]).includes("evidence"));
		assert.match(WORKFLOW_RESULT_SUBMISSION_GUIDE, /structured_output/);
		assert.match(WORKFLOW_RESULT_SUBMISSION_GUIDE, /summary\.text/);
	});

	it("preflights before emitting and correlates the terminal response", async () => {
		const events = new FakeEvents();
		const adapter = createWorkflowDelegationAdapter({
			events,
			preflight: async () => ({ ok: true, agent: "researcher", model: "kimi/k2", thinking: "high", launchContractDigest: "digest-1" }),
		});
		events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
			const request = data as SubagentDelegationRequest;
			queueMicrotask(() => events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
				version: 2,
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
				status: "completed",
				result: { kind: "structured", value: { summary: "done" } },
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 5 },
			}));
		});

		const result = await adapter.run(run, node, attempt);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.launchContractDigest, "digest-1");
			assert.equal(result.response.status, "completed");
		}
		assert.equal(events.emitted.filter((entry) => entry.event === SUBAGENT_DELEGATION_REQUEST_EVENT).length, 1);
	});

	it("resolves the default turn-budget grace before preflight", async () => {
		const events = new FakeEvents();
		let preflightInput: Parameters<WorkflowPreflight>[0] | undefined;
		const adapter = createWorkflowDelegationAdapter({
			events,
			preflight: async (input) => {
				preflightInput = input;
				return { ok: false, error: "stop after contract capture" };
			},
		});
		const nodeWithoutGrace: WorkflowNode = {
			...node,
			agentSpec: { ...node.agentSpec, turnBudget: { maxTurns: 8 } },
		};

		await adapter.run(run, nodeWithoutGrace, attempt);

		assert.deepEqual(preflightInput?.turnBudget, { maxTurns: 8, graceTurns: 1 });
		assert.deepEqual(preflightInput?.outputSchema, workflowResultSchema(node.dataContract));
	});

	it("enforces the resolved read-only capability set for Coding pre-approval nodes", async () => {
		const readonlyNode: WorkflowNode = {
			...node,
			id: "coding-plan",
			agentSpec: { ...node.agentSpec, baseAgent: "planner", denyTools: ["bash", "edit", "write"] },
			dataContract: {
				...node.dataContract,
				annotations: { [CODING_PREAPPROVAL_READONLY_ANNOTATION]: { required: true } },
			},
		};
		for (const preflight of [
			{ ok: true as const, agent: "planner", effectiveTools: ["read", "grep", "find", "ls", "structured_output"], effectiveMcpTools: [] },
			{ ok: true as const, agent: "planner", effectiveTools: ["read", "bash"], effectiveMcpTools: [] },
			{ ok: true as const, agent: "planner", effectiveTools: ["read"], effectiveMcpTools: ["filesystem/write_file"] },
		]) {
			const events = new FakeEvents();
			const adapter = createWorkflowDelegationAdapter({ events, preflight: async () => preflight });
			if (preflight.effectiveTools.includes("bash") || preflight.effectiveMcpTools.length > 0) {
				const result = await adapter.run(run, readonlyNode, attempt);
				assert.equal(result.ok, false);
				if (!result.ok) assert.match(result.error, /non-read-only effective tools/);
				assert.equal(events.emitted.some((entry) => entry.event === SUBAGENT_DELEGATION_REQUEST_EVENT), false);
				continue;
			}
			events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
				const request = data as SubagentDelegationRequest;
				queueMicrotask(() => events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: 2,
					requestId: request.requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "completed",
					result: { kind: "structured", value: { summary: "done" } },
				}));
			});
			const result = await adapter.run(run, readonlyNode, attempt);
			assert.equal(result.ok, true);
		}
	});

	it("does not emit a child request when preflight fails", async () => {
		const events = new FakeEvents();
		const adapter = createWorkflowDelegationAdapter({
			events,
			preflight: async () => ({ ok: false, error: "missing skill: deep-research" }),
		});

		const result = await adapter.run(run, node, attempt);
		assert.deepEqual(result, { ok: false, stage: "preflight", error: "missing skill: deep-research" });
		assert.equal(events.emitted.some((entry) => entry.event === SUBAGENT_DELEGATION_REQUEST_EVENT), false);
	});

	it("emits an exact v2 cancel identity when the caller aborts", async () => {
		const events = new FakeEvents();
		const adapter = createWorkflowDelegationAdapter({
			events,
			preflight: async () => ({ ok: true, agent: "researcher" }),
		});
		const controller = new AbortController();
		events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => queueMicrotask(() => controller.abort()));
		events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
			const cancel = data as { requestId: string; ownerRunId: string; nodeId: string };
			queueMicrotask(() => events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 2, ...cancel, status: "cancelled" }));
		});

		const result = await adapter.run(run, node, attempt, controller.signal);
		assert.equal(result.ok, true);
		assert.deepEqual(
			events.emitted.find((entry) => entry.event === SUBAGENT_DELEGATION_CANCEL_EVENT)?.data,
			{ version: 2, requestId: "request-1", ownerRunId: "workflow-1", nodeId: "research-a" },
		);
	});
});
