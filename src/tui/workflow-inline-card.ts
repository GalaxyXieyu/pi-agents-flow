/**
 * Compact inline card rendered beneath a `workflow` tool call after `run_ready`
 * (or any run-changing action). The card surfaces the current state of the
 * workflow at a glance — original requirement with right-aligned duration,
 * status summary, and live agent rows showing identity, activity, and duration.
 *
 * Agent execution data comes from `ActivitySnapshot.executions`, populated by
 * `buildActivitySnapshot(state, run)` — the same source as the Activity Dock.
 * This lets the card show what each subagent employee is actually doing,
 * instead of just abstract task labels.
 *
 * Status symbols and colors follow `visual-language.ts` (same as the dock).
 * Text follows `snapshot.language` for zh/en.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivitySnapshot, AgentExecutionActivity, TaskActivity, WorkUnitActivity } from "../activity/types.ts";
import { formatDuration } from "../shared/formatters.ts";
import { itemIdentity } from "./fleet.ts";
import { statusBadge, noticePrefix } from "./visual-language.ts";

export interface WorkflowInlineCardInput {
	runId: string;
	language: "zh" | "en";
	status: "active" | "completed" | "failed" | "paused" | "cancelled" | "stopped";
	snapshot?: ActivitySnapshot;
	frame?: number;
	createdAt?: number;
	updatedAt?: number;
}

interface AggregateCounts {
	running: number;
	done: number;
	failed: number;
	waiting: number;
	pending: number;
}

/**
 * Recursively collect all work units from the task tree, handling both
 * Record<TaskActivity> (live usage) and TaskActivity[] (after JSON
 * serialization through tool calls).
 */
function allWorkUnits(snapshot: ActivitySnapshot | undefined): TaskActivity['workUnits'] {
	const units: TaskActivity['workUnits'] = [];
	const tasks = snapshot?.workflow?.tasks;
	if (!tasks) return units;
	const taskList: TaskActivity[] = Array.isArray(tasks)
		? (tasks as TaskActivity[])
		: Object.values(tasks as Record<string, TaskActivity>);
	const collect = (task: TaskActivity) => {
		units.push(...(task.workUnits ?? []));
		for (const child of task.children ?? []) collect(child);
	};
	for (const task of taskList) collect(task);
	return units;
}

function aggregateTasks(snapshot: ActivitySnapshot | undefined): AggregateCounts {
	const counts: AggregateCounts = { running: 0, done: 0, failed: 0, waiting: 0, pending: 0 };
	for (const unit of allWorkUnits(snapshot)) {
		switch (unit.state) {
			case "running": counts.running++; break;
			case "completed":
			case "accepted": counts.done++; break;
			case "failed": counts.failed++; break;
			case "waiting":
			case "paused": counts.waiting++; break;
			case "superseded": break;
			default: counts.pending++; break;
		}
	}
	return counts;
}

function leadState(c: AggregateCounts): "running" | "failed" | "waiting" | "completed" | "pending" {
	if (c.running > 0) return "running";
	if (c.failed > 0) return "failed";
	if (c.waiting > 0) return "waiting";
	if (c.pending > 0) return "pending";
	return "completed";
}

function localize(zh: string, en: string, language: "zh" | "en"): string {
	return language === "zh" ? zh : en;
}

function statusColorFor(status: WorkflowInlineCardInput["status"]): "success" | "error" | "accent" | "dim" | "warning" {
	switch (status) {
		case "completed": return "success";
		case "failed":
		case "cancelled": return "error";
		case "active": return "accent";
		case "paused": return "warning";
		default: return "dim";
	}
}

function getDurationMs(createdAt?: number, updatedAt?: number, status?: string): number | undefined {
	if (!createdAt) return undefined;
	const endTime = (status === "active" || status === "paused") ? Date.now() : (updatedAt ?? Date.now());
	return Math.max(0, endTime - createdAt);
}

function withRightSuffix(left: string, suffix: string, width: number): string {
	if (!suffix) return truncateToWidth(left, width);
	const suffixWidth = visibleWidth(suffix);
	const leftWidth = Math.max(1, width - suffixWidth - 1);
	const fittedLeft = truncateToWidth(left, leftWidth);
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - suffixWidth);
	return `${fittedLeft}${" ".repeat(gap)}${suffix}`;
}

function executionDurationMs(execution: AgentExecutionActivity): number | undefined {
	if (execution.state === "running") return Math.max(0, Date.now() - execution.startedAt);
	return execution.durationMs;
}

const MAX_INLINE_CARD_LINES = 15;

