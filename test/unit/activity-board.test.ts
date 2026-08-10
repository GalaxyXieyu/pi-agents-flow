import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildActivitySnapshot } from "../../src/activity/projection.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { ActivityBoardComponent } from "../../src/tui/activity-board.ts";
import { fleetIdentity } from "../../src/tui/fleet-identity.ts";
import { fleetItemIdentityKey } from "../../src/tui/fleet.ts";
import type { WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function state(): SubagentState {
	const now = Date.now();
	const result = {
		baseCwd: "/repo",
		currentSessionId: "session-1",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} satisfies SubagentState;
	result.foregroundControls.set("child-live", {
		runId: "child-live",
		mode: "single",
		startedAt: now - 10_000,
		updatedAt: now,
		currentAgent: "researcher",
		currentTool: "web_search",
		currentToolArgs: "activity board",
		tokens: 1500,
		inputTokens: 1000,
		outputTokens: 500,
		toolCount: 3,
	} as never);
	result.foregroundControls.set("solo", {
		runId: "solo",
		mode: "single",
		startedAt: now - 5_000,
		updatedAt: now,
		currentAgent: "reviewer",
		currentTool: "read",
		tokens: 800,
		inputTokens: 600,
		outputTokens: 200,
		toolCount: 1,
	} as never);
	return result;
}

function workUnit(partial: Partial<WorkflowNode> & Pick<WorkflowNode, "id" | "taskId" | "kind" | "label" | "order" | "status">): WorkflowNode {
	return {
		dependsOn: [],
		attempts: [],
		agentSpec: {
			id: `agent-${partial.id}`,
			baseAgent: "researcher",
			role: "researcher",
			objective: partial.id,
			instructions: partial.id,
			context: "fresh",
		},
		...partial,
	};
}

function run(): WorkflowRun {
	const now = Date.now();
	return {
		version: 1,
		id: "workflow-1",
		mode: "general",
		goal: "Ship the activity redesign",
		language: "en",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 1,
		createdAt: 1,
		updatedAt: 2,
		tasks: {
			"task-main": { id: "task-main", label: "Build the board", order: 0 },
			"task-next": { id: "task-next", label: "Verify the board", order: 1 },
		},
		nodes: {
			live: workUnit({ id: "live", taskId: "task-main", kind: "research", label: "Inspect current behavior", order: 0, status: "running", attempts: [{ attemptId: "live:1", requestId: "r-live", childRunId: "child-live", number: 1, startedAt: now - 10_000, status: "running" }] }),
			pending: workUnit({ id: "pending", taskId: "task-main", kind: "writer", label: "Implement task view", order: 1, status: "pending" }),
			verify: workUnit({ id: "verify", taskId: "task-next", kind: "verification", label: "Run regressions", order: 0, status: "ready" }),
		},
		decisions: [],
		appliedEventIds: [],
	};
}

function board(input: {
	perspective: "work" | "agents";
	initialKey?: string;
	getSnapshot?: () => ReturnType<typeof buildActivitySnapshot>;
}) {
	const swarmState = state();
	let closed = 0;
	const inspected: Array<{ key: string; language: "zh" | "en" }> = [];
	let renders = 0;
	const getSnapshot = input.getSnapshot ?? (() => buildActivitySnapshot(swarmState, run()));
	const component = new ActivityBoardComponent(
		{ terminal: { rows: 40, columns: 120 }, requestRender: () => { renders++; } },
		theme as never,
		{ ui: { notify() {} } } as unknown as ExtensionContext,
		swarmState,
		getSnapshot,
		() => { closed++; },
		{
			initialPerspective: input.perspective,
			...(input.initialKey ? { initialKey: input.initialKey } : {}),
			openInspector: (initialKey, language) => { inspected.push({ key: initialKey, language }); },
		},
	);
	return { component, inspected, closed: () => closed, renders: () => renders };
}

describe("activity board", () => {
	it("keeps the entry perspective and renders Tasks as a grouped hierarchy", () => {
		const view = board({ perspective: "work", initialKey: "work-unit:live" });
		const lines = view.component.render(120);
		const text = lines.join("\n");
		assert.match(text, /Activity Board · Tasks/);
		assert.match(text, /Build the board/);
		assert.match(text, /Inspect current behavior/);
		assert.match(text, /researcher · researcher/);
		assert.match(text, /Verify the board/);
		assert.doesNotMatch(text, /Activity Board · Agents/);
		assert.match(text, /PLAN DETAILS/);
		assert.match(text, /AGENT ACTIVITY/);
		assert.match(text, /10s runtime · 1\.5k tok/);
		assert.match(text, /in 1\.0k/);
		assert.match(text, /out 500/);
		assert.match(text, /3 tools/);
		assert.match(text, /Duration\s+10s/);
		assert.ok(lines.length < 30, "the board must remain bounded in a 40-row terminal");
	});

	it("keeps a Task running while a sibling repair is active", () => {
		const workflow = run();
		workflow.nodes.failed = workUnit({
			id: "failed", taskId: "task-main", kind: "writer", label: "Original write", order: 2, status: "failed",
			attempts: [{ attemptId: "failed:1", requestId: "r-failed", number: 1, startedAt: Date.now() - 5_000, completedAt: Date.now(), status: "failed", error: "invalid contract" }],
		});
		workflow.nodes.repair = workUnit({
			id: "repair", taskId: "task-main", kind: "writer", label: "Replacement write", order: 3, status: "running", replaces: "failed",
			attempts: [{ attemptId: "repair:1", requestId: "r-repair", number: 1, startedAt: Date.now() - 1_000, status: "running" }],
		});
		const snapshot = buildActivitySnapshot(state(), workflow);
		assert.equal(snapshot.workflow?.tasks[0]?.state, "running");
		const view = board({ perspective: "work", initialKey: "work-unit:failed", getSnapshot: () => snapshot });
		const text = view.component.render(120).join("\n");
		assert.match(text, /Replacement write \(running\) is handling this/);
	});

	it("projects non-retryable failure class and replacement guidance into plan details", () => {
		const now = Date.now();
		const workflow = run();
		workflow.nodes.quota = workUnit({
			id: "quota", taskId: "task-main", kind: "research", label: "Quota-bound research", order: 2, status: "failed",
			attempts: [{
				attemptId: "quota:1",
				requestId: "r-quota",
				number: 1,
				startedAt: now - 5_000,
				completedAt: now,
				status: "failed",
				error: "quota exhausted",
				failure: {
					failureClass: "provider_quota_exhausted",
					retryable: false,
					suggestedAction: "Switch provider or create a same-kind replacement with an explicit model.",
				},
			}],
		});
		const snapshot = buildActivitySnapshot(state(), workflow);
		const execution = snapshot.workflow?.tasks
			.flatMap((task) => task.workUnits)
			.find((unit) => unit.id === "quota")
			?.executions.at(-1);
		// Projection retains the durable failure disposition for downstream consumers.
		assert.equal(execution?.failureClass, "provider_quota_exhausted");
		assert.equal(execution?.retryable, false);
		assert.match(execution?.suggestedAction ?? "", /same-kind replacement/);
		// Plan details must surface the actionable recovery path even when Agent Activity is height-truncated.
		const view = board({ perspective: "work", initialKey: "work-unit:quota", getSnapshot: () => snapshot });
		const text = view.component.render(120).join("\n");
		assert.match(text, /Next step\s+Create a same-kind replacement for 'quota'\./);
		assert.match(text, /Why\s+provider_quota_exhausted: Switch provider or create a/);
		assert.match(text, /same-kind replacement with an explicit model/);
	});

	it("projects retryable failure guidance with exact run_ready nodeId", () => {
		const now = Date.now();
		const workflow = run();
		workflow.nodes.transport = workUnit({
			id: "transport", taskId: "task-main", kind: "research", label: "Transport blip", order: 2, status: "failed",
			attempts: [{
				attemptId: "transport:1",
				requestId: "r-transport",
				number: 1,
				startedAt: now - 3_000,
				completedAt: now,
				status: "failed",
				error: "stream reset",
				failure: {
					failureClass: "provider_transport_failed",
					retryable: true,
					suggestedAction: "Retry the same node after the transport recovers.",
				},
			}],
		});
		const snapshot = buildActivitySnapshot(state(), workflow);
		const execution = snapshot.workflow?.tasks
			.flatMap((task) => task.workUnits)
			.find((unit) => unit.id === "transport")
			?.executions.at(-1);
		assert.equal(execution?.failureClass, "provider_transport_failed");
		assert.equal(execution?.retryable, true);
		const view = board({ perspective: "work", initialKey: "work-unit:transport", getSnapshot: () => snapshot });
		// Board wrapping may split the recovery line across frame cells; strip chrome before matching.
		const text = view.component.render(120)
			.join("\n")
			.replace(/\x1B\[[0-9;]*m/g, "")
			.replace(/[│╭╮╰╯├┤┬┴─]/gu, " ")
			.replace(/\s+/g, " ");
		assert.match(text, /Next step Retry only this node \(1\/3\) with run_ready nodeId='transport'\./);
	});

	it("collapses a Task with Enter and inspects a Work Unit without closing the board", () => {
		const taskView = board({ perspective: "work", initialKey: "task:task-main" });
		taskView.component.handleInput("\r");
		const collapsed = taskView.component.render(120);
		assert.match(collapsed.join("\n"), /PLAN DETAILS/);
		const leftColumn = collapsed.map((line) => line.split("│")[1] ?? "").join("\n");
		assert.doesNotMatch(leftColumn, /Inspect current behavior/);
		assert.equal(taskView.closed(), 0);

		const unitView = board({ perspective: "work", initialKey: "work-unit:live" });
		unitView.component.handleInput("\r");
		assert.deepEqual(unitView.inspected, [{ key: "foreground-active:child-live:0", language: "en" }]);
		assert.equal(unitView.closed(), 0, "closing Fleet should return to the existing Tasks board");
	});

	it("opens the selected Agent in Fleet without closing the board", () => {
		const snapshot = buildActivitySnapshot(state(), run());
		const solo = snapshot.independent[0];
		assert.ok(solo);
		const view = board({ perspective: "agents", initialKey: `execution:${solo.key}` });
		assert.match(view.component.render(120).join("\n"), /Activity Board · Agents/);
		view.component.handleInput("\r");
		assert.deepEqual(view.inspected, [{ key: solo.inspectKey, language: "en" }]);
		assert.equal(view.closed(), 0);
	});

	it("keeps employee identity and language consistent when opening Fleet", () => {
		const workflow = run();
		workflow.language = "zh";
		const snapshot = buildActivitySnapshot(state(), workflow);
		const solo = snapshot.independent[0];
		assert.ok(solo?.fleetItem);
		const expectedName = fleetIdentity(fleetItemIdentityKey(solo.fleetItem), "zh").name;
		const view = board({ perspective: "agents", initialKey: `execution:${solo.key}`, getSnapshot: () => snapshot });
		assert.match(view.component.render(120).join("\n"), new RegExp(expectedName));
		view.component.handleInput("\r");
		assert.deepEqual(view.inspected, [{ key: solo.inspectKey, language: "zh" }]);
	});

	it("hides failed Agents by default and toggles them with f", () => {
		const snapshot = buildActivitySnapshot(state(), run());
		const failedSnapshot = {
			...snapshot,
			executions: snapshot.executions.map((execution) => execution.agent === "reviewer" ? { ...execution, state: "failed" as const, error: "failed" } : execution),
			independent: snapshot.independent.map((execution) => execution.agent === "reviewer" ? { ...execution, state: "failed" as const, error: "failed" } : execution),
		};
		const view = board({ perspective: "agents", getSnapshot: () => failedSnapshot });
		const hiddenText = view.component.render(120).join("\n");
		assert.doesNotMatch(hiddenText, /✕/);
		assert.match(hiddenText, /15s runtime · 2\.3k tok/);
		view.component.handleInput("f");
		assert.match(view.component.render(120).join("\n"), /✕/);
		assert.match(view.component.render(120).join("\n"), /Hide failed \(1\)/);
		assert.match(view.component.render(120).join("\n"), /15s runtime · 2\.3k tok/);

		const failed = failedSnapshot.executions.find((execution) => execution.agent === "reviewer");
		assert.ok(failed?.inspectKey);
		const focused = board({ perspective: "agents", initialKey: `execution:${failed.key}`, getSnapshot: () => failedSnapshot });
		focused.component.handleInput("f");
		focused.component.handleInput("f");
		focused.component.handleInput("\r");
		assert.deepEqual(focused.inspected, [{ key: failed.inspectKey, language: "en" }]);
	});

	it("keeps unstarted Work Units in Tasks without creating Agent rows", () => {
		const snapshot = buildActivitySnapshot(state(), run());
		assert.equal(snapshot.executions.some((execution) => execution.workUnitId === "pending"), false);
		assert.equal(snapshot.executions.some((execution) => execution.workUnitId === "verify"), false);

		const agents = board({ perspective: "agents", getSnapshot: () => snapshot }).component.render(120).join("\n");
		assert.doesNotMatch(agents, /Duration unavailable/);

		const tasks = board({ perspective: "work", initialKey: "work-unit:pending", getSnapshot: () => snapshot }).component.render(120).join("\n");
		assert.match(tasks, /Implement task view/);
		assert.match(tasks, /Not started/);
	});

	it("preserves selection by key when live Agent ordering changes", () => {
		const swarmState = state();
		let snapshot = buildActivitySnapshot(swarmState, run());
		const solo = snapshot.independent[0];
		assert.ok(solo);
		const view = board({ perspective: "agents", initialKey: `execution:${solo.key}`, getSnapshot: () => snapshot });
		snapshot = {
			...snapshot,
			executions: snapshot.executions.map((execution) => execution.key === solo.key ? { ...execution, state: "completed" } : execution),
		};
		view.component.invalidate();
		view.component.handleInput("\r");
		assert.deepEqual(view.inspected, [{ key: solo.inspectKey, language: "en" }]);
	});

	it("keeps a stable Agent key across active and terminal foreground states", () => {
		const swarmState = state();
		const active = buildActivitySnapshot(swarmState).independent.find((execution) => execution.agent === "reviewer");
		assert.ok(active);
		swarmState.foregroundControls.clear();
		swarmState.foregroundRuns?.set("solo", {
			runId: "solo",
			mode: "single",
			cwd: "/repo",
			sessionId: "session-1",
			updatedAt: Date.now(),
			children: [{ agent: "reviewer", index: 0, status: "completed" }],
		});
		const terminal = buildActivitySnapshot(swarmState).independent.find((execution) => execution.agent === "reviewer");
		assert.equal(terminal?.key, active.key);
		assert.notEqual(terminal?.inspectKey, active.inspectKey);
	});

	it("aggregates historical and current retry usage", () => {
		const workflow = run();
		const live = workflow.nodes.live;
		assert.ok(live);
		live.attempts.unshift({
			attemptId: "live:0",
			requestId: "r-old",
			childRunId: "old",
			number: 0,
			startedAt: Date.now() - 20_000,
			completedAt: Date.now() - 15_000,
			status: "completed",
			usage: { input: 400, output: 100, cacheRead: 50, cacheWrite: 25, cost: 0.01, turns: 1, toolCalls: 2, durationMs: 5_000 },
		});
		const swarmState = state();
		swarmState.foregroundRuns?.set("old", {
			runId: "old",
			mode: "single",
			cwd: "/repo",
			sessionId: "session-1",
			updatedAt: Date.now() - 15_000,
			children: [{ agent: "researcher", index: 0, status: "completed", durationMs: 5_000, usage: { input: 400, output: 100, cacheRead: 50, cacheWrite: 25, cost: 0.01, turns: 1 } }],
		});
		const snapshot = buildActivitySnapshot(swarmState, workflow);
		const unit = snapshot.workflow?.tasks[0]?.workUnits[0];
		assert.equal(unit?.usage?.inputTokens, 1400);
		assert.equal(unit?.usage?.outputTokens, 600);
		assert.equal(unit?.usage?.totalTokens, 2000);
		assert.equal(unit?.usage?.toolCalls, 5);
		assert.doesNotMatch(snapshot.independent.map((execution) => execution.key).join("\n"), /old/);
		const agents = board({ perspective: "agents", getSnapshot: () => snapshot }).component.render(120).join("\n");
		assert.match(agents, /20s runtime · 2\.8k tok/);
	});

	it("projects evidence and run files and renders clickable locations", () => {
		const workflow = run();
		workflow.nodes.live!.attempts[0]!.structuredOutputPath = "/repo/.pi-agents-flow/live-result.json";
		workflow.nodes.live!.attempts[0]!.metadataPath = "/repo/.pi-agents-flow/live-meta.json";
		workflow.nodes.live!.attempts[0]!.result = {
			summary: "Live result",
			findings: [],
			gaps: [],
			conflicts: [],
			recommendations: [],
			artifactPaths: ["/repo/reports/findings.md:12:4", `/safe${String.fromCharCode(27)}]8;;https://evil.test${String.fromCharCode(7)}path`],
		};
		const snapshot = buildActivitySnapshot(state(), workflow);
		const unit = snapshot.workflow?.tasks[0]?.workUnits[0];
		assert.ok(unit);
		assert.deepEqual(unit.artifacts.map((item) => [item.kind, item.label, item.path]), [
			["evidence", "Evidence", "/repo/reports/findings.md:12:4"],
			["run", "Structured result", "/repo/.pi-agents-flow/live-result.json"],
			["run", "Metadata", "/repo/.pi-agents-flow/live-meta.json"],
		]);
		const view = board({ perspective: "work", initialKey: "work-unit:live", getSnapshot: () => snapshot });
		const text = view.component.render(120).join("\n");
		assert.match(text, /Evidence files/);
		assert.match(text, /findings\.md:12:4/);
		assert.ok(text.includes(`${String.fromCharCode(27)}]8;;file:///repo/reports/findings.md#L12:4`));
		assert.doesNotMatch(text, /evil\.test/);
	});

	it("does not accrue duration for an async step that has not started", () => {
		const swarmState = state();
		swarmState.foregroundControls.clear();
		swarmState.fleetJobs!.set("queued-chain", {
			asyncId: "queued-chain",
			asyncDir: "/repo/.pi-agents-flow/queued-chain",
			cwd: "/repo",
			sessionId: "session-1",
			status: "running",
			mode: "chain",
			startedAt: Date.now() - 60_000,
			updatedAt: Date.now(),
			steps: [
				{ agent: "researcher", index: 0, status: "running", startedAt: Date.now() - 10_000 },
				{ agent: "reviewer", index: 1, status: "pending" },
			],
		});
		const snapshot = buildActivitySnapshot(swarmState);
		const pending = snapshot.independent.find((execution) => execution.agent === "reviewer");
		assert.ok(pending);
		assert.equal(pending.durationMs, undefined);
	});

	it("keeps terminal Agent duration and usage in the activity projection", () => {
		const swarmState = state();
		swarmState.foregroundControls.clear();
		swarmState.foregroundRuns?.set("done", {
			runId: "done",
			mode: "single",
			cwd: "/repo",
			sessionId: "session-1",
			updatedAt: Date.now(),
			children: [{
				agent: "reviewer",
				index: 0,
				status: "completed",
				durationMs: 12_000,
				toolCount: 4,
				usage: { input: 900, output: 300, cacheRead: 200, cacheWrite: 100, cost: 0.012, turns: 2 },
			}],
		});
		const snapshot = buildActivitySnapshot(swarmState);
		const execution = snapshot.independent[0];
		assert.ok(execution);
		assert.equal(execution.durationMs, 12_000);
		assert.deepEqual(execution.usage, {
			inputTokens: 900,
			outputTokens: 300,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			totalTokens: 1200,
			costUsd: 0.012,
			toolCalls: 4,
		});
	});

	it("shows no plan instead of relabeling independent executions as Tasks", () => {
		const snapshot = buildActivitySnapshot(state());
		const view = board({ perspective: "work", getSnapshot: () => snapshot });
		const text = view.component.render(120).join("\n");
		assert.match(text, /No task plan/);
		assert.doesNotMatch(text, /Independent executions/);
	});

	it("uses a bounded compact view in a short terminal", () => {
		const view = board({ perspective: "work" });
		const terminal = (view.component as unknown as { tui: { terminal: { rows: number } } }).tui.terminal;
		for (const rows of [6, 10, 11, 12]) {
			terminal.rows = rows;
			const lines = view.component.render(80);
			assert.ok(lines.length <= rows, `rendered ${lines.length} lines in a ${rows}-row terminal`);
			assert.match(lines[0] ?? "", /Activity Board · Tasks/);
		}
	});

	it("keeps every rendered line within narrow terminal widths", () => {
		for (const perspective of ["work", "agents"] as const) {
			const view = board({ perspective });
			for (const width of [36, 52, 70]) {
				const lines = view.component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `${perspective} exceeded ${width} columns`);
			}
		}
	});
});
