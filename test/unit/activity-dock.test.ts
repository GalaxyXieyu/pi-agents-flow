import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildActivitySnapshot } from "../../src/activity/projection.ts";
import { activitySelections, createActivityDockController, renderActivityDock, visibleActivitySelections, ACTIVITY_DOCK_WIDGET_KEY } from "../../src/tui/activity-dock.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import type { WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function state(): SubagentState {
	return {
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
	};
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
	return {
		version: 1,
		id: "workflow-1",
		mode: "general",
		goal: "Ship the redesign",
		language: "zh",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 3,
		createdAt: 1,
		updatedAt: 2,
		tasks: {
			"task-done": { id: "task-done", label: "收尾旧文档", order: 0 },
			"task-recon": { id: "task-recon", label: "前期侦察", order: 1 },
			"task-doc": { id: "task-doc", label: "设计文档", order: 2 },
		},
		nodes: {
			"cleanup-a": workUnit({ id: "cleanup-a", taskId: "task-done", kind: "custom", label: "归档旧文", order: 0, status: "completed", attempts: [{ attemptId: "cleanup-a:1", requestId: "r-a", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"cleanup-b": workUnit({ id: "cleanup-b", taskId: "task-done", kind: "custom", label: "更新索引", order: 1, status: "accepted", attempts: [{ attemptId: "cleanup-b:1", requestId: "r-b", number: 1, startedAt: 1, completedAt: 2, status: "completed" }] }),
			"loop": workUnit({ id: "loop", taskId: "task-recon", kind: "research", label: "loop engineering", order: 0, status: "completed", attempts: [{ attemptId: "loop:1", requestId: "r-loop", number: 1, startedAt: 1, completedAt: 2, status: "completed", childRunId: "child-loop" }] }),
			"vibe": workUnit({ id: "vibe", taskId: "task-recon", kind: "research", label: "vibecoding 演化", order: 1, status: "running", attempts: [{ attemptId: "vibe:1", requestId: "r-vibe", number: 1, startedAt: 3, status: "running", childRunId: "child-vibe" }] }),
			"doc": workUnit({ id: "doc", taskId: "task-doc", kind: "writer", label: "设计详细大纲", order: 0, status: "pending", dependsOn: ["loop", "vibe"] }),
		},
		decisions: [],
		appliedEventIds: [],
	};
}

function liveState() {
	const s = state();
	s.foregroundControls.set("child-vibe", {
		runId: "child-vibe",
		mode: "single",
		startedAt: 10,
		updatedAt: 20,
		currentAgent: "researcher",
		currentTool: "web_search",
		currentToolArgs: "vibecoding harness pain points",
		recentTools: [{ tool: "read", args: "notes.md" }],
	} as never);
	s.foregroundControls.set("solo", {
		runId: "solo",
		mode: "single",
		startedAt: 30,
		updatedAt: 40,
		currentAgent: "reviewer",
		description: "Review the diff",
		model: "deepseek-v4-flash",
		thinking: "medium",
	} as never);
	return s;
}

function failedReviewerSnapshot() {
	const snapshot = buildActivitySnapshot(liveState(), run());
	return {
		...snapshot,
		executions: snapshot.executions.map((execution) => execution.agent === "reviewer"
			? { ...execution, state: "failed" as const, error: "structured output failed" }
			: execution),
		independent: snapshot.independent.map((execution) => execution.agent === "reviewer"
			? { ...execution, state: "failed" as const, error: "structured output failed" }
			: execution),
	};
}

describe("activity dock projection", () => {
	it("groups work units under tasks and keeps independent agents separate", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		assert.equal(snapshot.workflow?.tasks.length, 3);
		const recon = snapshot.workflow?.tasks.find((task) => task.id === "task-recon");
		assert.equal(recon?.workUnits.length, 2);
		assert.equal(recon?.completed, 1);
		assert.equal(snapshot.independent.length, 1, "workflow executions claimed by tasks must not double-list as independent");
		assert.equal(snapshot.independent[0]?.agent, "reviewer");
	});

	it("folds terminal tasks to one row and expands active tasks", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const lines = renderActivityDock(snapshot, 120, theme as never, { active: true, perspective: "work" }).join("\n");
		assert.match(lines, /\[任务\]/);
		assert.match(lines, /● 收尾旧文档/);
		assert.doesNotMatch(lines, /归档旧文/, "completed work units stay folded under their terminal task");
		assert.doesNotMatch(lines, /更新索引/);
		assert.match(lines, /◐ 前期侦察/);
		assert.match(lines, /● loop engineering/);
		assert.match(lines, /◐ vibecoding 演化 · web_search/);
		assert.match(lines, /○ 设计文档/);
	});

	it("shows started executions in Agents without planned Work Units or model metadata", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const lines = renderActivityDock(snapshot, 120, theme as never, { active: true, perspective: "agents" }).join("\n");
		assert.match(lines, /\[Agents\]/);
		assert.match(lines, /● researcher/);
		assert.match(lines, /◐ researcher/);
		assert.match(lines, /reviewer/);
		assert.doesNotMatch(lines, /设计详细大纲/);
		assert.doesNotMatch(lines, /Not started/);
		assert.doesNotMatch(lines, /Duration unavailable/);
		assert.doesNotMatch(lines, /deepseek-v4-flash/);
		assert.doesNotMatch(lines, /thinking/);
	});

	it("hides failed Agents by default and keeps the f toggle in the header", () => {
		const snapshot = failedReviewerSnapshot();
		const hidden = renderActivityDock(snapshot, 140, theme as never, { active: true, perspective: "agents" }).join("\n");
		assert.match(hidden, /\[Agents\]/);
		assert.match(hidden, /f 显示失败 \(1\)/);
		assert.doesNotMatch(hidden, /✕ reviewer/);
		assert.doesNotMatch(hidden, /structured output failed/);
		const shown = renderActivityDock(snapshot, 140, theme as never, { active: true, perspective: "agents", showFailedAgents: true }).join("\n");
		assert.match(shown, /f 隐藏失败 \(1\)/);
		assert.match(shown, /✕ reviewer/);
		assert.match(shown, /structured output failed/);
	});

	it("uses the agreed status symbols and no status words", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const lines = renderActivityDock(snapshot, 120, theme as never, { active: true, perspective: "work" }).join("\n");
		assert.match(lines, /◐/);
		assert.match(lines, /●/);
		assert.match(lines, /○/);
		assert.doesNotMatch(lines, /RUN\b|DONE\b|WAIT\b/);
	});
});

