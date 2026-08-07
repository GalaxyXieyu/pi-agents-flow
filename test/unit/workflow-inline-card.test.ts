import test from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowInlineCard, type WorkflowInlineCardInput } from "../../src/tui/workflow-inline-card.ts";
import type { TaskActivity } from "../../src/activity/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function makeTask(overrides: Partial<TaskActivity> & { id: string; label: string; state: TaskActivity["state"] }): TaskActivity {
	return {
		id: overrides.id,
		label: overrides.label,
		state: overrides.state,
		order: 0,
		workUnits: [],
		children: [],
		completed: 0,
		total: 1,
		artifacts: [],
		plan: { id: overrides.id, label: overrides.label, order: 0 } as never,
		...overrides,
	};
}

test("renders a completed workflow with green badge and done count", () => {
	const input: WorkflowInlineCardInput = {
		runId: "abc123456789",
		language: "zh",
		status: "completed",
		tasks: [
			makeTask({ id: "t1", label: "调研", state: "completed", completed: 1, total: 1 }),
			makeTask({ id: "t2", label: "实现", state: "completed", completed: 1, total: 1 }),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	assert.ok(lines.length >= 2, "should have header + status line");
	assert.match(lines[0], /●/);
	assert.match(lines[0], /abc12345/);
	assert.match(lines[1], /2 完成/);
	assert.doesNotMatch(lines[1], /失败/);
});

test("renders a failed workflow with red badge and failed count", () => {
	const input: WorkflowInlineCardInput = {
		runId: "fail-run-001",
		language: "en",
		status: "failed",
		tasks: [
			makeTask({ id: "t1", label: "Research", state: "completed", completed: 1, total: 1 }),
			makeTask({ id: "t2", label: "Implement", state: "failed" }),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	assert.match(lines[0], /✕/);
	assert.match(lines[1], /1 failed/);
});

test("renders an active workflow with spinner and running count", () => {
	const input: WorkflowInlineCardInput = {
		runId: "active-run-1",
		language: "zh",
		status: "active",
		tasks: [
			makeTask({ id: "t1", label: "调研", state: "completed", completed: 1, total: 1 }),
			makeTask({ id: "t2", label: "实现", state: "running", completed: 0, total: 2 }),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, 2);
	assert.match(lines[1], /\u25D0/);
	assert.match(lines[1], /1 运行/);
	assert.match(lines[1], /1 完成/);
});

test("localizes status labels to English", () => {
	const input: WorkflowInlineCardInput = {
		runId: "en-run-001",
		language: "en",
		status: "active",
		tasks: [
			makeTask({ id: "t1", label: "Research", state: "running" }),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	assert.match(lines[1], /Status/);
	assert.match(lines[1], /1 running/);
	assert.doesNotMatch(lines[1], /状态|运行/);
});

test("shows overflow when tasks exceed visible limit", () => {
	const input: WorkflowInlineCardInput = {
		runId: "overflow-run",
		language: "en",
		status: "completed",
		tasks: Array.from({ length: 6 }, (_, i) => makeTask({ id: `t${i}`, label: `Task ${i}`, state: "completed", completed: 1, total: 1 })),
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	const hasOverflow = lines.some((line) => line.includes("\u2026 +"));
	assert.ok(hasOverflow, "should show overflow indicator for many tasks");
});
