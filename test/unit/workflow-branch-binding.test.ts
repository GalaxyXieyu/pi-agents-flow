import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertWorkflowBinding, createWorkflowBinding } from "../../src/workflows/branch-binding.ts";
import { reduceWorkflowEvents } from "../../src/workflows/reducer.ts";

const run = reduceWorkflowEvents([{
	id: "event-start",
	type: "workflow.started",
	at: 1,
	runId: "workflow-1",
	mode: "general",
	goal: "Run a workflow",
	cwd: "/repo",
	sessionId: "session-1",
	branch: "main",
}]);

describe("workflow branch binding", () => {
	it("round-trips the current run identity", () => {
		const binding = createWorkflowBinding(run);
		assert.deepEqual(binding, {
			version: 0,
			runId: "workflow-1",
			revision: 1,
			sessionId: "session-1",
			cwd: "/repo",
			branch: "main",
		});
		assert.doesNotThrow(() => assertWorkflowBinding(run, binding));
	});

	it("fails closed for stale revisions or a different session, cwd, or branch", () => {
		const binding = createWorkflowBinding(run);
		assert.throws(() => assertWorkflowBinding(run, { ...binding, revision: 0 }), /revision/i);
		assert.throws(() => assertWorkflowBinding(run, { ...binding, sessionId: "session-2" }), /session/i);
		assert.throws(() => assertWorkflowBinding(run, { ...binding, cwd: "/other" }), /working directory/i);
		assert.throws(() => assertWorkflowBinding(run, { ...binding, branch: "feature" }), /branch/i);
	});
});
