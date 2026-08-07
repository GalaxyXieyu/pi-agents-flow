import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hyperlink, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { discoverAgents, resolveAgentName, type AgentConfig } from "../agents/agents.ts";
import type { ActivityArtifact, ActivityPerspective, ActivitySelection, ActivitySnapshot, ActivityState, ActivityUsage, AgentExecutionActivity, TaskActivity, WorkUnitActivity } from "../activity/types.ts";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import type { SubagentState } from "../shared/types.ts";
import { activitySelections } from "./activity-dock.ts";
import { FleetAvatarRenderer } from "./fleet-avatar.ts";
import { fleetIdentity, type FleetIdentity } from "./fleet-identity.ts";
import { fleetItemIdentityKey, openSubagentFleet } from "./fleet.ts";
import { selectionMarker, statusBadge } from "./visual-language.ts";

type Theme = ExtensionContext["ui"]["theme"];
type BoardTui = { terminal?: { rows: number; columns?: number }; requestRender(): void };

export interface ActivityBoardOptions {
	initialPerspective?: ActivityPerspective;
	initialKey?: string;
	openInspector?: (initialKey: string, language: ActivitySnapshot["language"]) => Promise<void> | void;
}

const PLAIN_THEME = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text.replace(/[\r\n]+/g, " "), Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

function frame(theme: Theme, text: string): string {
	return theme.fg("borderAccent", text);
}

function divider(theme: Theme, text: string): string {
	return theme.fg("borderMuted", text);
}

function sectionRule(label: string, width: number, theme: Theme): string {
	const safe = truncateToWidth(label.toUpperCase(), Math.max(1, width - 4));
	const used = visibleWidth(`─ ${safe} `);
	return fit(`${divider(theme, "─ ")}${theme.fg("muted", safe)}${divider(theme, ` ${"─".repeat(Math.max(0, width - used))}`)}`, width);
}

function taskPath(execution: AgentExecutionActivity, language: ActivitySnapshot["language"]): string {
	return execution.taskPath ?? execution.fleetItem?.description?.replace(/\s+/g, " ").trim() ?? localize(language, "Independent execution", "独立执行");
}

function executionIdentityKey(execution: AgentExecutionActivity): string {
	return execution.fleetItem ? fleetItemIdentityKey(execution.fleetItem) : `${execution.key}:${execution.attempt}`;
}

function allAgentSelections(snapshot: ActivitySnapshot): Extract<ActivitySelection, { kind: "execution" }>[] {
	return activitySelections(snapshot, "agents").filter((selection): selection is Extract<ActivitySelection, { kind: "execution" }> => selection.kind === "execution");
}

function isFailedExecution(execution: AgentExecutionActivity): boolean {
	return execution.state === "failed" || execution.state === "cancelled" || execution.state === "superseded";
}

function usageSummary(usage: ActivityUsage | undefined, language: ActivitySnapshot["language"]): string {
	if (!usage) return localize(language, "Tokens unavailable", "Token 不可用");
	const parts = [
		usage.totalTokens !== undefined ? `${formatTokens(usage.totalTokens)} tok` : undefined,
		usage.inputTokens !== undefined ? `in ${formatTokens(usage.inputTokens)}` : undefined,
		usage.outputTokens !== undefined ? `out ${formatTokens(usage.outputTokens)}` : undefined,
		usage.cacheReadTokens !== undefined ? `cache read ${formatTokens(usage.cacheReadTokens)}` : undefined,
		usage.cacheWriteTokens !== undefined ? `cache write ${formatTokens(usage.cacheWriteTokens)}` : undefined,
		usage.toolCalls !== undefined ? `${usage.toolCalls} ${usage.toolCalls === 1 ? localize(language, "tool", "工具") : localize(language, "tools", "工具")}` : undefined,
		usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : undefined,
	].filter((value): value is string => Boolean(value));
	return parts.length ? parts.join(" · ") : localize(language, "Tokens unavailable", "Token 不可用");
}

function durationSummary(durationMs: number | undefined, language: ActivitySnapshot["language"] = "en"): string {
	return durationMs !== undefined ? formatDuration(durationMs) : localize(language, "Duration unavailable", "时长不可用");
}

function localize(language: ActivitySnapshot["language"], en: string, zh: string): string {
	return language === "zh" ? zh : en;
}

function isPendingState(state: ActivityState): boolean {
	return state === "pending" || state === "ready" || state === "waiting";
}

function aggregateExecutionStats(executions: AgentExecutionActivity[]): { durationMs?: number; totalTokens?: number } {
	const durations = executions.map((execution) => execution.durationMs).filter((value): value is number => value !== undefined);
	const tokens = executions.map((execution) => execution.usage?.totalTokens).filter((value): value is number => value !== undefined);
	return {
		...(durations.length ? { durationMs: durations.reduce((sum, value) => sum + value, 0) } : {}),
		...(tokens.length ? { totalTokens: tokens.reduce((sum, value) => sum + value, 0) } : {}),
	};
}

