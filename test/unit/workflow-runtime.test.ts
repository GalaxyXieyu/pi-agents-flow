import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { WorkflowContinuationDecision, WorkflowController } from "../../src/workflows/controller.ts";
import { evaluateWorkflow } from "../../src/workflows/gates.ts";
import { createWorkflowRuntime } from "../../src/workflows/runtime.ts";
import type { WorkflowRun } from "../../src/workflows/types.ts";

function run(): WorkflowRun {
	return {
		version: 0,
		id: "workflow-1",
		mode: "general",
		goal: "Goal",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		nodes: {},
		decisions: [],
		appliedEventIds: ["started"],
	};
}

function readyRun(): WorkflowRun {
	const workflow = run();
	return {
		...workflow,
		nodes: {
			research: {
				id: "research",
				kind: "research",
				label: "Research",
				dependsOn: [],
				status: "ready",
				attempts: [],
				agentSpec: {
					id: "researcher",
					baseAgent: "researcher",
					role: "researcher",
					objective: "Research",
					instructions: "Research",
					context: "fresh",
				},
			},
		},
	};
}

function decision(options: { suppressed?: boolean; attempt?: number } = {}): WorkflowContinuationDecision {
	const workflow = run();
	return {
		run: workflow,
		evaluation: evaluateWorkflow(workflow),
		attempt: options.attempt ?? 1,
		suppressed: options.suppressed ?? false,
		...(options.suppressed ? {} : { prompt: "Continue workflow" }),
	};
}

describe("workflow runtime", () => {
	it("delivers a settled continuation as a hidden follow-up turn", () => {
		const sent: Array<{ message: unknown; options?: unknown }> = [];
		const controller = {
			current: () => run(),
			recover: () => run(),
			requestContinuation: () => decision(),
			async execute() { throw new Error("unused"); },
		} satisfies WorkflowController;
		const runtime = createWorkflowRuntime({
			pi: {
				sendMessage(message, options) { sent.push({ message, options }); },
			},
			controller,
		});

		runtime.handleAgentSettled({} as ExtensionContext);

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
		assert.deepEqual(sent[0]?.message, {
			customType: "workflow-continuation-context",
			content: "Continue workflow\n\nContinue with the next workflow tool call directly. Do not narrate routine workflow transitions before acting.",
			display: false,
			details: { runId: "workflow-1", attempt: 1 },
		});
	});

	it("recovers on reload and emits a repeated no-progress warning only once", () => {
		let recovered = 0;
		let requested = 0;
		const messages: unknown[] = [];
		const controller = {
			current: () => run(),
			recover: () => { recovered++; return run(); },
			requestContinuation: () => { requested++; return decision({ suppressed: true, attempt: 4 }); },
			async execute() { throw new Error("unused"); },
		} satisfies WorkflowController;
		const runtime = createWorkflowRuntime({
			pi: { sendMessage(message) { messages.push(message); } },
			controller,
		});
		const event = { type: "session_start", reason: "reload" } satisfies SessionStartEvent;

		runtime.handleSessionStart(event, {} as ExtensionContext);
		runtime.handleSessionStart(event, {} as ExtensionContext);

		assert.equal(recovered, 2);
		assert.equal(requested, 2);
		assert.equal(messages.length, 1);
	});

	it("actively schedules ready nodes after a full runtime restart", async () => {
		const actions: string[] = [];
		const controller = {
			current: () => readyRun(),
			recover: () => readyRun(),
			requestContinuation: () => undefined,
			async execute(params) {
				actions.push(params.action);
				return { text: "scheduled", details: { run: readyRun() } };
			},
		} satisfies WorkflowController;
		const runtime = createWorkflowRuntime({
			pi: { sendMessage() {} },
			controller,
		});

		await runtime.handleSessionStart(
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			{} as ExtensionContext,
		);

		assert.deepEqual(actions, ["run_ready"]);
	});
});