describe("activity dock controller", () => {
	function fakeUi() {
		let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const widgets = new Map<string, unknown>();
		const editor = {
			render() { return []; },
			invalidate() {},
			handleInput() {},
			getText() { return ""; },
			setText() {},
		};
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, value: unknown) {
					if (value === undefined) widgets.delete(key);
					else widgets.set(key, value);
				},
				onTerminalInput(handler: typeof inputHandler) { inputHandler = handler; return () => { inputHandler = undefined; }; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		return { ctx, widgets, handler: () => inputHandler, tui: { focusedComponent: editor, requestRender() {} } };
	}

	function renderDock(ui: ReturnType<typeof fakeUi>, width = 100): string[] {
		const component = (ui.widgets.get(ACTIVITY_DOCK_WIDGET_KEY) as (tui: unknown, theme: unknown) => { render(w: number): string[] })(ui.tui, theme as never);
		return component.render(width);
	}

	it("registers one below-editor widget and switches perspective with v", () => {
		const ui = fakeUi();
		const controller = createActivityDockController({
			getSnapshot: () => buildActivitySnapshot(liveState(), run()),
			openSelection: () => {},
		});
		try {
			controller.setContext(ui.ctx);
			assert.equal(ui.widgets.has(ACTIVITY_DOCK_WIDGET_KEY), true);
			// Collapsed by default: a single aggregate line, no task tree yet.
			const collapsed = renderDock(ui);
			assert.equal(collapsed.length, 1, "inactive dock renders one summary line");
			assert.doesNotMatch(collapsed.join("\n"), /\[任务\]/);

			const handler = ui.handler();
			assert.ok(handler);
			assert.deepEqual(handler!("\x1b[B"), { consume: true }, "down activates the dock at an empty editor");
			assert.match(renderDock(ui).join("\n"), /\[任务\]/);
			assert.deepEqual(handler!("v"), { consume: true });
			assert.match(renderDock(ui).join("\n"), /\[Agents\]/);
			assert.deepEqual(handler!("v"), { consume: true });
			assert.match(renderDock(ui).join("\n"), /\[任务\]/);
		} finally {
			controller.dispose();
		}
	});

	it("opens the selected row with its current Tasks or Agents perspective", async () => {
		for (const expectedPerspective of ["work", "agents"] as const) {
			const ui = fakeUi();
			const opened: Array<{ key: string; perspective: "work" | "agents" }> = [];
			const controller = createActivityDockController({
				getSnapshot: () => buildActivitySnapshot(liveState(), run()),
				openSelection: (selection, perspective) => { opened.push({ key: selection.key, perspective }); },
			});
			try {
				controller.setContext(ui.ctx);
				renderDock(ui);
				const handler = ui.handler()!;
				handler("\x1b[B");
				if (expectedPerspective === "agents") handler("v");
				handler("\r");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(opened.length, 1);
				assert.equal(opened[0]?.perspective, expectedPerspective);
				assert.match(opened[0]?.key ?? "", expectedPerspective === "work" ? /^task:/ : /^execution:/);
			} finally {
				controller.dispose();
			}
		}
	});

	it("expands only active rows with x", () => {
		const ui = fakeUi();
		const controller = createActivityDockController({
			getSnapshot: () => buildActivitySnapshot(liveState(), run()),
			openSelection: () => {},
		});
		try {
			controller.setContext(ui.ctx);
			renderDock(ui, 120);
			const handler = ui.handler()!;
			handler("\x1b[B");
			// Selection starts on the terminal task; x must not add rows.
			const folded = renderDock(ui, 120).length;
			handler("x");
			assert.equal(renderDock(ui, 120).length, folded);
			// Move to the running work unit and expand its live activity.
			handler("\x1b[B");
			handler("\x1b[B");
			handler("\x1b[B");
			handler("x");
			const expanded = renderDock(ui, 120).join("\n");
			assert.match(expanded, /web_search/);
			assert.match(expanded, /read · notes\.md/);
		} finally {
			controller.dispose();
		}
	});

	it("toggles hidden failed Agents with f in the Agents perspective", () => {
		const ui = fakeUi();
		const snapshot = failedReviewerSnapshot();
		const controller = createActivityDockController({
			getSnapshot: () => snapshot,
			openSelection: () => {},
		});
		try {
			controller.setContext(ui.ctx);
			renderDock(ui, 140);
			const handler = ui.handler()!;
			handler("\x1b[B");
			handler("v");
			const hidden = renderDock(ui, 140).join("\n");
			assert.match(hidden, /f 显示失败 \(1\)/);
			assert.doesNotMatch(hidden, /✕ reviewer/);
			assert.deepEqual(handler("f"), { consume: true });
			const shown = renderDock(ui, 140).join("\n");
			assert.match(shown, /f 隐藏失败 \(1\)/);
			assert.match(shown, /✕ reviewer/);
		} finally {
			controller.dispose();
		}
	});

	it("follows a newly spawned top Agent while the user is following the head", async () => {
		const ui = fakeUi();
		const s = liveState();
		const opened: string[] = [];
		const controller = createActivityDockController({
			getSnapshot: () => buildActivitySnapshot(s, run()),
			openSelection: (selection) => { opened.push(selection.key); },
		});
		try {
			controller.setContext(ui.ctx);
			renderDock(ui);
			const handler = ui.handler()!;
			handler("\x1b[B");
			handler("v");
			s.foregroundControls.set("newest", {
				runId: "newest", mode: "single", startedAt: 50, updatedAt: 51,
				currentAgent: "debugger", description: "Newest investigation",
			} as never);
			const expectedHead = activitySelections(buildActivitySnapshot(s, run()), "agents")[0]?.key;
			controller.refresh();
			handler("\r");
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(opened[0], expectedHead, "a new top Agent becomes selected and visible while following live work");
		} finally {
			controller.dispose();
		}
	});

	it("does not steal the Agents selection while the user browses older rows", async () => {
		const ui = fakeUi();
		const s = liveState();
		const opened: string[] = [];
		const controller = createActivityDockController({
			getSnapshot: () => buildActivitySnapshot(s, run()),
			openSelection: (selection) => { opened.push(selection.key); },
		});
		try {
			controller.setContext(ui.ctx);
			renderDock(ui);
			const handler = ui.handler()!;
			handler("\x1b[B");
			handler("v");
			handler("j");
			const browsedKey = activitySelections(buildActivitySnapshot(s, run()), "agents")[1]?.key;
			s.foregroundControls.set("newest", {
				runId: "newest", mode: "single", startedAt: 50, updatedAt: 51,
				currentAgent: "debugger", description: "Newest investigation",
			} as never);
			controller.refresh();
			handler("\r");
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(opened[0], browsedKey, "manual browsing must survive roster refreshes");
		} finally {
			controller.dispose();
		}
	});

	it("keeps the last snapshot mounted when the store read throws", () => {
		const ui = fakeUi();
		let fail = false;
		const controller = createActivityDockController({
			getSnapshot: () => {
				if (fail) throw new Error("binding revision stale");
				return buildActivitySnapshot(liveState(), run());
			},
			openSelection: () => {},
		});
		try {
			controller.setContext(ui.ctx);
			assert.equal(ui.widgets.has(ACTIVITY_DOCK_WIDGET_KEY), true);
			fail = true;
			controller.refresh();
			assert.equal(ui.widgets.has(ACTIVITY_DOCK_WIDGET_KEY), true, "transient store failures must not swap the surface");
		} finally {
			controller.dispose();
		}
	});

	it("unmounts the dock widget once the workflow reaches a terminal state", () => {
		const ui = fakeUi();
		const completed = { ...run(), status: "completed" as const, nodes: {
			...run().nodes,
			"vibe": { ...run().nodes["vibe"], status: "completed", attempts: [{ attemptId: "vibe:1", requestId: "r-vibe", number: 1, startedAt: 3, completedAt: 5, status: "completed" as const, childRunId: "child-vibe" }] },
			"doc": { ...run().nodes["doc"], status: "completed", attempts: [{ attemptId: "doc:1", requestId: "r-doc", number: 1, startedAt: 6, completedAt: 8, status: "completed" as const }] },
		} };
		let currentRun = run();
		const controller = createActivityDockController({
			getSnapshot: () => buildActivitySnapshot(liveState(), currentRun),
			openSelection: () => {},
		});
		try {
			controller.setContext(ui.ctx);
			renderDock(ui);
			const handler = ui.handler()!;
			handler("\x1b[B"); // expand
			assert.ok(ui.widgets.has(ACTIVITY_DOCK_WIDGET_KEY));
			// Simulate the workflow finishing while the dock is expanded.
			currentRun = completed;
			controller.refresh();
			assert.equal(ui.widgets.has(ACTIVITY_DOCK_WIDGET_KEY), false, "terminal workflow unmounts the dock widget entirely");
		} finally {
			controller.dispose();
		}
	});
});

