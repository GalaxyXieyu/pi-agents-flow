import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTaskActivitiesFromRun, buildActivitySnapshot } from "../../src/activity/projection.ts";
import { renderActivityDock } from "../../src/tui/activity-dock.ts";
import { renderWorkflowInlineCard } from "../../src/tui/workflow-inline-card.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import type { WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

const theme = {
	fg: (_n: string, text: string) => text,
	bg: (_n: string, text: string) => text,
	bold: (text: string) => text,
};

function state(): SubagentState {
	return {
		baseCwd: "/repo", currentSessionId: "session-1",
		asyncJobs: new Map(), fleetJobs: new Map(), foregroundRuns: new Map(),
		foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function workUnit(partial: Partial<WorkflowNode> & Pick<WorkflowNode, "id" | "taskId" | "kind" | "label" | "order" | "status">): WorkflowNode {
	return {
		dependsOn: [], attempts: [],
		agentSpec: { id: `agent-${partial.id}`, baseAgent: "researcher", role: "researcher", objective: partial.id, instructions: partial.id, context: "fresh" },
		...partial,
	};
}

function run(nodes: Record<string, WorkflowNode>, tasks: WorkflowRun["tasks"]): WorkflowRun {
	return {
		version: 1, id: "workflow-1", mode: "general", goal: "g", language: "zh",
		cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 3,
		createdAt: 1, updatedAt: 2, tasks, nodes, decisions: [], appliedEventIds: [],
	};
}

describe("card/dock parity after unification", () => {
	it("scenario A: two units done under one task", () => {
		const r = run({
			"a": workUnit({ id: "a", taskId: "t", kind: "custom", label: "a", order: 0, status: "completed", attempts: [{ attemptId: "a:1", requestId: "ra", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"b": workUnit({ id: "b", taskId: "t", kind: "custom", label: "b", order: 1, status: "accepted", attempts: [{ attemptId: "b:1", requestId: "rb", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
		}, { t: { id: "t", label: "T", order: 0 } });
		const card = buildTaskActivitiesFromRun(r);
		const dock = buildActivitySnapshot(state(), r).workflow!.tasks;
		assert.deepEqual(card.map(x => `${x.state} ${x.completed}/${x.total}`), dock.map(x => `${x.state} ${x.completed}/${x.total}`));
	});
	it("scenario B: nested child tasks", () => {
		const r = run({
			"c1": workUnit({ id: "c1", taskId: "child", kind: "custom", label: "c1", order: 0, status: "completed", attempts: [{ attemptId: "c1:1", requestId: "rc1", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"c2": workUnit({ id: "c2", taskId: "child", kind: "custom", label: "c2", order: 1, status: "pending" }),
		}, { parent: { id: "parent", label: "父", order: 0 }, child: { id: "child", label: "子", order: 0, parentId: "parent" } });
		const card = buildTaskActivitiesFromRun(r);
		const dock = buildActivitySnapshot(state(), r).workflow!.tasks;
		assert.deepEqual(card.map(x => `${x.id}:${x.state} ${x.completed}/${x.total} c=${x.children.length}`), dock.map(x => `${x.id}:${x.state} ${x.completed}/${x.total} c=${x.children.length}`));
		const snapshot = buildActivitySnapshot(state(), r);
		const rendered = renderWorkflowInlineCard({ runId: r.id, language: "zh", status: r.status, snapshot }, theme as never, 120, true).join("\n");
		// Expanded mode now shows agent rows, not task labels
		assert.match(rendered, /状态/, "should show status line");
		assert.match(rendered, /researcher/, "should show agent role in expanded mode");
	});
	it("scenario C: cancelled unit", () => {
		const r = run({
			"x": workUnit({ id: "x", taskId: "t", kind: "custom", label: "x", order: 0, status: "cancelled", attempts: [{ attemptId: "x:1", requestId: "rx", number: 1, startedAt: 1, completedAt: 2, status: "cancelled" }] }),
		}, { t: { id: "t", label: "T", order: 0 } });
		const card = buildTaskActivitiesFromRun(r);
		const dock = buildActivitySnapshot(state(), r).workflow!.tasks;
		assert.deepEqual(card.map(x => `${x.state} ${x.completed}/${x.total}`), dock.map(x => `${x.state} ${x.completed}/${x.total}`));
	});

	it("dock collapsed summary reports the same task-level count as the card", () => {
		const r = run({
			"a": workUnit({ id: "a", taskId: "t", kind: "custom", label: "a", order: 0, status: "completed", attempts: [{ attemptId: "a:1", requestId: "ra", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"b": workUnit({ id: "b", taskId: "t", kind: "custom", label: "b", order: 1, status: "accepted", attempts: [{ attemptId: "b:1", requestId: "rb", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"c": workUnit({ id: "c", taskId: "t2", kind: "custom", label: "c", order: 0, status: "running", attempts: [{ attemptId: "c:1", requestId: "rc", number: 1, startedAt: 1, status: "running" }] }),
		}, { t: { id: "t", label: "T", order: 0 }, t2: { id: "t2", label: "T2", order: 1 } });
		const snapshot = buildActivitySnapshot(state(), r);
		const dock = renderActivityDock(snapshot, 120, theme as never)[0]!;
		// 2 tasks: t completed, t2 running -> 1 运行 · 1 完成 (task-level, matches card).
		assert.match(dock, /1 运行/);
		assert.match(dock, /1 完成/);
		assert.doesNotMatch(dock, /2 完成/, "must count tasks, not the 2 executions under task t");
	});
});