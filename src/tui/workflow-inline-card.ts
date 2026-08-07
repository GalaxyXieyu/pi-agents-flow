/**
 * Compact inline card rendered beneath a `workflow` tool call after `run_ready`
 * (or any run-changing action). The card surfaces the current state of the
 * workflow at a glance — one row per top-level task, a lead badge reflecting the
 * overall state, and a compact task/done/failed count.
 *
 * It intentionally does not stream live progress during a wave; the Activity
 * Dock below the editor already does that. Keeping the card post-settle keeps
 * the transcript tidy and avoids re-render churn.
 *
 * Status symbols and colors follow `visual-language.ts` (same as the dock).
 * Text follows `snapshot.language` for zh/en.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskActivity } from "../activity/types.ts";
import { statusBadge, noticePrefix } from "./visual-language.ts";

export interface WorkflowInlineCardInput {
	runId: string;
	goal?: string;
	language: "zh" | "en";
	status: "active" | "completed" | "failed" | "paused" | "cancelled" | "stopped";
	tasks: TaskActivity[];
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

function aggregateTasks(tasks: TaskActivity[]): AggregateCounts {
	const counts: AggregateCounts = { running: 0, done: 0, failed: 0, waiting: 0, pending: 0 };
	for (const task of tasks) {
		switch (task.state) {
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

const MAX_INLINE_CARD_LINES = 15;

export function renderWorkflowInlineCard(input: WorkflowInlineCardInput, theme: Theme, width: number, expanded = false): string[] {
	const { runId, language, status, tasks, frame } = input;
	const counts = aggregateTasks(tasks);
	const lead = leadState(counts);
	const zh = language === "zh";
	const lines: string[] = [];

	const header = `${noticePrefix(status === "failed" ? "error" : status === "active" ? "info" : "success")} ${
		zh ? "工作流" : "Workflow"
	} ${theme.bold(runId.slice(0, 8))}${input.goal ? ` · ${input.goal}` : ""}`;
	lines.push(theme.fg(statusColorFor(status), header));

	const parts = [
		`${counts.running} ${zh ? "运行" : "running"}`,
		`${counts.done} ${zh ? "完成" : "done"}`,
	];
	if (counts.failed > 0) parts.push(`${counts.failed} ${zh ? "失败" : "failed"}`);
	if (counts.waiting > 0) parts.push(`${counts.waiting} ${zh ? "等待" : "waiting"}`);
	if (counts.pending > 0) parts.push(`${counts.pending} ${zh ? "待开始" : "pending"}`);
	const statusLabel = localize("状态", "Status", language);
	const leadBadge = statusBadge(lead, theme, 1, lead === "running" ? frame : undefined);
	lines.push(theme.fg("dim", `${leadBadge} ${statusLabel} · ${parts.join(" · ")}`));

	if (expanded) {
		// Expanded mode (ctrl+o): show task list with line limit (like read/bash tools)
		const remainingLines = MAX_INLINE_CARD_LINES - lines.length - 1; // -1 for potential overflow
		let lineCount = 0;
		let hiddenTasks = 0;
		for (const task of tasks) {
			if (lineCount >= remainingLines) {
				hiddenTasks++;
				continue;
			}
			const badge = statusBadge(task.state, theme, 1, task.state === "running" ? frame : undefined);
			const progress = task.total > 0 ? ` ${task.completed}/${task.total}` : "";
			lines.push(`  ${badge} ${theme.bold(task.label)}${progress}`);
			lineCount++;
		}
		if (hiddenTasks > 0) lines.push(theme.fg("dim", `  … +${hiddenTasks} more task${hiddenTasks === 1 ? "" : "s"}`));
	}
	// Collapsed mode (default): only header + status summary (like read/bash tools)
	// No task list shown when not expanded
	// Duration footer (right-aligned)
	const durationMs = getDurationMs(input.createdAt, input.updatedAt, status);
	if (durationMs !== undefined) {
		const durationText = formatDuration(durationMs);
		const padded = durationText.padStart(width);
		lines.push(theme.fg("dim", padded));
	}
	return lines;
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

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	if (minutes > 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
	return `${seconds}s`;
}

function getDurationMs(createdAt?: number, updatedAt?: number, status?: string): number | undefined {
	if (!createdAt) return undefined;
	const endTime = (status === "active" || status === "paused") ? Date.now() : (updatedAt ?? Date.now());
	return Math.max(0, endTime - createdAt);
}
