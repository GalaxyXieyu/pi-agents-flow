import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRunReadyWorkflowAction, WorkflowRunReadyConcurrencyParams, WorkflowRunReadyNodeIdParams } from "../../src/workflows/run-ready-action.ts";

describe("workflow run_ready public action parser", () => {
	it("exports the schema constraints used by the public workflow tool", () => {
		assert.equal(WorkflowRunReadyConcurrencyParams.minimum, 1);
		assert.equal(WorkflowRunReadyConcurrencyParams.maximum, 32);
		assert.equal(WorkflowRunReadyNodeIdParams.minLength, 1);
		assert.match(String(WorkflowRunReadyNodeIdParams.description), /failed\/cancelled node to retry/);
	});

	it("parses an explicit single-node retry", () => {
		assert.deepEqual(parseRunReadyWorkflowAction({
			action: "run_ready",
			concurrency: 1,
			nodeId: "reviewer-final",
		}, "workflow-1"), {
			action: "run_ready",
			runId: "workflow-1",
			concurrency: 1,
			nodeId: "reviewer-final",
		});
	});

	it("keeps the default action free of retry authorization", () => {
		assert.deepEqual(parseRunReadyWorkflowAction({ action: "run_ready", concurrency: 3 }), {
			action: "run_ready",
			concurrency: 3,
		});
	});

	it("rejects invalid concurrency and empty retry node IDs", () => {
		assert.throws(() => parseRunReadyWorkflowAction({ action: "run_ready", concurrency: 0 }), /between 1 and 32/);
		assert.throws(() => parseRunReadyWorkflowAction({ action: "run_ready", concurrency: 33 }), /between 1 and 32/);
		assert.throws(() => parseRunReadyWorkflowAction({ action: "run_ready", nodeId: " " }), /nodeId must be a non-empty string/);
	});
});