export function renderWorkflowInlineCard(input: WorkflowInlineCardInput, theme: Theme, width: number, expanded = false): string[] {
	const { runId, language, status, snapshot, frame } = input;
	const counts = aggregateTasks(snapshot);
	const lead = leadState(counts);
	const zh = language === "zh";
	const lines: string[] = [];

	// — Original requirement with total workflow duration right-aligned —
	const prefix = noticePrefix(status === "failed" ? "error" : status === "active" ? "info" : "success");
	const goal = snapshot?.workflow?.goal.trim();
	const headerLabel = goal
		? `${prefix} ${zh ? "需求：" : "Requirement: "}${goal}`
		: `${prefix} ${zh ? "工作流" : "Workflow"} ${theme.bold(runId.slice(0, 8))}`;
	const durationMs = getDurationMs(input.createdAt, input.updatedAt, status);
	const durationText = durationMs !== undefined ? theme.fg("dim", formatDuration(durationMs)) : "";
	lines.push(withRightSuffix(theme.fg(statusColorFor(status), headerLabel), durationText, width));

	// — Status summary —
	const parts: string[] = [
		`${counts.running} ${zh ? "运行" : "running"}`,
		`${counts.done} ${zh ? "完成" : "done"}`,
	];
	if (counts.failed > 0) parts.push(`${counts.failed} ${zh ? "失败" : "failed"}`);
	if (counts.waiting > 0) parts.push(`${counts.waiting} ${zh ? "等待" : "waiting"}`);
	if (counts.pending > 0) parts.push(`${counts.pending} ${zh ? "待开始" : "pending"}`);
	const statusLabel = localize("状态", "Status", language);
	const leadBadge = statusBadge(lead, theme, 1, lead === "running" ? frame : undefined);
	lines.push(theme.fg("dim", `${leadBadge} ${statusLabel} · ${parts.join(" · ")}`));

	// — Default: every running Agent. Expanded: all non-superseded work units. —
	if (snapshot) {
		const agentLines = collectAgentRows(snapshot, frame, theme, language, width, expanded);
		const remainingLines = expanded ? MAX_INLINE_CARD_LINES - lines.length - 1 : Number.POSITIVE_INFINITY;
		let shown = 0;
		let hidden = 0;
		for (const line of agentLines) {
			if (shown >= remainingLines) { hidden++; continue; }
			lines.push(line);
			shown++;
		}
		if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `  … +${hidden} ${language === "zh" ? "更多" : "more"}`), width));
	}

	return lines;
}

function unitStartedAt(unit: WorkUnitActivity): number | undefined {
	return unit.node.attempts.at(-1)?.startedAt;
}

function collectAgentRows(snapshot: ActivitySnapshot, frame: number | undefined, theme: Theme, language: "zh" | "en", width: number, expanded: boolean): string[] {
	const lines: string[] = [];
	const executionsByWorkUnit = new Map<string, AgentExecutionActivity>();
	for (const exec of snapshot.executions) {
		if (exec.workUnitId) executionsByWorkUnit.set(exec.workUnitId, exec);
	}

	const units = allWorkUnits(snapshot).filter((unit) => {
		if (unit.state === "superseded") return false;
		const execution = executionsByWorkUnit.get(unit.id);
		return expanded || (execution?.state ?? unit.state) === "running";
	});
	for (const unit of units) {
		const execution = executionsByWorkUnit.get(unit.id);
		const state = execution?.state ?? unit.state;
		const badge = statusBadge(state, theme, 1, state === "running" ? frame : undefined);
		const employeeName = execution?.fleetItem
			? itemIdentity(execution.fleetItem, snapshot.language).name
			: undefined;
		const agent = employeeName ?? execution?.agent ?? unit.node.agentSpec.baseAgent;
		const role = execution?.role ?? unit.node.agentSpec.role;
		const activity = [execution?.activity, execution?.recent[0]?.text, execution?.objective, unit.node.agentSpec.objective, unit.label]
			.find((value) => value?.trim());
		const identity = `${theme.fg(employeeName ? "accent" : "muted", agent)}${role && role !== agent ? theme.fg("dim", ` · ${role}`) : ""}`;
		const left = `  ${badge} ${identity}${activity ? theme.fg(state === "running" ? "text" : "dim", ` · ${activity}`) : ""}`;
		const startedAt = execution?.startedAt ?? unitStartedAt(unit);
		const durationMs = execution
			? executionDurationMs(execution)
			: startedAt !== undefined && state === "running"
				? Math.max(0, Date.now() - startedAt)
				: unit.durationMs;
		const duration = durationMs !== undefined ? theme.fg("dim", formatDuration(durationMs)) : "";
		lines.push(withRightSuffix(left, duration, width));
	}
	return lines;
}