describe("activity selections", () => {
	it("lists only Work Units with attempts in the agents perspective", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const rows = activitySelections(snapshot, "agents");
		assert.equal(rows.length, 5);
		assert.ok(rows.every((row) => row.kind !== "execution" || row.execution.workUnitId !== "doc"));
	});

	it("hides failed Agents from the visible Agents roster by default", () => {
		const snapshot = failedReviewerSnapshot();
		assert.equal(activitySelections(snapshot, "agents").length, 5);
		const visible = visibleActivitySelections(snapshot, "agents");
		assert.equal(visible.length, 4);
		assert.ok(visible.every((row) => row.kind !== "execution" || row.execution.agent !== "reviewer"));
		assert.equal(visibleActivitySelections(snapshot, "agents", true).length, 5);
	});

	it("orders equal-state Agents newest first", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const running = activitySelections(snapshot, "agents").filter((row) => row.kind === "execution" && row.execution.state === "running");
		assert.deepEqual(running.map((row) => row.kind === "execution" ? row.execution.startedAt : 0), [30, 3]);
	});

	it("folds terminal tasks in the work perspective", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const keys = activitySelections(snapshot, "work").map((row) => row.key);
		assert.ok(keys.includes("task:task-done"));
		assert.ok(!keys.includes("work-unit:cleanup-a"), "work units under a terminal task stay folded");
		assert.ok(keys.includes("task:task-recon"));
		assert.ok(keys.includes("work-unit:loop"), "work units under an active task remain visible as single rows");
		assert.ok(keys.includes("work-unit:vibe"));
	});
});

