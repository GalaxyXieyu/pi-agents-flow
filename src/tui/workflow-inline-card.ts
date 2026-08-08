/**
 * Compact inline card rendered beneath a `workflow` tool call after `run_ready`
 * (or any run-changing action). The card surfaces the current state of the
 * workflow at a glance — header with right-aligned duration, status summary,
 * and live agent rows showing employee name, role, and current activity.
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
import type { ActivitySnapshot, AgentExecutionActivity, TaskActivity } from "../activity/types.ts";
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

/** Visible width of a string (strip ANSI escape codes). */
function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

const MAX_INLINE_CARD_LINES = 15;

export function renderWorkflowInlineCard(input: WorkflowInlineCardInput, theme: Theme, width: number, expanded = false): string[] {
	const { runId, language, status, snapshot, frame } = input;
	const counts = aggregateTasks(snapshot);
	const lead = leadState(counts);
	const zh = language === "zh";
	const lines: string[] = [];

	// — Header: prefix + label, duration right-aligned on same line —
	const prefix = noticePrefix(status === "failed" ? "error" : status === "active" ? "info" : "success");
	const headerLabel = `${prefix} ${zh ? "工作流" : "Workflow"} ${theme.bold(runId.slice(0, 8))}`;
	const durationMs = getDurationMs(input.createdAt, input.updatedAt, status);
	const durationText = durationMs !== undefined ? formatDuration(durationMs) : "";
	if (durationText) {
		const gap = Math.max(1, width - visibleLen(headerLabel) - visibleLen(durationText));
		lines.push(`${theme.fg(statusColorFor(status), headerLabel)}${" ".repeat(gap)}${theme.fg("dim", durationText)}`);
	} else {
		lines.push(theme.fg(statusColorFor(status), headerLabel));
	}

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

	// — Agent rows: employee name · role · live activity —
	if (expanded && snapshot) {
		const agentLines = collectAgentRows(snapshot, frame, theme, language);
		const remainingLines = MAX_INLINE_CARD_LINES - lines.length - 1;
		let shown = 0;
		let hidden = 0;
		for (const line of agentLines) {
			if (shown >= remainingLines) { hidden++; continue; }
			lines.push(line);
			shown++;
		}
		if (hidden > 0) lines.push(theme.fg("dim", `  … +${hidden} ${language === "zh" ? "更多" : "more"}`));
	}

	return lines;
}

function collectAgentRows(snapshot: ActivitySnapshot, frame: number | undefined, theme: Theme, language: "zh" | "en"): string[] {
	const lines: string[] = [];
	const executionsByWorkUnit = new Map<string, AgentExecutionActivity>();
	for (const exec of snapshot.executions) {
		if (exec.workUnitId) executionsByWorkUnit.set(exec.workUnitId, exec);
	}

	const units = allWorkUnits(snapshot);
	const maxLines = 12;
	let lineCount = 0;
	let hidden = 0;

	for (const unit of units) {
		if (unit.state === "superseded") continue;
		if (lineCount >= maxLines) { hidden++; continue; }

		const execution = executionsByWorkUnit.get(unit.id);
		const badge = execution
			? statusBadge(execution.state, theme, 1, execution.state === "running" ? frame : undefined)
			: statusBadge(unit.state, theme, 1, unit.state === "running" ? frame : undefined);

		if (execution) {
			const employeeName = execution.fleetItem
				? itemIdentity(execution.fleetItem, snapshot.language).name
				: undefined;
			const namePart = employeeName
				? theme.fg("accent", employeeName)
				: theme.fg("muted", execution.agent);
			const rolePart = theme.fg("dim", execution.role ?? unit.node?.agentSpec?.role ?? "");
			const activityPart = execution.activity
				? theme.fg("text", ` · ${execution.activity}`)
				: execution.recent.length > 0
					? theme.fg("dim", ` · ${execution.recent[0]!.text}`)
					: theme.fg("dim", ` · ${execution.state}`);
			lines.push(`  ${badge} ${namePart} ${rolePart}${activityPart}`);
		} else {
			const role = unit.node?.agentSpec?.role ?? unit.node?.agentSpec?.baseAgent ?? "agent";
			lines.push(`  ${badge} ${theme.fg("dim", role)}`);
		}
		lineCount++;
	}
	if (hidden > 0) lines.push(theme.fg("dim", `  … +${hidden} ${language === "zh" ? "更多" : "more"}`));

	return lines;
}
