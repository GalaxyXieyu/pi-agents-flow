import assert from "node:assert/strict";
import test from "node:test";

import { activityLeadState, summarizeActivityStates } from "../../src/activity/summary.ts";

test("summarizeActivityStates applies the shared task and execution buckets", () => {
	const counts = summarizeActivityStates([
		"running",
		"completed",
		"accepted",
		"failed",
		"waiting",
		"paused",
		"ready",
		"pending",
		"cancelled",
		"superseded",
	]);
	assert.deepEqual(counts, { running: 1, done: 2, failed: 1, waiting: 2, pending: 4 });
});

test("activityLeadState uses the shared display priority", () => {
	assert.equal(activityLeadState({ running: 1, done: 0, failed: 1, waiting: 1, pending: 1 }), "running");
	assert.equal(activityLeadState({ running: 0, done: 0, failed: 1, waiting: 1, pending: 1 }), "failed");
	assert.equal(activityLeadState({ running: 0, done: 0, failed: 0, waiting: 1, pending: 1 }), "waiting");
	assert.equal(activityLeadState({ running: 0, done: 0, failed: 0, waiting: 0, pending: 1 }), "pending");
	assert.equal(activityLeadState({ running: 0, done: 2, failed: 0, waiting: 0, pending: 0 }), "completed");
});