describe("activity dock collapsed summary", () => {
	it("defaults to a single aggregate line with counts and an expand hint (zh)", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const lines = renderActivityDock(snapshot, 120, theme as never);
		assert.equal(lines.length, 1, "inactive dock stays one line tall");
		const line = lines[0]!;
		assert.match(line, /工作流/);
		// Task-level counts (shared with the inline card): task-recon is running,
		// task-done is completed, task-doc is pending.
		assert.match(line, /1 运行/);
		assert.match(line, /1 完成/);
		assert.match(line, /↓\/Tab 展开/);
		assert.doesNotMatch(line, /\[任务\]/);
	});

	it("localizes the collapsed summary to English", () => {
		const snapshot = { ...buildActivitySnapshot(liveState(), run()), language: "en" as const };
		const line = renderActivityDock(snapshot, 120, theme as never)[0]!;
		assert.match(line, /Workflow/);
		assert.match(line, /1 running/);
		assert.match(line, /1 done/);
		assert.match(line, /↓\/Tab expand/);
	});

	it("omits the failed count when nothing has failed and shows the running badge", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const line = renderActivityDock(snapshot, 120, theme as never)[0]!;
		assert.doesNotMatch(line, /失败|failed/);
		assert.match(line, /◐/);
	});

	it("falls back to independent execution counts when no workflow is bound", () => {
		const s = state();
		s.foregroundControls.set("solo-a", {
			runId: "solo-a", mode: "single", startedAt: 1, updatedAt: 2,
			currentAgent: "reviewer", description: "Review",
		} as never);
		s.foregroundControls.set("solo-b", {
			runId: "solo-b", mode: "single", startedAt: 1, updatedAt: 2,
			currentAgent: "researcher", description: "Research",
		} as never);
		const snapshot = buildActivitySnapshot(s, undefined);
		const line = renderActivityDock(snapshot, 120, theme as never)[0]!;
		assert.doesNotMatch(line, /工作流|Workflow/);
		assert.match(line, /2 running/);
	});

	// A finished workflow must not leave a stale "0 running" (or a live-looking
	// roster) on the collapsed line — it should read as "Workflow N done".
	it("hides the dock entirely once the workflow has completed", () => {
		const completed = { ...run(), status: "completed" as const, nodes: {
			...run().nodes,
			"vibe": { ...run().nodes["vibe"], status: "completed", attempts: [{ attemptId: "vibe:1", requestId: "r-vibe", number: 1, startedAt: 3, completedAt: 5, status: "completed" as const, childRunId: "child-vibe" }] },
			"doc": { ...run().nodes["doc"], status: "completed", attempts: [{ attemptId: "doc:1", requestId: "r-doc", number: 1, startedAt: 6, completedAt: 8, status: "completed" as const }] },
		} };
		const snapshot = buildActivitySnapshot(liveState(), completed);
		const lines = renderActivityDock(snapshot, 120, theme as never);
		assert.equal(lines.length, 0, "a completed workflow renders no dock rows at all");
	});

	it("renders the collapsed summary while the workflow is still active", () => {
		const snapshot = buildActivitySnapshot(liveState(), run());
		const line = renderActivityDock(snapshot, 120, theme as never)[0]!;
		assert.match(line, /工作流/);
		assert.match(line, /1 运行/);
		assert.match(line, /1 完成/);
	});
});
