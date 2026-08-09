import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, type Component, type EditorComponent } from "@earendil-works/pi-tui";
import { activityLeadState, summarizeActivityStates } from "../activity/summary.ts";
import type { ActivityPerspective, ActivitySelection, ActivitySnapshot, ActivityState, AgentExecutionActivity, TaskActivity, WorkUnitActivity } from "../activity/types.ts";
import { formatClockDuration, formatDuration, formatTokens } from "../shared/formatters.ts";
import { bounded, rightAlign } from "./render-helpers.ts";
import { selectionMarker, statusBadge } from "./visual-language.ts";

export const ACTIVITY_DOCK_WIDGET_KEY = "pi-agents-flow-activity-dock";

const TERMINAL = new Set<ActivityState>(["completed", "accepted", "failed", "cancelled", "superseded"]);

type Theme = ExtensionContext["ui"]["theme"];

export interface ActivityDockState {
	active?: boolean;
	perspective?: ActivityPerspective;
	selectedKey?: string;
	expandedKey?: string;
	spinnerFrame?: number;
}

function badge(state: ActivityState, theme: Theme, frame: number): string {
	if (state === "waiting") return theme.fg("warning", "◌");
	if (state === "paused") return theme.fg("warning", "⏸");
	if (state === "cancelled" || state === "superseded") return theme.fg("dim", "⊘");
	if (state === "failed") return theme.fg("error", "✕");
	return statusBadge(state, theme, 1, state === "running" ? frame : undefined);
}

function taskRows(task: TaskActivity, depth: number, rows: ActivitySelection[]): void {
	rows.push({ kind: "task", key: `task:${task.id}`, task });
	if (TERMINAL.has(task.state)) return;
	for (const child of task.children) taskRows(child, depth + 1, rows);
	for (const workUnit of task.workUnits) rows.push({ kind: "work-unit", key: `work-unit:${workUnit.id}`, task, workUnit });
}

const AGENT_STATE_ORDER: Record<ActivityState, number> = {
	running: 0,
	waiting: 1,
	ready: 2,
	paused: 3,
	pending: 4,
	failed: 5,
	completed: 6,
	accepted: 7,
	cancelled: 8,
	superseded: 9,
};

export function activitySelections(snapshot: ActivitySnapshot, perspective: ActivityPerspective): ActivitySelection[] {
	if (perspective === "agents") {
		return snapshot.executions
			.map((execution, index) => ({ execution, index }))
			.sort((left, right) => AGENT_STATE_ORDER[left.execution.state] - AGENT_STATE_ORDER[right.execution.state]
				|| (left.execution.taskPath ?? "").localeCompare(right.execution.taskPath ?? "")
				|| left.index - right.index)
			.map(({ execution }) => ({ kind: "execution" as const, key: `execution:${execution.key}`, execution }));
	}
	const rows: ActivitySelection[] = [];
	for (const task of snapshot.workflow?.tasks ?? []) taskRows(task, 0, rows);
	for (const execution of snapshot.independent) rows.push({ kind: "execution", key: `execution:${execution.key}`, execution });
	return rows;
}

function taskDepth(task: TaskActivity, tasks: TaskActivity[], depth = 0): number {
	for (const root of tasks) {
		if (root.id === task.id) return depth;
		const nested = taskDepth(task, root.children, depth + 1);
		if (nested >= 0) return nested;
	}
	return -1;
}

function localize(language: ActivitySnapshot["language"], en: string, zh: string): string {
	return language === "zh" ? zh : en;
}

function executionSuffix(execution: AgentExecutionActivity): string {
	if (execution.state === "failed") return execution.error ? ` · ${execution.error}` : "";
	if (execution.state === "waiting") return execution.error ? ` · ${execution.error}` : "";
	return execution.activity ? ` · ${execution.activity}` : "";
}

function renderTask(selection: Extract<ActivitySelection, { kind: "task" }>, snapshot: ActivitySnapshot, selected: boolean, theme: Theme, width: number, frame: number): string {
	const depth = Math.max(0, taskDepth(selection.task, snapshot.workflow?.tasks ?? []));
	const count = selection.task.total > 0 ? `${selection.task.completed}/${selection.task.total}` : "";
	const stats = compactStats(selection.task.durationMs, selection.task.usage?.totalTokens);
	const right = [count, stats].filter(Boolean).join(" · ");
	const left = `${selectionMarker(selected, theme)} ${"  ".repeat(depth)}${badge(selection.task.state, theme, frame)} ${theme.bold(selection.task.label)}`;
	return rightAlign(left, right ? theme.fg("dim", right) : "", width);
}

