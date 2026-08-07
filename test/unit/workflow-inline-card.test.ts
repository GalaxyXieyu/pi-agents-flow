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

test("shows overflow in expanded mode when tasks exceed 15-line limit", () => {
	const input: WorkflowInlineCardInput = {
		runId: "overflow-run",
		language: "en",
		status: "completed",
		tasks: Array.from({ length: 20 }, (_, i) => makeTask({ id: `t${i}`, label: `Task ${i}`, state: "completed", completed: 1, total: 1 })),
	};
	// Expanded mode should show overflow
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	const hasOverflow = lines.some((line) => line.includes("\u2026 +"));
	assert.ok(hasOverflow, "should show overflow indicator in expanded mode");
	// Collapsed mode should NOT show tasks or overflow
	const linesCollapsed = renderWorkflowInlineCard(input, theme as never, 120, false);
	const hasTaskRows = linesCollapsed.some((line) => line.includes("Task"));
	assert.ok(!hasTaskRows, "collapsed mode should not show task rows");
});

test("renders task list in expanded mode (ctrl+o)", () => {
	const input: WorkflowInlineCardInput = {
		runId: "expanded-run-001",
		language: "en",
		status: "active",
		tasks: [
			makeTask({ id: "t1", label: "Research", state: "running", completed: 0, total: 2 }),
			makeTask({ id: "t2", label: "Implementation", state: "pending" }),
		],
	};
	// Expanded mode should show task list
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	assert.ok(lines.length >= 4, `expected at least 4 lines (header + status + 2 tasks), got ${lines.length}`);
	const hasResearch = lines.some((l) => l.includes("Research"));
	const hasImplementation = lines.some((l) => l.includes("Implementation"));
	assert.ok(hasResearch, "should show Research task");
	assert.ok(hasImplementation, "should show Implementation task");
	// Collapsed mode should NOT show task list
	const linesCollapsed = renderWorkflowInlineCard(input, theme as never, 120, false);
	const hasTaskInCollapsed = linesCollapsed.some((l) => l.includes("Research") || l.includes("Implementation"));
	assert.ok(!hasTaskInCollapsed, "collapsed mode should not show task names");
});

test("shows failed task with red badge in expanded mode", () => {
	const input: WorkflowInlineCardInput = {
		runId: "failed-run-002",
		language: "en",
		status: "failed",
		tasks: [
			makeTask({ id: "t1", label: "Implement", state: "failed" }),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	// Should show the failed task in expanded mode
	const hasImplement = lines.some((l) => l.includes("Implement"));
	assert.ok(hasImplement, "should show failed task in expanded mode");
	// Should have error indicator
	assert.match(lines[0], /✕/, "header should show error badge");
});

test("shows duration footer when createdAt is provided", () => {
	const now = Date.now();
	const input: WorkflowInlineCardInput = {
		runId: "duration-run-001",
		language: "zh",
		status: "active",
		tasks: [makeTask({ id: "t1", label: "调研", state: "running" })],
		createdAt: now - 45000,
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	// Last line should contain duration in right-aligned dim text
	const lastLine = lines[lines.length - 1];
	assert.match(lastLine, /45s/, "should show elapsed time");
});

test("formats duration correctly for minutes and hours", () => {
	const now = Date.now();
	const input1: WorkflowInlineCardInput = {
		runId: "duration-run-002",
		language: "en",
		status: "completed",
		tasks: [],
		createdAt: now - 125000,
		updatedAt: now,
	};
	const lines1 = renderWorkflowInlineCard(input1, theme as never, 120);
	assert.match(lines1[lines1.length - 1], /2m5s/, "should format as minutes+seconds");

	const input2: WorkflowInlineCardInput = {
		...input1,
		createdAt: now - 7320000,
		updatedAt: now,
	};
	const lines2 = renderWorkflowInlineCard(input2, theme as never, 120);
	assert.match(lines2[lines2.length - 1], /2h2m/, "should format as hours+minutes");
});

test("hides duration footer when createdAt is not provided", () => {
	const input: WorkflowInlineCardInput = {
		runId: "no-duration-run",
		language: "en",
		status: "active",
		tasks: [makeTask({ id: "t1", label: "Research", state: "running" })],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	// Collapsed mode: last line should be status line (not duration, not task)
	const lastLine = lines[lines.length - 1];
	assert.match(lastLine, /Status/, "should end with status line in collapsed mode");
	assert.doesNotMatch(lastLine, /^\s+\d+s$/, "should not be a duration line");
});