function snapshotExecutionStats(snapshot: ActivitySnapshot): { durationMs?: number; totalTokens?: number } {
	const workflowDuration = snapshot.workflow?.tasks.map((task) => task.durationMs).filter((value): value is number => value !== undefined).reduce((sum, value) => sum + value, 0);
	const workflowTokens = snapshot.workflow?.tasks.map((task) => task.usage?.totalTokens).filter((value): value is number => value !== undefined).reduce((sum, value) => sum + value, 0);
	const independent = aggregateExecutionStats(snapshot.independent);
	const durationMs = (workflowDuration ?? 0) + (independent.durationMs ?? 0);
	const totalTokens = (workflowTokens ?? 0) + (independent.totalTokens ?? 0);
	return {
		...(workflowDuration !== undefined || independent.durationMs !== undefined ? { durationMs } : {}),
		...(workflowTokens !== undefined || independent.totalTokens !== undefined ? { totalTokens } : {}),
	};
}

function compactRuntimeUsage(durationMs: number | undefined, totalTokens: number | undefined): string {
	return [
		durationMs !== undefined ? `${formatDuration(durationMs)} runtime` : undefined,
		totalTokens !== undefined ? `${formatTokens(totalTokens)} tok` : undefined,
	].filter((value): value is string => Boolean(value)).join(" · ");
}