function compactStats(durationMs: number | undefined, totalTokens: number | undefined): string {
	return [
		durationMs !== undefined ? formatDuration(durationMs) : undefined,
		totalTokens !== undefined ? `${formatTokens(totalTokens)} tok` : undefined,
	].filter(Boolean).join(" · ");
}

function renderWorkUnit(selection: Extract<ActivitySelection, { kind: "work-unit" }>, selected: boolean, theme: Theme, width: number, frame: number): string {
	const execution = selection.workUnit.executions[0];
	const activity = execution
		? executionSuffix(execution)
		: selection.workUnit.reason ? ` · ${selection.workUnit.reason}` : "";
	const attempts = selection.workUnit.attempts > 1 ? ` · ×${selection.workUnit.attempts}` : "";
	const stats = compactStats(selection.workUnit.durationMs, selection.workUnit.usage?.totalTokens);
	return rightAlign(`${selectionMarker(selected, theme)}   ${badge(selection.workUnit.state, theme, frame)} ${selection.workUnit.label}${attempts}${activity}`, theme.fg("dim", stats), width);
}

function renderExecution(selection: Extract<ActivitySelection, { kind: "execution" }>, selected: boolean, theme: Theme, width: number, frame: number, now: number, language: ActivitySnapshot["language"]): string {
	const execution = selection.execution;
	const path = execution.taskPath ? `  ${execution.taskPath}` : execution.fleetItem?.description ? `  ${execution.fleetItem.description.replace(/\s+/g, " ").trim()}` : "";
	const attempt = execution.attempt > 0 ? ` · A${execution.attempt}` : "";
	const left = `${selectionMarker(selected, theme)} ${badge(execution.state, theme, frame)} ${theme.bold(execution.agent)}${attempt}${path}${executionSuffix(execution)}`;
	const liveDuration = execution.state === "running" ? now - execution.startedAt : undefined;
	const stats = compactStats(execution.durationMs ?? liveDuration, execution.usage?.totalTokens);
	const fallback = execution.state === "pending" || execution.state === "ready" || execution.state === "waiting"
		? localize(language, "Not started", "未开始")
		: execution.durationMs === undefined ? localize(language, "Duration unavailable", "时长不可用") : formatClockDuration(now - execution.startedAt);
	return rightAlign(left, theme.fg("dim", stats || fallback), width);
}

function expandedRows(selection: ActivitySelection, theme: Theme, width: number, frame: number): string[] {
	const execution = selection.kind === "execution" ? selection.execution : selection.kind === "work-unit" ? selection.workUnit.executions[0] : undefined;
	if (!execution || TERMINAL.has(execution.state)) return [];
	return execution.recent.slice(0, 3).map((event) => bounded(`    ${badge(event.state, theme, frame)} ${theme.fg("dim", event.text)}`, width));
}

/**
 * One-line collapsed summary shown while the dock is inactive.
 *
 * The dock defaults to a single aggregate line so it never eats vertical space; the
 * full task tree only appears once the user expands it. Counts come from the shared
 * snapshot so the collapsed and expanded surfaces never disagree. Wording follows
 * snapshot.language (zh/en).
 *
 * When a workflow is bound, counts are derived from the same TaskActivity tree that
 * the inline workflow card and the expanded task view use (state / completed / total),
 * so the collapsed summary, the expanded tree, and the card all report the same
 * task-level progress. When no workflow is bound, counts fall back to independent
 * agent executions (the only surface available).
 */
function dockSummaryLine(snapshot: ActivitySnapshot, theme: Theme, width: number, frame: number): string {
	const states = snapshot.workflow
		? snapshot.workflow.tasks.map((task) => task.state)
		: snapshot.executions.map((execution) => execution.state);
	const counts = summarizeActivityStates(states);
	const { running, done, failed } = counts;
	const lead = activityLeadState(counts);
	const zh = snapshot.language === "zh";
	const parts = [
		snapshot.workflow ? (zh ? "工作流" : "Workflow") : undefined,
		`${running} ${zh ? "运行" : "running"}`,
		`${done} ${zh ? "完成" : "done"}`,
		failed > 0 ? `${failed} ${zh ? "失败" : "failed"}` : undefined,
	].filter((part): part is string => Boolean(part));
	const left = `${badge(lead, theme, frame)} ${parts.join(" · ")}`;
	const hint = zh ? "↓/Tab 展开" : "↓/Tab expand";
	return rightAlign(left, theme.fg("dim", hint), width);
}

