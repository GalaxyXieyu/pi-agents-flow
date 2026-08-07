import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowTodoAdapter, WORKFLOW_TODO_APPLY_EVENT, WORKFLOW_TODO_RESULT_EVENT } from "../../src/workflows/todo-adapter.ts";
import type { WorkflowTodoProjection } from "../../src/workflows/todo-projection.ts";

class FakeEvents {
	private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

const projection: WorkflowTodoProjection = {
	version: 0,
	toolAvailable: true,
	items: [],
	operations: [{
		action: "create",
		subject: "[WF workflow] Plan workflow",
		description: "Projection",
		activeForm: "planning workflow",
		owner: "workflow-supervisor",
		metadata: { workflowId: "workflow-1", workflowPhase: "planning", workflowRevision: 1 },
	}],
};

describe("workflow todo adapter", () => {
	it("uses a correlated extension event to apply projection operations automatically", () => {
		const events = new FakeEvents();
		const received: unknown[] = [];
		events.on(WORKFLOW_TODO_APPLY_EVENT, (payload) => {
			received.push(payload);
			const request = payload as { requestId: string };
			events.emit(WORKFLOW_TODO_RESULT_EVENT, { requestId: request.requestId, applied: 1 });
		});
		const adapter = createWorkflowTodoAdapter({ events, createRequestId: () => "todo-request-1" });

		const result = adapter.apply(projection, "session-1");

		assert.equal(result.applied, 1);
		assert.equal(result.supported, true);
		assert.equal(received.length, 1);
		assert.deepEqual(received[0], {
			version: 0,
			requestId: "todo-request-1",
			sessionId: "session-1",
			operations: projection.operations,
		});
	});

	it("stays non-fatal when no todo integration listener is installed", () => {
		const adapter = createWorkflowTodoAdapter({ events: new FakeEvents(), createRequestId: () => "todo-request-2" });
		assert.deepEqual(adapter.apply(projection, "session-1"), { supported: false, applied: 0 });
	});
});
