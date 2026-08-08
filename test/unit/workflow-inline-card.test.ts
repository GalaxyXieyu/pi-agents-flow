import test from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowInlineCard, type WorkflowInlineCardInput } from "../../src/tui/workflow-inline-card.ts";
import type { ActivitySnapshot } from "../../src/activity/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function makeSnapshot(overrides: Partial<ActivitySnapshot["workflow"]> & { tasks: ActivitySnapshot["workflow"] extends infer W ? W extends { tasks: infer T } ? T : never : never }): ActivitySnapshot {
	return {
		version: 1,
		language: "zh",
		workflow: {
			runId: "test-run",
			goal: "",
			status: "active",
			tasks: overrides.tasks,
		},
		executions: overrides.executions ?? [],
		independent: [],
		updatedAt: Date.now(),
	} as ActivitySnapshot;
}

test("renders a completed workflow with green badge and done count", () => {
	const input: WorkflowInlineCardInput = {
		runId: "abc123456789",
		language: "zh",
		status: "completed",
		snapshot: makeSnapshot({
			runId: "abc123456789",
			goal: "",
			status: "completed",
			tasks: {
				t1: { id: "t1", label: "调研", order: 0, state: "completed", completed: 1, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "调研", order: 0, state: "completed", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "调研", order: 0, status: "completed", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "调研", order: 0 } },
				t2: { id: "t2", label: "实现", order: 1, state: "completed", completed: 1, total: 1, workUnits: [{ id: "w2", taskId: "t2", label: "实现", order: 0, state: "completed", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w2", taskId: "t2", kind: "custom", label: "实现", order: 0, status: "completed", dependsOn: [], attempts: [], agentSpec: { id: "a2", baseAgent: "writer", role: "writer", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t2", label: "实现", order: 1 } },
			},
			executions: [],
		}),
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
		snapshot: makeSnapshot({
			runId: "fail-run-001",
			goal: "",
			status: "failed",
			tasks: {
				t1: { id: "t1", label: "Research", order: 0, state: "completed", completed: 1, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "Research", order: 0, state: "completed", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "Research", order: 0, status: "completed", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "Research", order: 0 } },
				t2: { id: "t2", label: "Implement", order: 1, state: "failed", completed: 0, total: 1, workUnits: [{ id: "w2", taskId: "t2", label: "Implement", order: 0, state: "failed", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w2", taskId: "t2", kind: "custom", label: "Implement", order: 0, status: "failed", dependsOn: [], attempts: [], agentSpec: { id: "a2", baseAgent: "writer", role: "writer", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t2", label: "Implement", order: 1 } },
			},
			executions: [],
		}),
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
		snapshot: makeSnapshot({
			runId: "active-run-1",
			goal: "",
			status: "active",
			tasks: {
				t1: { id: "t1", label: "调研", order: 0, state: "completed", completed: 1, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "调研", order: 0, state: "completed", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "调研", order: 0, status: "completed", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "调研", order: 0 } },
				t2: { id: "t2", label: "实现", order: 1, state: "running", completed: 0, total: 2, workUnits: [{ id: "w2", taskId: "t2", label: "实现", order: 0, state: "running", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w2", taskId: "t2", kind: "custom", label: "实现", order: 0, status: "running", dependsOn: [], attempts: [], agentSpec: { id: "a2", baseAgent: "writer", role: "writer", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t2", label: "实现", order: 1 } },
			},
			executions: [],
		}),
		frame: 2,
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	assert.match(lines[1], /[◐◑◒◓]/, "should show a running spinner glyph");
	assert.match(lines[1], /1 运行/);
	assert.match(lines[1], /1 完成/);
});

test("localizes status labels to English", () => {
	const input: WorkflowInlineCardInput = {
		runId: "en-run-001",
		language: "en",
		status: "active",
		snapshot: makeSnapshot({
			runId: "en-run-001",
			goal: "",
			status: "active",
			tasks: {
				t1: { id: "t1", label: "Research", order: 0, state: "running", completed: 0, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "Research", order: 0, state: "running", dependsOn: [], attempts: 0, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "Research", order: 0, status: "pending", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "Research", order: 0 } },
			},
			executions: [],
		}),
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	assert.match(lines[1], /Status/);
	assert.match(lines[1], /1 running/);
	assert.doesNotMatch(lines[1], /状态|运行/);
});

test("shows overflow in expanded mode when agents exceed limit", () => {
	const tasks: Record<string, any> = {};
	const executions: any[] = [];
	for (let i = 0; i < 20; i++) {
		tasks[`t${i}`] = {
			id: `t${i}`, label: `Task ${i}`, order: i, state: "completed" as const, completed: 1, total: 1,
			workUnits: [{ id: `w${i}`, taskId: `t${i}`, label: `Task ${i}`, order: 0, state: "completed" as const, dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: `w${i}`, taskId: `t${i}`, kind: "custom", label: `Task ${i}`, order: 0, status: "completed", dependsOn: [], attempts: [], agentSpec: { id: `a${i}`, baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }],
			children: [], plan: { id: `t${i}`, label: `Task ${i}`, order: i },
		};
	}
	const input: WorkflowInlineCardInput = {
		runId: "overflow-run",
		language: "en",
		status: "completed",
		snapshot: makeSnapshot({ runId: "overflow-run", goal: "", status: "completed", tasks, executions }),
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	const hasOverflow = lines.some((line) => line.includes("\u2026 +"));
	assert.ok(hasOverflow, "should show overflow indicator in expanded mode");
	const linesCollapsed = renderWorkflowInlineCard(input, theme as never, 120, false);
	const hasTaskRows = linesCollapsed.some((line) => line.includes("Task"));
	assert.ok(!hasTaskRows, "collapsed mode should not show task rows");
});

test("shows agent rows with employee name and activity in expanded mode", () => {
	const input: WorkflowInlineCardInput = {
		runId: "agent-run-001",
		language: "en",
		status: "active",
		snapshot: makeSnapshot({
			runId: "agent-run-001",
			goal: "",
			status: "active",
			tasks: {
				t1: { id: "t1", label: "Research", order: 0, state: "running", completed: 0, total: 2, workUnits: [{ id: "w1", taskId: "t1", label: "Research", order: 0, state: "running", dependsOn: [], attempts: 1, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "research", label: "Research lane A", order: 0, status: "running", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "research lane A", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "Research", order: 0 } },
				t2: { id: "t2", label: "Write", order: 1, state: "pending", completed: 0, total: 1, workUnits: [{ id: "w2", taskId: "t2", label: "Write section B", order: 0, state: "pending", dependsOn: ["w1"], attempts: 0, artifacts: [], executions: [], node: { id: "w2", taskId: "t2", kind: "section-writer", label: "Write section B", order: 0, status: "pending", dependsOn: ["w1"], attempts: [], agentSpec: { id: "a2", baseAgent: "writer", role: "writer", objective: "write section B", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t2", label: "Write", order: 1 } },
			},
			executions: [
				{ key: "e1", agent: "researcher", role: "researcher", state: "running", startedAt: Date.now() - 10000, attempt: 1, artifacts: [], recent: [], workUnitId: "w1", activity: "Calling read" },
			],
		}),
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120, true);
	const hasResearch = lines.some((l) => l.includes("researcher"));
	const hasWrite = lines.some((l) => l.includes("writer"));
	assert.ok(hasResearch, "should show researcher agent");
	assert.ok(hasWrite, "should show writer agent");
	const hasActivity = lines.some((l) => l.includes("Calling read"));
	assert.ok(hasActivity, "should show agent activity");
});

test("shows duration on header line when createdAt is provided", () => {
	const now = Date.now();
	const input: WorkflowInlineCardInput = {
		runId: "duration-run-001",
		language: "zh",
		status: "active",
		snapshot: makeSnapshot({
			runId: "duration-run-001",
			goal: "",
			status: "active",
			tasks: {
				t1: { id: "t1", label: "调研", order: 0, state: "running", completed: 0, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "调研", order: 0, state: "running", dependsOn: [], attempts: 0, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "调研", order: 0, status: "pending", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "调研", order: 0 } },
			},
			executions: [],
		}),
		createdAt: now - 45000,
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	// Duration should be on the header line (line 0), right-aligned
	assert.match(lines[0], /45s/, "should show elapsed time on header line");
});

test("formats duration correctly for minutes and hours", () => {
	const now = Date.now();
	const input1: WorkflowInlineCardInput = {
		runId: "duration-run-002",
		language: "en",
		status: "completed",
		snapshot: makeSnapshot({
			runId: "duration-run-002",
			goal: "",
			status: "completed",
			tasks: {},
			executions: [],
		}),
		createdAt: now - 125000,
		updatedAt: now,
	};
	const lines1 = renderWorkflowInlineCard(input1, theme as never, 120);
	assert.match(lines1[0], /2m5s/, "should format as minutes+seconds on header line");

	const input2: WorkflowInlineCardInput = {
		...input1,
		createdAt: now - 7320000,
		updatedAt: now,
	};
	const lines2 = renderWorkflowInlineCard(input2, theme as never, 120);
	assert.match(lines2[0], /2h2m/, "should format as hours+minutes on header line");
});

test("hides duration on header when createdAt is not provided", () => {
	const input: WorkflowInlineCardInput = {
		runId: "no-duration-run",
		language: "en",
		status: "active",
		snapshot: makeSnapshot({
			runId: "no-duration-run",
			goal: "",
			status: "active",
			tasks: {
				t1: { id: "t1", label: "Research", order: 0, state: "running", completed: 0, total: 1, workUnits: [{ id: "w1", taskId: "t1", label: "Research", order: 0, state: "running", dependsOn: [], attempts: 0, artifacts: [], executions: [], node: { id: "w1", taskId: "t1", kind: "custom", label: "Research", order: 0, status: "pending", dependsOn: [], attempts: [], agentSpec: { id: "a1", baseAgent: "researcher", role: "researcher", objective: "", instructions: "", context: "fresh" } } }], children: [], plan: { id: "t1", label: "Research", order: 0 } },
			},
			executions: [],
		}),
	};
	const lines = renderWorkflowInlineCard(input, theme as never, 120);
	// No duration line should be present
	const hasDuration = lines.some((l) => /^\s+\d+s$/.test(l.trim()));
	assert.ok(!hasDuration, "should not have a separate duration line");
});