export function renderActivityDock(snapshot: ActivitySnapshot, width: number, theme: Theme, state: ActivityDockState = {}): string[] {
	const perspective = state.perspective ?? (snapshot.workflow ? "work" : "agents");
	const rows = activitySelections(snapshot, perspective);
	if (rows.length === 0) return [];
	if (!state.active) return [dockSummaryLine(snapshot, theme, width, state.spinnerFrame ?? 0)];
	const tasksLabel = snapshot.language === "zh" ? "任务" : "Tasks";
	const header = perspective === "work"
		? `${theme.bold(`[${tasksLabel}]`)}  Agents`
		: `${tasksLabel}  ${theme.bold("[Agents]")}`;
	const hint = state.active ? localize(snapshot.language, "v view · ↑↓/jk · x · Enter · Esc", "v 视图 · ↑↓/jk · x · 回车 · Esc") : localize(snapshot.language, "↓ activity", "↓ 活动");
	const lines = [rightAlign(header, theme.fg("dim", hint), width)];
	const selectedIndex = Math.max(0, rows.findIndex((row) => row.key === state.selectedKey));
	const rowCount = width >= 110 ? 6 : 4;
	const start = Math.max(0, Math.min(selectedIndex, Math.max(0, rows.length - rowCount)));
	const visible = rows.slice(start, start + rowCount);
	const now = snapshot.updatedAt;
	const frame = state.spinnerFrame ?? 0;
	for (const row of visible) {
		const selected = Boolean(state.active && row.key === rows[selectedIndex]?.key);
		if (row.kind === "task") lines.push(renderTask(row, snapshot, selected, theme, width, frame));
		else if (row.kind === "work-unit") lines.push(renderWorkUnit(row, selected, theme, width, frame));
		else lines.push(renderExecution(row, selected, theme, width, frame, now, snapshot.language));
		if (selected && state.expandedKey === row.key) lines.push(...expandedRows(row, theme, width, frame));
	}
	if (rows.length > visible.length) lines.push(rightAlign("", theme.fg("dim", `… +${rows.length - visible.length}`), width));
	return lines;
}

export class ActivityDockComponent implements Component {
	private readonly getSnapshot: () => ActivitySnapshot | undefined;
	private readonly getState: () => ActivityDockState;
	private readonly theme: Theme;

	constructor(
		getSnapshot: () => ActivitySnapshot | undefined,
		getState: () => ActivityDockState,
		theme: Theme,
	) {
		this.getSnapshot = getSnapshot;
		this.getState = getState;
		this.theme = theme;
	}

	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		return snapshot ? renderActivityDock(snapshot, width, this.theme, this.getState()) : [];
	}

	invalidate(): void {}
}

export interface ActivityDockControllerOptions {
	getSnapshot(): ActivitySnapshot;
	openSelection(selection: ActivitySelection, perspective: ActivityPerspective): Promise<void> | void;
	refreshMs?: number;
}

export interface ActivityDockController {
	setContext(ctx: ExtensionContext): void;
	/** Last coherent snapshot used by the dock. Lazily initializes when possible. */
	getSnapshot(): ActivitySnapshot | undefined;
	refresh(): void;
	dispose(): void;
}