function sanitizeArtifactText(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function artifactLocation(rawPath: string): { path: string; suffix: string; line?: number; column?: number } {
	const safePath = sanitizeArtifactText(rawPath);
	const match = /^(.*?)(?::(\d+)(?::(\d+))?)$/.exec(safePath);
	if (!match) return { path: safePath, suffix: "" };
	const line = Number(match[2]);
	const column = match[3] === undefined ? undefined : Number(match[3]);
	return { path: match[1]!, suffix: `:${match[2]}${match[3] ? `:${match[3]}` : ""}`, line, ...(column !== undefined ? { column } : {}) };
}

function artifactLink(artifact: ActivityArtifact): string {
	const location = artifactLocation(artifact.path);
	const absolutePath = resolve(artifact.cwd ?? process.cwd(), location.path);
	const fragment = location.line === undefined ? "" : `#L${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
	return hyperlink(`${sanitizeArtifactText(artifact.label)} ${shortenPath(location.path)}${location.suffix}`, `${pathToFileURL(absolutePath).href}${fragment}`);
}

function artifactLines(artifacts: ActivityArtifact[], theme: Theme, language: ActivitySnapshot["language"]): string[] {
	if (!artifacts.length) return [theme.fg("dim", `${localize(language, "Evidence files", "证据文件")}  ${localize(language, "none", "无")}`)];
	const evidence = artifacts.filter((item) => item.kind === "evidence");
	const run = artifacts.filter((item) => item.kind === "run");
	const lines = [theme.fg("dim", localize(language, "Evidence files", "证据文件"))];
	if (evidence.length) lines.push(...evidence.slice(0, 6).map(artifactLink));
	if (run.length) {
		lines.push(theme.fg("dim", localize(language, "Run files", "运行文件")), ...run.slice(0, 6).map(artifactLink));
	}
	const shown = Math.min(6, evidence.length) + Math.min(6, run.length);
	if (artifacts.length > shown) {
		const more = artifacts.length - shown;
		lines.push(theme.fg("dim", `… ${more} ${more === 1 ? localize(language, "more file", "更多文件") : localize(language, "more files", "更多文件")}`));
	}
	return lines;
}

function activityLines(execution: AgentExecutionActivity, language: ActivitySnapshot["language"]): string[] {
	return [
		...(execution.activity ? [`${execution.activity}`] : [localize(language, "No live tool activity", "无实时工具活动")]),
		"",
		localize(language, "Recent activity", "最近活动"),
		...(execution.recent.length ? execution.recent.map((event) => `${statusBadge(event.state, PLAIN_THEME)} ${event.text}`) : [localize(language, "(none)", "（无）")]),
		...(execution.error ? ["", `${localize(language, "Error", "错误")}  ${execution.error}`] : []),
	];
}

function definitionLines(execution: AgentExecutionActivity, agent: AgentConfig | undefined, language: ActivitySnapshot["language"]): string[] {
	const systemPrompt = agent?.systemPrompt?.trim();
	return [
		localize(language, "Agent Definition", "代理定义"),
		`${localize(language, "Agent", "代理")}  ${agent?.name ?? execution.agent}`,
		...(agent?.description ? [`${localize(language, "Description", "描述")}  ${agent.description}`] : []),
		...(agent?.source ? [`${localize(language, "Source", "来源")}  ${agent.source}`] : []),
		...(agent?.filePath ? [`${localize(language, "File", "文件")}  ${agent.filePath}`] : []),
		`${localize(language, "Context", "上下文")}  ${execution.context ?? agent?.defaultContext ?? "configured at launch"}`,
		`${localize(language, "Skills", "技能")}  ${agent?.skills?.join(", ") || execution.skills?.join(", ") || localize(language, "none", "无")}`,
		`${localize(language, "Tools", "工具")}  ${agent?.tools?.join(", ") || "default"}`,
		`${localize(language, "MCP", "MCP")}  ${agent?.mcpDirectTools?.join(", ") || execution.extraTools?.filter((tool) => tool.includes("/")).join(", ") || localize(language, "none", "无")}`,
		...(execution.extraTools?.length ? [`${localize(language, "Extra tools", "额外工具")}  ${execution.extraTools.join(", ")}`] : []),
		...(execution.denyTools?.length ? [`${localize(language, "Denied tools", "禁用工具")}  ${execution.denyTools.join(", ")}`] : []),
		"",
		localize(language, "System prompt", "系统提示"),
		...(systemPrompt ? systemPrompt.split(/\r?\n/) : [localize(language, "(base Agent prompt unavailable)", "（基础代理提示不可用）")]),
	];
}

function employeeCard(execution: AgentExecutionActivity, identity: FleetIdentity, agent: AgentConfig | undefined, width: number, theme: Theme, avatarRenderer: FleetAvatarRenderer, language: ActivitySnapshot["language"]): string[] {
	const avatar = avatarRenderer.render(identity);
	const avatarWidth = avatar.lines.length ? avatar.width + 3 : 0;
	const contentWidth = Math.max(1, width - avatarWidth);
	const status = `${statusBadge(execution.state, theme)} ${execution.state}`;
	const facts = [
		rightAligned(theme.bold(theme.fg(identity.tone, identity.name)), status, contentWidth),
		`${theme.fg("dim", `${localize(language, "Role", "角色")}    `)}${theme.fg("accent", execution.role ?? execution.agent)}`,
		`${theme.fg("dim", `${localize(language, "Agent", "代理")}   `)}${theme.fg("muted", execution.agent)}`,
		`${theme.fg("dim", `${localize(language, "Context", "上下文")} `)}${theme.fg("muted", execution.context ?? agent?.defaultContext ?? "configured at launch")}`,
		`${theme.fg("dim", `${localize(language, "Skills", "技能")}  `)}${theme.fg("text", agent?.skills?.join(", ") || execution.skills?.join(", ") || localize(language, "none", "无"))}`,
		`${theme.fg("dim", `${localize(language, "Task", "任务")}    `)}${theme.fg("text", taskPath(execution, language))}`,
		`${theme.fg("dim", `${localize(language, "Attempt", "尝试")} `)}${theme.fg("muted", String(execution.attempt || 0))}`,
		`${theme.fg("dim", `${localize(language, "Duration", "时长")}`)}${theme.fg("muted", ` ${durationSummary(execution.durationMs, language)}`)}`,
		`${theme.fg("dim", `${localize(language, "Usage", "用量")}   `)}${theme.fg("muted", usageSummary(execution.usage, language))}`,
	];
	if (!avatar.lines.length) return facts.map((line) => truncateToWidth(line, width));
	return Array.from({ length: Math.max(avatar.lines.length, facts.length) }, (_, index) => {
		const image = avatar.lines[index] ?? "";
		return truncateToWidth(`${image}${" ".repeat(Math.max(1, avatarWidth - visibleWidth(image)))}${facts[index] ?? ""}`, width);
	});
}

function taskDepth(task: TaskActivity, tasks: TaskActivity[], depth = 0): number {
	for (const root of tasks) {
		if (root.id === task.id) return depth;
		const nested = taskDepth(task, root.children, depth + 1);
		if (nested >= 0) return nested;
	}
	return -1;
}

function taskRows(tasks: TaskActivity[], collapsed: Set<string>, rows: ActivitySelection[]): void {
	for (const task of tasks) {
		rows.push({ kind: "task", key: `task:${task.id}`, task });
		if (collapsed.has(task.id)) continue;
		for (const workUnit of task.workUnits) rows.push({ kind: "work-unit", key: `work-unit:${workUnit.id}`, task, workUnit });
		taskRows(task.children, collapsed, rows);
	}
}

function selectionExecution(selection: ActivitySelection | undefined): AgentExecutionActivity | undefined {
	if (selection?.kind === "execution") return selection.execution;
	if (selection?.kind === "work-unit") return selection.workUnit.executions.at(-1);
	return undefined;
}

function taskWorkUnits(task: TaskActivity): WorkUnitActivity[] {
	return [...task.workUnits, ...task.children.flatMap(taskWorkUnits)];
}

function allTaskWorkUnits(tasks: TaskActivity[]): WorkUnitActivity[] {
	return tasks.flatMap(taskWorkUnits);
}

function dependencyLabels(selection: Extract<ActivitySelection, { kind: "work-unit" }>, snapshot: ActivitySnapshot): string[] {
	const byId = new Map(allTaskWorkUnits(snapshot.workflow?.tasks ?? []).map((unit) => [unit.id, unit.label]));
	return selection.workUnit.dependsOn.map((id) => byId.get(id) ?? id);
}

function taskAgentActivity(task: TaskActivity): Array<{ unit: WorkUnitActivity; execution: AgentExecutionActivity }> {
	return taskWorkUnits(task).flatMap((unit) => {
		const execution = unit.executions.at(-1);
		return execution ? [{ unit, execution }] : [];
	});
}

function planDetailLines(selection: ActivitySelection | undefined, snapshot: ActivitySnapshot, theme: Theme): string[] {
	if (!snapshot.workflow) {
		return [
			theme.bold(localize(snapshot.language, "No task plan", "无任务计划")),
			"",
			localize(snapshot.language, "This session has Agent executions but no Workflow plan.", "此会话有代理执行，但无工作流计划。"),
			localize(snapshot.language, "Press v to inspect them in Agents.", "按 v 在代理视图中查看。"),
		];
	}
	if (!selection) return [theme.bold(localize(snapshot.language, "No plan item selected", "未选择计划项"))];
	if (selection.kind === "task") {
		return [
			theme.bold(selection.task.label),
			`${localize(snapshot.language, "Status", "状态")}      ${selection.task.state}`,
			`${localize(snapshot.language, "Progress", "进度")}    ${selection.task.completed}/${selection.task.total}`,
			`${localize(snapshot.language, "Task ID", "任务 ID")}     ${selection.task.id}`,
			...(selection.task.parentId ? [`${localize(snapshot.language, "Parent", "父任务")}      ${selection.task.parentId}`] : []),
			`${localize(snapshot.language, "Subtasks", "子任务")}    ${selection.task.children.length}`,
			`${localize(snapshot.language, "Work units", "工件单元")}  ${selection.task.workUnits.length}`,
			`${localize(snapshot.language, "Duration", "时长")}    ${durationSummary(selection.task.durationMs, snapshot.language)}`,
			`${localize(snapshot.language, "Usage", "用量")}       ${usageSummary(selection.task.usage, snapshot.language)}`,
			...artifactLines(selection.task.artifacts, theme, snapshot.language),
		];
	}
	if (selection.kind === "work-unit") {
		const dependencies = dependencyLabels(selection, snapshot);
		return [
			theme.bold(selection.workUnit.label),
			`${localize(snapshot.language, "Task", "任务")}        ${selection.task.label}`,
			`${localize(snapshot.language, "Status", "状态")}      ${selection.workUnit.state}`,
			...(selection.workUnit.reason ? [`${localize(snapshot.language, "Reason", "原因")}      ${selection.workUnit.reason}`] : []),
			`${localize(snapshot.language, "Kind", "类型")}        ${selection.workUnit.node.kind}`,
			`${localize(snapshot.language, "Objective", "目标")}   ${selection.workUnit.node.agentSpec.objective}`,
			`${localize(snapshot.language, "Depends on", "依赖")}  ${dependencies.length ? dependencies.join(", ") : localize(snapshot.language, "none", "无")}`,
			`${localize(snapshot.language, "Attempts", "尝试")}    ${selection.workUnit.attempts}`,
			`${localize(snapshot.language, "Duration", "时长")}    ${durationSummary(selection.workUnit.durationMs, snapshot.language)}`,
			`${localize(snapshot.language, "Usage", "用量")}       ${usageSummary(selection.workUnit.usage, snapshot.language)}`,
			...artifactLines(selection.workUnit.artifacts, theme, snapshot.language),
		];
	}
	return [theme.bold(selection.execution.agent), localize(snapshot.language, "Independent execution", "独立执行"), localize(snapshot.language, "Press v to inspect independent executions in Agents.", "按 v 在代理视图中查看独立执行。")];
}

function selectedAgentActivityLines(selection: ActivitySelection | undefined, snapshot: ActivitySnapshot, theme: Theme): string[] {
	if (!selection) return [localize(snapshot.language, "No Agent activity", "无代理活动")];
	if (selection.kind === "task") {
		const activity = taskAgentActivity(selection.task);
		if (!activity.length) return [localize(snapshot.language, "No Agent has started for this task.", "此任务尚无代理开始。")];
		return activity.flatMap(({ unit, execution }) => [
			`${statusBadge(execution.state, theme)} ${theme.bold(execution.agent)} · ${unit.label}`,
			`  ${execution.activity ?? (execution.state === "completed" || execution.state === "accepted" ? localize(snapshot.language, "Completed", "已完成") : localize(snapshot.language, "No live tool activity", "无实时工具活动"))}`,
		]);
	}
	const execution = selectionExecution(selection);
	if (!execution) {
		const waiting = selection.kind === "work-unit" && selection.workUnit.dependsOn.length
			? localize(snapshot.language, `Waiting for ${selection.workUnit.dependsOn.length} dependenc${selection.workUnit.dependsOn.length === 1 ? "y" : "ies"}.`, `等待 ${selection.workUnit.dependsOn.length} 个依赖。`)
			: localize(snapshot.language, "Not started.", "未开始。");
		return [waiting];
	}
	return [
		`${statusBadge(execution.state, theme)} ${theme.bold(execution.agent)} · ${execution.role ?? localize(snapshot.language, "Agent", "代理")}`,
		`${localize(snapshot.language, "Status", "状态")}    ${execution.state}`,
		`${localize(snapshot.language, "Attempt", "尝试")}   ${execution.attempt}`,
		`${localize(snapshot.language, "Duration", "时长")}  ${durationSummary(execution.durationMs, snapshot.language)}`,
		`${localize(snapshot.language, "Usage", "用量")}     ${usageSummary(execution.usage, snapshot.language)}`,
		`${localize(snapshot.language, "Current", "当前")}   ${execution.activity ?? localize(snapshot.language, "No live tool activity", "无实时工具活动")}`,
		...(execution.recent.length ? ["", localize(snapshot.language, "Recent", "最近"), ...execution.recent.map((event) => `  ${statusBadge(event.state, theme)} ${event.text}`)] : []),
		...(execution.error ? ["", `${localize(snapshot.language, "Error", "错误")}     ${execution.error}`] : []),
	];
}

export class ActivityBoardComponent implements Component {
	private perspective: ActivityPerspective;
	private selectedKey: string | undefined;
	private focus: "roster" | "detail" = "roster";
	private detailMode: "live" | "agent" = "live";
	private showFailedAgents = false;
	private hiddenFailedSelectionKey: string | undefined;
	private readonly collapsedTasks = new Set<string>();
	private readonly avatarRenderer: FleetAvatarRenderer;
	private readonly agentCache = new Map<string, AgentConfig | undefined>();
	private readonly tui: BoardTui;
	private readonly theme: Theme;
	private readonly state: SubagentState;
	private readonly getSnapshot: () => ActivitySnapshot;
	private readonly done: () => void;
	private readonly ctx: ExtensionContext;
	private readonly openInspector: (initialKey: string, language: ActivitySnapshot["language"]) => Promise<void> | void;

	constructor(tui: BoardTui, theme: Theme, ctx: ExtensionContext, state: SubagentState, getSnapshot: () => ActivitySnapshot, done: () => void, options: ActivityBoardOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.state = state;
		this.getSnapshot = getSnapshot;
		this.done = done;
		this.perspective = options.initialPerspective ?? (getSnapshot().workflow ? "work" : "agents");
		this.selectedKey = options.initialKey;
		if (options.initialKey) {
			const initial = allAgentSelections(getSnapshot()).find((selection) => selection.key === options.initialKey);
			this.showFailedAgents = Boolean(initial && isFailedExecution(initial.execution));
		}
		this.openInspector = options.openInspector ?? ((initialKey, language) => openSubagentFleet(this.ctx, this.state, { initialKey, language }));
		this.avatarRenderer = new FleetAvatarRenderer(theme);
		this.clampSelection();
	}

	private selections(snapshot = this.getSnapshot()): ActivitySelection[] {
		if (this.perspective === "agents") {
			const agents = allAgentSelections(snapshot);
			return this.showFailedAgents ? agents : agents.filter((selection) => !isFailedExecution(selection.execution));
		}
		const rows: ActivitySelection[] = [];
		taskRows(snapshot.workflow?.tasks ?? [], this.collapsedTasks, rows);
		return rows;
	}

	private clampSelection(rows = this.selections()): void {
		if (!rows.some((row) => row.key === this.selectedKey)) this.selectedKey = rows[0]?.key;
	}

	private selected(rows = this.selections()): ActivitySelection | undefined {
		this.clampSelection(rows);
		return rows.find((row) => row.key === this.selectedKey);
	}

	private moveSelection(delta: number): void {
		const rows = this.selections();
		if (rows.length === 0) return;
		const current = Math.max(0, rows.findIndex((row) => row.key === this.selectedKey));
		this.selectedKey = rows[Math.max(0, Math.min(rows.length - 1, current + delta))]?.key;
	}

	private switchPerspective(): void {
		this.perspective = this.perspective === "agents" ? "work" : "agents";
		this.selectedKey = undefined;
		this.focus = "roster";
		this.clampSelection();
		this.tui.requestRender();
	}

	private inspect(execution: AgentExecutionActivity | undefined): void {
		const initialKey = execution?.inspectKey;
		if (!initialKey) return;
		void Promise.resolve(this.openInspector(initialKey, this.getSnapshot().language)).catch((error) => {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		});
	}

	private resolveAgent(execution: AgentExecutionActivity): AgentConfig | undefined {
		const key = `${this.state.baseCwd}\0${execution.agent}`;
		if (!this.agentCache.has(key)) {
			try { this.agentCache.set(key, resolveAgentName(execution.agent, discoverAgents(this.state.baseCwd, "both").agents).agent); }
			catch { this.agentCache.set(key, undefined); }
		}
		return this.agentCache.get(key);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) {
			if (this.focus === "detail") { this.focus = "roster"; this.tui.requestRender(); }
			else this.done();
			return;
		}
		if (data === "q") { this.done(); return; }
		if (data === "v" && this.focus === "roster") { this.switchPerspective(); return; }
		if (this.perspective === "agents" && data === "f" && this.focus === "roster") {
			if (this.showFailedAgents) {
				const selected = allAgentSelections(this.getSnapshot()).find((selection) => selection.key === this.selectedKey);
				this.hiddenFailedSelectionKey = selected && isFailedExecution(selected.execution) ? selected.key : undefined;
				this.showFailedAgents = false;
				this.clampSelection();
			} else {
				this.showFailedAgents = true;
				const rows = this.selections();
				if (this.hiddenFailedSelectionKey && rows.some((row) => row.key === this.hiddenFailedSelectionKey)) this.selectedKey = this.hiddenFailedSelectionKey;
				this.hiddenFailedSelectionKey = undefined;
			}
			this.tui.requestRender();
			return;
		}
		if (this.perspective === "agents") {
			if (data === "v" && this.focus === "detail") { this.detailMode = this.detailMode === "live" ? "agent" : "live"; this.tui.requestRender(); return; }
			if (data === "\t") { this.focus = this.focus === "roster" ? "detail" : "roster"; this.tui.requestRender(); return; }
			if (matchesKey(data, "down") || data === "j") this.moveSelection(1);
			else if (matchesKey(data, "up") || data === "k") this.moveSelection(-1);
			else if (matchesKey(data, "return")) this.inspect(selectionExecution(this.selected()));
			else return;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") this.moveSelection(1);
		else if (matchesKey(data, "up") || data === "k") this.moveSelection(-1);
		else if (matchesKey(data, "return")) {
			const selected = this.selected();
			if (selected?.kind === "task") {
				if (this.collapsedTasks.has(selected.task.id)) this.collapsedTasks.delete(selected.task.id);
				else this.collapsedTasks.add(selected.task.id);
				this.clampSelection();
			} else this.inspect(selectionExecution(selected));
		} else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth(localize(this.getSnapshot().language, "Activity Board needs at least 36 columns. Esc closes.", "活动看板需要至少 36 列。按 Esc 关闭。"), width)];
		const terminalRows = this.tui.terminal?.rows ?? 32;
		if (terminalRows < 13) {
			const selected = this.selected();
			const label = selected?.kind === "task" ? selected.task.label : selected?.kind === "work-unit" ? selected.workUnit.label : selected?.execution.agent;
			const smallSnapshot = this.getSnapshot();
			return [
				this.theme.bold(localize(smallSnapshot.language, `Activity Board · ${this.perspective === "agents" ? "Agents" : "Tasks"}`, `活动看板 · ${this.perspective === "agents" ? "代理" : "任务"}`)),
				label ?? localize(smallSnapshot.language, "No activity", "无活动"),
				this.theme.fg("dim", localize(smallSnapshot.language, "q/Esc close", "q/Esc 关闭")),
			].slice(0, Math.max(1, terminalRows)).map((line) => truncateToWidth(line, width));
		}
		if (this.perspective === "agents") return this.renderAgents(width);
		return this.renderTasks(width);
	}

	private renderAgents(width: number): string[] {
		const snapshot = this.getSnapshot();
		const selections = this.selections(snapshot).filter((selection): selection is Extract<ActivitySelection, { kind: "execution" }> => selection.kind === "execution");
		const allAgents = allAgentSelections(snapshot);
		const failedCount = allAgents.filter((selection) => isFailedExecution(selection.execution)).length;
		const totalStats = snapshotExecutionStats(snapshot);
		const selected = this.selected(selections);
		const selectedExecution = selectionExecution(selected);
		const inner = Math.max(1, width - 2);
		const leftWidth = Math.max(20, Math.min(38, Math.floor(inner * 0.32)));
		const rightWidth = Math.max(1, inner - leftWidth - 1);
		const identity = selectedExecution ? fleetIdentity(executionIdentityKey(selectedExecution), snapshot.language) : undefined;
		const detail = selectedExecution && identity
			? (this.focus === "detail" && this.detailMode === "agent"
				? definitionLines(selectedExecution, this.resolveAgent(selectedExecution), snapshot.language)
				: employeeCard(selectedExecution, identity, this.resolveAgent(selectedExecution), rightWidth, this.theme, this.avatarRenderer, snapshot.language).concat("", ...artifactLines(selectedExecution.artifacts, this.theme, snapshot.language), "", this.theme.fg("muted", localize(snapshot.language, "LIVE ACTIVITY", "实时活动")), ...activityLines(selectedExecution, snapshot.language)))
			: [localize(snapshot.language, "No tracked agents", "无跟踪代理")];
		const availableRows = Math.max(4, Math.floor((this.tui.terminal?.rows ?? 32) * 0.72) - 5);
		const bodyRows = Math.max(6, Math.min(18, availableRows, Math.max(selections.length, detail.length)));
		const selectedIndex = Math.max(0, selections.findIndex((row) => row.key === this.selectedKey));
		const start = Math.max(0, Math.min(selectedIndex, Math.max(0, selections.length - bodyRows)));
		const roster = selections.slice(start, start + bodyRows).map((selection, offset) => {
			const execution = selection.execution;
			const profile = fleetIdentity(executionIdentityKey(execution), snapshot.language);
			const stats = isPendingState(execution.state)
				? localize(snapshot.language, "Pending", "等待中")
				: `${durationSummary(execution.durationMs)} · ${execution.usage?.totalTokens !== undefined ? `${formatTokens(execution.usage.totalTokens)} tok` : "tokens n/a"}`;
			const attempt = execution.attempt > 0 ? ` · A${execution.attempt}` : "";
			return rightAligned(`${selectionMarker(start + offset === selectedIndex, this.theme)} ${statusBadge(execution.state, this.theme)} ${profile.name} · ${execution.agent}${attempt}`, this.theme.fg("dim", stats), leftWidth);
		});
		const lines = [frame(this.theme, `╭${"─".repeat(inner)}╮`)];
		lines.push(frame(this.theme, "│") + rightAligned(` ${this.theme.bold(localize(snapshot.language, "Activity Board · Agents", "活动看板 · 代理"))}`, this.theme.fg("dim", `${compactRuntimeUsage(totalStats.durationMs, totalStats.totalTokens)} `), inner) + frame(this.theme, "│"));
		lines.push(frame(this.theme, "│") + fit(` ${this.theme.fg("dim", snapshot.workflow?.goal ?? "Standalone Agent activity")}`, inner) + frame(this.theme, "│"));
		lines.push(divider(this.theme, `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`));
		for (let index = 0; index < bodyRows; index++) lines.push(frame(this.theme, "│") + fit(roster[index] ?? "", leftWidth) + divider(this.theme, "│") + fit(detail[index] ?? "", rightWidth) + frame(this.theme, "│"));
		lines.push(divider(this.theme, `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`));
		const enterHint = selectedExecution?.inspectKey ? localize(snapshot.language, "Enter full details", "查看详情") : localize(snapshot.language, "Not started", "未开始");
		const failedHint = failedCount ? `f ${this.showFailedAgents ? localize(snapshot.language, "Hide", "隐藏") : localize(snapshot.language, "Show", "显示")} ${localize(snapshot.language, "failed", "失败")} (${failedCount})` : undefined;
		lines.push(frame(this.theme, "│") + fit(` ${this.focus === "detail" ? "Tab roster · v Live/Agent Definition" : `Tab detail · v Tasks · ${enterHint}${failedHint ? ` · ${failedHint}` : ""}`} · q/Esc close`, inner) + frame(this.theme, "│"));
		lines.push(frame(this.theme, `╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderTasks(width: number): string[] {
		const snapshot = this.getSnapshot();
		const selections = this.selections(snapshot);
		const selected = this.selected(selections);
		const inner = Math.max(1, width - 2);
		const terminalRows = this.tui.terminal?.rows ?? 32;
		const bodyRowLimit = Math.max(6, Math.min(20, Math.floor(terminalRows * 0.78) - 5));
		const taskCount = snapshot.workflow?.tasks.length ?? 0;
		const completed = snapshot.workflow?.tasks.reduce((sum, task) => sum + task.completed, 0) ?? 0;
		const total = snapshot.workflow?.tasks.reduce((sum, task) => sum + task.total, 0) ?? 0;
		const rootTasks = snapshot.workflow?.tasks ?? [];
		const planDurationMs = rootTasks.map((task) => task.durationMs).filter((value): value is number => value !== undefined).reduce((sum, value) => sum + value, 0);
		const planTotalTokens = rootTasks.map((task) => task.usage?.totalTokens).filter((value): value is number => value !== undefined).reduce((sum, value) => sum + value, 0);
		const planStats = compactRuntimeUsage(planDurationMs || undefined, planTotalTokens || undefined);
		const summary = taskCount ? `${taskCount} task${taskCount === 1 ? "" : "s"} · ${completed}/${total} complete${planStats ? ` · ${planStats}` : ""}` : localize(snapshot.language, "No task plan", "无任务计划");
		const enterHint = selected?.kind === "task"
			? "Enter collapse/expand"
			: selectionExecution(selected)?.inspectKey ? "Enter full details" : "Not started";
		const renderTree = (treeWidth: number): Array<{ key: string; line: string }> => selections.map((selection) => {
			if (selection.kind === "task") {
				const depth = taskDepth(selection.task, snapshot.workflow?.tasks ?? []);
				const disclosure = this.collapsedTasks.has(selection.task.id) ? "▸" : "▾";
				const left = `${selectionMarker(selection.key === this.selectedKey, this.theme)} ${"  ".repeat(depth)}${disclosure} ${statusBadge(selection.task.state, this.theme)} ${this.theme.bold(selection.task.label)}`;
				return { key: selection.key, line: rightAligned(left, this.theme.fg("dim", `${selection.task.completed}/${selection.task.total}`), treeWidth) };
			}
			if (selection.kind === "work-unit") {
				const stats = [
					selection.workUnit.durationMs !== undefined ? formatDuration(selection.workUnit.durationMs) : undefined,
					selection.workUnit.usage?.totalTokens !== undefined ? `${formatTokens(selection.workUnit.usage.totalTokens)} tok` : undefined,
				].filter((value): value is string => Boolean(value)).join(" · ");
				const attempts = selection.workUnit.attempts > 1 ? ` ×${selection.workUnit.attempts}` : "";
				const left = `${selectionMarker(selection.key === this.selectedKey, this.theme)}     ${statusBadge(selection.workUnit.state, this.theme)} ${selection.workUnit.label}${attempts}`;
				return { key: selection.key, line: rightAligned(left, this.theme.fg("dim", stats), treeWidth) };
			}
			return { key: selection.key, line: "" };
		});
		const detailLines = [
			sectionRule(localize(snapshot.language, "Plan details", "计划详情"), Math.max(1, inner), this.theme),
			...planDetailLines(selected, snapshot, this.theme),
			"",
			sectionRule(localize(snapshot.language, "Agent activity", "代理活动"), Math.max(1, inner), this.theme),
			...selectedAgentActivityLines(selected, snapshot, this.theme),
		];
		const lines = [frame(this.theme, `╭${"─".repeat(inner)}╮`)];
		lines.push(frame(this.theme, "│") + rightAligned(` ${this.theme.bold(localize(snapshot.language, "Activity Board · Tasks", "活动看板 · 任务"))}`, this.theme.fg("dim", `${summary} `), inner) + frame(this.theme, "│"));
		lines.push(frame(this.theme, "│") + fit(` ${this.theme.fg("dim", snapshot.workflow?.goal ?? localize(snapshot.language, "No Workflow plan is bound to this session", "此会话无绑定的工作流计划"))}`, inner) + frame(this.theme, "│"));
		if (width < 88) {
			const treeRows = Math.max(2, Math.min(6, Math.floor(bodyRowLimit * 0.38)));
			const detailRows = Math.max(3, bodyRowLimit - treeRows - 1);
			const tree = renderTree(inner - 2);
			const selectedIndex = Math.max(0, tree.findIndex((row) => row.key === selected?.key));
			const start = Math.max(0, Math.min(selectedIndex, Math.max(0, tree.length - treeRows)));
			const visibleTree = tree.slice(start, start + treeRows);
			const wrappedDetail = detailLines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, inner - 2))).slice(0, detailRows);
			lines.push(divider(this.theme, `├${"─".repeat(inner)}┤`));
			for (let index = 0; index < treeRows; index++) lines.push(frame(this.theme, "│") + fit(` ${visibleTree[index]?.line ?? (tree.length ? "" : localize(snapshot.language, "No task plan. Press v to view Agents.", "无任务计划。按 v 查看代理。"))}`, inner) + frame(this.theme, "│"));
			lines.push(divider(this.theme, `├${"─".repeat(inner)}┤`));
			for (let index = 0; index < detailRows; index++) lines.push(frame(this.theme, "│") + fit(` ${wrappedDetail[index] ?? ""}`, inner) + frame(this.theme, "│"));
		} else {
			const treeWidth = Math.max(30, Math.min(48, Math.floor(inner * 0.4)));
			const detailWidth = Math.max(1, inner - treeWidth - 1);
			const tree = renderTree(treeWidth - 1);
			const rawDetail = [
				sectionRule(localize(snapshot.language, "Plan details", "计划详情"), detailWidth, this.theme),
				...planDetailLines(selected, snapshot, this.theme),
				"",
				sectionRule(localize(snapshot.language, "Agent activity", "代理活动"), detailWidth, this.theme),
				...selectedAgentActivityLines(selected, snapshot, this.theme),
			].flatMap((line) => wrapTextWithAnsi(line, detailWidth));
			const bodyRows = Math.max(6, Math.min(bodyRowLimit, Math.max(tree.length, rawDetail.length)));
			const selectedIndex = Math.max(0, tree.findIndex((row) => row.key === selected?.key));
			const start = Math.max(0, Math.min(selectedIndex, Math.max(0, tree.length - bodyRows)));
			const visibleTree = tree.slice(start, start + bodyRows);
			const wrappedDetail = rawDetail.slice(0, bodyRows);
			lines.push(divider(this.theme, `├${"─".repeat(treeWidth)}┬${"─".repeat(detailWidth)}┤`));
			for (let index = 0; index < bodyRows; index++) {
				const treeLine = visibleTree[index]?.line ?? (index === 0 && tree.length === 0 ? "No task plan. Press v to view Agents." : "");
				lines.push(frame(this.theme, "│") + fit(` ${treeLine}`, treeWidth) + divider(this.theme, "│") + fit(wrappedDetail[index] ?? "", detailWidth) + frame(this.theme, "│"));
			}
			lines.push(divider(this.theme, `├${"─".repeat(treeWidth)}┴${"─".repeat(detailWidth)}┤`));
		}
		lines.push(frame(this.theme, "│") + fit(` v Agents · ↑↓/jk select · ${enterHint} · q/Esc close`, inner) + frame(this.theme, "│"));
		lines.push(frame(this.theme, `╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.agentCache.clear();
		this.avatarRenderer.invalidate();
		this.clampSelection();
	}
}

export async function openActivityBoard(ctx: ExtensionContext, state: SubagentState, getSnapshot: () => ActivitySnapshot, options: ActivityBoardOptions = {}): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ActivityBoardComponent(tui, theme, ctx, state, getSnapshot, done, options), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "92%", minWidth: 70, maxHeight: "78%", margin: 2 },
	});
}
