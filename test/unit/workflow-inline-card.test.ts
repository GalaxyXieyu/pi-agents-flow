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

test("renders work units in expanded mode", () => {
	const input: WorkflowInlineCardInput = {
		runId: "expanded-run-001",
		language: "en",
		status: "active",
		tasks: [
			makeTask({ 
				id: "t1", 
				label: "Research", 
				state: "running", 
				workUnits: [
					{ id: "wu1", taskId: "t1", label: "Search docs", order: 0, state: "completed", dependsOn: [], attempts: 1, artifacts: [], executions: [] },
					{ id: "wu2", taskId: "t1", label: "Analyze results", order: 1, state: "running", dependsOn: ["wu1"], attempts: 1, artifacts: [], executions: [] },
				],
			}),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	// Should have header, status, task row, and 2 work unit rows
	assert.ok(lines.length >= 4, `expected at least 4 lines, got ${lines.length}`);
	// Work units should be indented and show labels
	const wuLines = lines.filter((l) => l.includes("Search docs") || l.includes("Analyze results"));
	assert.equal(wuLines.length, 2, "should render both work units");
});

test("shows failure details in expanded mode", () => {
	const input: WorkflowInlineCardInput = {
		runId: "failed-run-002",
		language: "en",
		status: "failed",
		tasks: [
			makeTask({ 
				id: "t1", 
				label: "Implement", 
				state: "failed", 
				workUnits: [
					{ 
						id: "wu1", 
						taskId: "t1", 
						label: "Build feature", 
						order: 0, 
						state: "failed", 
						dependsOn: [], 
						attempts: 2,
						artifacts: [], 
						executions: [{ key: "e1", text: "", state: "failed", error: "timeout" } as never],
					},
				],
			}),
		],
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	const failedLine = lines.find((l) => l.includes("Build feature"));
	assert.ok(failedLine, "should show failed work unit");
	assert.match(failedLine, /×2/, "should show attempt count");
	assert.match(failedLine, /timeout/, "should show error message");
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
	const lastLine = lines[lines.length - 1];
	// Last line should be the task row, not a duration
	assert.match(lastLine, /Research/, "should end with task row, not duration");
});