export function createActivityDockController(options: ActivityDockControllerOptions): ActivityDockController {
	let ctx: ExtensionContext | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let tui: { focusedComponent?: unknown; requestRender(): void } | undefined;
	let unsubscribe: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let animation: ReturnType<typeof setInterval> | undefined;
	let registered = false;
	let snapshot: ActivitySnapshot | undefined;
	let active = false;
	let perspective: ActivityPerspective | undefined;
	let selectedKey: string | undefined;
	let expandedKey: string | undefined;
	let spinnerFrame = 0;
	let inspectorOpen = false;

	const selections = () => snapshot ? activitySelections(snapshot, perspective ?? (snapshot.workflow ? "work" : "agents")) : [];
	const editorHasFocus = (): boolean => {
		const focused = tui?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Partial<EditorComponent>;
		return typeof candidate.render === "function" && typeof candidate.invalidate === "function" && typeof candidate.handleInput === "function" && typeof candidate.getText === "function" && typeof candidate.setText === "function";
	};
	const requestRender = () => tui?.requestRender();
	const clampSelection = () => {
		const rows = selections();
		if (!rows.some((row) => row.key === selectedKey)) selectedKey = rows[0]?.key;
		if (!rows.some((row) => row.key === expandedKey)) expandedKey = undefined;
	};
	const renderState = (): ActivityDockState => ({ active, perspective, selectedKey, expandedKey, spinnerFrame });
	const hide = () => {
		if (!registered || !ui) return;
		ui.setWidget(ACTIVITY_DOCK_WIDGET_KEY, undefined);
		registered = false;
		tui = undefined;
	};
	const handleKey = (data: string): { consume?: boolean } | undefined => {
		if (!ctx || !snapshot || inspectorOpen || isKeyRelease(data) || !editorHasFocus()) return undefined;
		if (!active) {
			const wantsExpand = matchesKey(data, "down") || matchesKey(data, "tab");
			if (!wantsExpand || ctx.ui.getEditorText() !== "") return undefined;
			active = true;
			clampSelection();
			requestRender();
			return { consume: true };
		}
		const rows = selections();
		const index = Math.max(0, rows.findIndex((row) => row.key === selectedKey));
		if (data === "v") {
			perspective = (perspective ?? (snapshot.workflow ? "work" : "agents")) === "work" ? "agents" : "work";
			selectedKey = undefined;
			expandedKey = undefined;
			clampSelection();
			requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			selectedKey = rows[Math.min(rows.length - 1, index + 1)]?.key;
			requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (index === 0) active = false;
			else selectedKey = rows[index - 1]?.key;
			requestRender();
			return { consume: true };
		}
		if (data === "x") {
			const selected = rows[index];
			const state = selected?.kind === "execution" ? selected.execution.state : selected?.kind === "work-unit" ? selected.workUnit.state : selected?.task.state;
			if (selected && state && !TERMINAL.has(state)) expandedKey = expandedKey === selected.key ? undefined : selected.key;
			requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			const selected = rows[index];
			if (!selected) return { consume: true };
			const selectedPerspective = perspective ?? (snapshot.workflow ? "work" : "agents");
			inspectorOpen = true;
			hide();
			void Promise.resolve(options.openSelection(selected, selectedPerspective)).catch((error) => ctx?.ui.notify(error instanceof Error ? error.message : String(error), "error")).finally(() => {
				inspectorOpen = false;
				controller.refresh();
			});
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			active = false;
			expandedKey = undefined;
			requestRender();
			return { consume: true };
		}
		active = false;
		return undefined;
	};

	const controller: ActivityDockController = {
		setContext(next) {
			if (!next.hasUI) return;
			if (ui !== next.ui) {
				unsubscribe?.();
				hide();
				ui = next.ui;
				unsubscribe = ui.onTerminalInput?.(handleKey);
			}
			ctx = next;
			if (!timer) {
				timer = setInterval(() => controller.refresh(), options.refreshMs ?? 500);
				timer.unref?.();
			}
			if (!animation) {
				animation = setInterval(() => { spinnerFrame++; requestRender(); }, 160);
				animation.unref?.();
			}
			controller.refresh();
		},
		getSnapshot() {
			if (snapshot) return snapshot;
			try {
				snapshot = options.getSnapshot();
				return snapshot;
			} catch {
				return undefined;
			}
		},
		refresh() {
			if (!ctx || !ui) return;
			try {
				snapshot = options.getSnapshot();
				if (!perspective) perspective = snapshot.workflow ? "work" : "agents";
				clampSelection();
				if (inspectorOpen || selections().length === 0) { hide(); return; }
				if (!registered) {
					ui.setWidget(ACTIVITY_DOCK_WIDGET_KEY, (nextTui, theme) => {
						tui = nextTui;
						return new ActivityDockComponent(() => snapshot, renderState, theme);
					}, { placement: "belowEditor" });
					registered = true;
				} else requestRender();
			} catch {
				// Keep the last coherent snapshot mounted through transient store or session races.
				requestRender();
			}
		},
		dispose() {
			if (timer) clearInterval(timer);
			if (animation) clearInterval(animation);
			timer = undefined;
			animation = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
			hide();
			ctx = undefined;
			ui = undefined;
		},
	};
	return controller;
}
