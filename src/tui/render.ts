/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyText, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type AsyncJobStep,
	type AsyncParallelGroupStatus,
	type Details,
	type NestedRunSummary,
	type NestedStepSummary,
	type WorkflowNodeStatus,
} from "../shared/types.ts";
import { formatTokens, formatUsage, formatDuration, formatModelThinking, formatToolCall, shortenPath } from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { aggregateStepStatus, formatActivityLabel, formatAgentRunningLabel, formatParallelOutcome } from "../shared/status-format.ts";
import { contextModeBadge, contextModePrefix } from "../runs/shared/context-mode.ts";
import { statusBadge } from "./visual-language.ts";

type Theme = ExtensionContext["ui"]["theme"];

function liveDetailKeyText(): string {
	return keyText("app.tools.expand");
}

function liveDetailHintText(): string {
	return `Press ${liveDetailKeyText()} for live detail`;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiStylePattern = /\x1b\[[0-9;]*m/y;

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		ansiStylePattern.lastIndex = i;
		const ansiMatch = ansiStylePattern.exec(text);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = text.indexOf("\x1b[", i);
		if (end === i) end = text.indexOf("\x1b[", i + 2);
		if (end === -1) end = text.length;
		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

function wrapPlainText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [""];
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const seg of segmenter.segment(rawLine)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (currentWidth > 0 && currentWidth + graphemeWidth > maxWidth) {
				lines.push(current);
				current = grapheme;
				currentWidth = graphemeWidth;
				continue;
			}
			current += grapheme;
			currentWidth += graphemeWidth;
		}
		lines.push(current);
	}
	return lines;
}

type ProgressSeedSource = Partial<Pick<AgentProgress, "index" | "toolCount" | "tokens" | "durationMs" | "lastActivityAt" | "currentToolStartedAt" | "turnCount">>;

function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

function animatedStatusBadge(state: string, theme: Theme): string {
	return statusBadge(state, theme);
}

function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
	if (!progress) return undefined;
	return runningSeed(
		progress.index,
		progress.toolCount,
		progress.tokens,
		progress.durationMs,
		progress.lastActivityAt,
		progress.currentToolStartedAt,
		progress.turnCount,
	);
}

interface LegacyResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (!timer) return;
	clearInterval(timer);
	context.state.subagentResultAnimationTimer = undefined;
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to(?: exactly this path)?:\s*([^\r\n]+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

function getToolCallLines(
	result: Pick<Details["results"][number], "messages" | "toolCalls">,
	expanded: boolean,
): string[] {
	if (result.messages) {
		return getDisplayItems(result.messages)
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return result.toolCalls?.map((toolCall) => expanded ? toolCall.expandedText : toolCall.text) ?? [];
}


function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
	return progress.lastActivityAt;
}

function formatCurrentToolLine(
	progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
	availableWidth: number,
	expanded: boolean,
	snapshotNow?: number,
): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? (expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`)
		: "";
	const durationSuffix = progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
		? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
		: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(progress: Pick<AgentProgress, "activityState" | "lastActivityAt">, snapshotNow?: number): string | undefined {
	if (progress.lastActivityAt !== undefined && snapshotNow !== undefined) return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
	if (progress.activityState === "needs_attention") return "needs attention";
	if (progress.activityState === "active_long_running") return "active but long-running";
	if (progress.lastActivityAt !== undefined) return "active";
	return undefined;
}

function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatTotalCostStat(totalCost: Details["totalCost"] | undefined): string {
	if (!totalCost || (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0)) return "";
	const parts: string[] = [];
	if (totalCost.inputTokens) parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
	if (totalCost.outputTokens) parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
	if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);
	return parts.join(" ");
}

function formatProgressStats(theme: Theme, progress: Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined, includeDuration = true): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	if (includeDuration && progress.durationMs > 0) parts.push(formatDuration(progress.durationMs));
	return statJoin(theme, parts);
}

function firstOutputLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.stopped) return "Stopped";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (result.acceptance?.status && result.acceptance.status !== "not-required") return `Done · acceptance: ${result.acceptance.status}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running"): string {
	if (running) return statusBadge("running", theme);
	if (result.detached) return statusBadge("detached", theme);
	if (result.stopped) return statusBadge("stopped", theme);
	if (result.interrupted) return statusBadge("paused", theme);
	if (result.exitCode !== 0) return statusBadge("failed", theme);
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return statusBadge("completed", theme);
	return statusBadge("completed", theme);
}

function compactCurrentActivity(progress: AgentProgress): string {
	const snapshotNow = snapshotNowForProgress(progress);
	return formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ?? buildLiveStatusLine(progress, snapshotNow) ?? "thinking…";
}

function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} x${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme): string {
	return statusBadge(status, theme);
}

function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	if (status === "stopped") return theme.fg("warning", "stopped");
	return theme.fg("dim", status);
}

function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
	status?: WorkflowNodeStatus;
	label?: string;
	error?: string;
}

function buildChainStepSpans(details: Pick<Details, "chainAgents" | "workflowGraph">): ChainStepSpan[] {
	if (details.workflowGraph?.nodes?.length) {
		const spans: ChainStepSpan[] = [];
		let flatCursor = 0;
		for (const node of details.workflowGraph.nodes) {
			if (node.stepIndex === undefined) continue;
			if (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") {
				const childFlatIndexes = (node.children ?? [])
					.map((child) => child.flatIndex)
					.filter((value): value is number => typeof value === "number");
				const start = childFlatIndexes.length ? Math.min(...childFlatIndexes) : flatCursor;
				const count = node.children?.length ?? 0;
				spans.push({ stepIndex: node.stepIndex, start, count, isParallel: true, status: node.status, label: node.label, error: node.error });
				flatCursor = Math.max(flatCursor, start + count);
				continue;
			}
			const start = node.flatIndex ?? flatCursor;
			spans.push({ stepIndex: node.stepIndex, start, count: 1, isParallel: false, status: node.status, label: node.label, error: node.error });
			flatCursor = Math.max(flatCursor, start + 1);
		}
		if (spans.length) return spans.sort((left, right) => left.stepIndex - right.stepIndex);
	}

	if (!details.chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
		const label = details.chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
}

function workflowGraphHasStatus(details: Pick<Details, "workflowGraph">, statuses: WorkflowNodeStatus[]): boolean {
	return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}

interface ChainRenderResultEntry {
	kind: "result";
	resultIndex: number;
	rowNumber: number;
	rowLabel?: string;
	agentName: string;
}

interface ChainRenderPlaceholderEntry {
	kind: "placeholder";
	rowNumber: number;
	stepLabel: string;
	agentName: string;
	status: WorkflowNodeStatus;
	error?: string;
}

type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry;

function buildChainRenderEntries(details: Details, label: MultiProgressLabel): ChainRenderEntry[] | undefined {
	if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (span.isParallel && span.count === 0) {
			entries.push({
				kind: "placeholder",
				rowNumber: span.stepIndex + 1,
				stepLabel: `Step ${span.stepIndex + 1}`,
				agentName: span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
				status: span.status ?? "pending",
				error: span.error,
			});
			continue;
		}
		for (let index = span.start; index < span.start + span.count; index++) {
			entries.push({
				kind: "result",
				resultIndex: index,
				rowNumber: index + 1,
				rowLabel: span.isParallel ? `Agent ${index - span.start + 1}/${span.count}` : `Step ${span.stepIndex + 1}`,
				agentName: details.results[index]?.agent ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
			});
		}
	}
	return entries;
}

interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	activeParallelGroup: boolean;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents" | "workflowGraph">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = details.mode === "chain"
		&& details.currentStepIndex !== undefined
		&& stepSpans.some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed" | "stopped" | "detached">;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray = details.progress?.find((progress) => progress.index === i)
				|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status = result.progress?.status
				?? (result.stopped
					? "stopped"
					: result.interrupted || result.detached
						? "detached"
						: result.exitCode === 0
							? "completed"
							: "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: totalCount, showActiveGroupOnly: false };
	}

	if (activeParallelGroup) {
		const currentStepIndex = details.currentStepIndex!;
		const span = stepSpans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let running = 0;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "running") {
				running++;
				continue;
			}
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
		const headerLabel = hasRunning
			? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
			: `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
		return { headerLabel, itemTitle, totalCount: groupSize, hasParallelInChain, activeParallelGroup, groupStartIndex: groupStart, groupEndIndex: groupEnd, showActiveGroupOnly: true };
	}

	if (details.mode === "chain" && details.chainAgents?.length) {
		const totalCount = details.totalSteps ?? details.chainAgents.length;
		const doneLogical = stepSpans.filter((span) => {
			if (span.status && span.status !== "completed") return false;
			if (span.count === 0) return span.status === "completed";
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending" || progressEntry?.status === "failed") return false;
				if (!resultEntry || !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
		const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
}

function resultRowLabel(label: MultiProgressLabel, resultIndex: number, stepNumber: number): string {
	if (label.itemTitle === "Agent") {
		const localStepNumber = label.activeParallelGroup
			? resultIndex - label.groupStartIndex + 1
			: stepNumber;
		return `Agent ${localStepNumber}/${label.totalCount}`;
	}
	return `Step ${stepNumber}`;
}

function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme): string {
	return statusBadge(state, theme);
}

function formatClockTime(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	const date = new Date(ms);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function nestedRunEventTime(run: NestedRunSummary): number | undefined {
	return run.state === "running"
		? (run.lastActivityAt ?? run.currentToolStartedAt ?? run.lastUpdate ?? run.startedAt)
		: (run.endedAt ?? run.lastUpdate ?? run.lastActivityAt ?? run.startedAt);
}

function nestedStepTimestamp(step: NestedStepSummary, fallback?: number): string | undefined {
	return formatClockTime(step.status === "running"
		? (step.lastActivityAt ?? step.currentToolStartedAt ?? fallback ?? step.startedAt)
		: (step.endedAt ?? step.lastActivityAt ?? fallback ?? step.startedAt));
}

function nestedTimestampPrefix(timestamp: string | undefined): string {
	return timestamp ? `[${timestamp}] ` : "";
}

function nestedActivity(input: Pick<NestedRunSummary | NestedStepSummary, "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount">, state: NestedRunSummary["state"] | NestedStepSummary["status"], snapshotNow?: number): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "stopped") return "Stopped";
	if (state === "failed") return "Failed";
	return "Done";
}

function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		const latest = children.reduce((acc, child) => Math.max(acc, nestedRunEventTime(child) ?? 0), 0);
		return aggregate ? [theme.fg("dim", `↳ ${nestedTimestampPrefix(formatClockTime(latest))}${aggregate}`)] : [];
	}
	const lines: string[] = [];
	const maxDepth = 2;
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= lineBudget) return;
		if (depth > maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
			const error = child.error ? ` · ${child.error}` : "";
			lines.push(theme.fg("dim", `${prefix}↳ ${nestedTimestampPrefix(formatClockTime(nestedRunEventTime(child)))}${nestedStatusGlyph(child.state, theme)} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`));
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedTimestampPrefix(nestedStepTimestamp(step, child.lastUpdate))}${nestedStatusGlyph(step.status, theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`));
				append(step.children, depth + 1, `${prefix}    `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, "");
	return lines.map((line) => truncLine(line, width));
}

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme, frame?: number): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = contextModeBadge(theme, r.context ?? d.context);
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	const modelDisplay = modelThinkingBadge(theme, r.model ?? r.progress?.model, r.thinking ?? r.progress?.thinking);
	c.addChild(new Text(truncLine(`${resultGlyph(r, output, theme, isRunning)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	if (isRunning && r.progress) {
		c.addChild(new Text(truncLine(theme.fg("dim", "  Live details: /subagents-fleet"), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
		return c;
	}

	c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
	}
	if (r.sessionFile) c.addChild(new Text(truncLine(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
	if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	if (r.truncation?.artifactPath) c.addChild(new Text(truncLine(theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0));
	return c;
}

function renderMultiCompact(d: Details, theme: Theme, frame?: number): Component {
	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const stopped = d.results.some((r) => r.stopped && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["stopped"]);
	const failed = d.results.some((r) => !r.stopped && r.exitCode !== 0 && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["failed"]);
	const paused = d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["paused", "detached"]);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs = d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	const stats = statJoin(theme, [multiLabel.headerLabel, formatProgressStats(theme, totalSummary), formatTotalCostStat(d.totalCost)]);
	const glyph = hasRunning
		? statusBadge("running", theme)
		: statusBadge(stopped ? "stopped" : failed ? "failed" : paused ? "paused" : "completed", theme);
	const contextBadge = contextModeBadge(theme, d.context);
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const fallbackLabel = itemTitle.toLowerCase();
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `${fallbackLabel}-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `${fallbackLabel}-${rowNumber}`) };
	});
	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const glyph = widgetStepGlyph(entry.status as AsyncJobStep["status"], theme);
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(truncLine(`  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${statusLabel}`, width), 0, 0));
			if (entry.error) c.addChild(new Text(truncLine(theme.fg("error", `    ⎿  Error: ${entry.error}`), width), 0, 0));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const pendingLabel = entry.rowLabel ?? `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(truncLine(theme.fg("dim", `  ${statusBadge("pending", theme)} ${pendingLabel}: ${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber = r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1;
		const stepStats = formatProgressStats(theme, rProg);
		const glyph = rPending ? statusBadge("pending", theme) : resultGlyph(r, output, theme, rRunning);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = entry.rowLabel ?? resultRowLabel(multiLabel, i, stepNumber);
		const rowProgressModel = rProg && "status" in rProg ? rProg : undefined;
		const rowModelDisplay = modelThinkingBadge(theme, r.model ?? rowProgressModel?.model, r.thinking ?? rowProgressModel?.thinking);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${contextModeBadge(theme, r.context)}${rowModelDisplay}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			c.addChild(new Text(truncLine(theme.fg("dim", "    Live details: /subagents-fleet"), width), 0, 0));
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
		}
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	}
	if (d.artifacts) c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
	frame?: number,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = contextModePrefix(theme, d?.context);
		// An async launch ships a verbose guidance block in `content` meant for the
		// model (do not wait, do not poll, ...). Keep the full text for the model but
		// show only the headline to the user so the transcript card stays compact.
		const isAsyncLaunch = Boolean(d && (d.detached || typeof (d as { mode?: string }).mode === "string"));
		const width = getTermWidth() - 4;
		if (!text.includes("\n")) return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);
		if (isAsyncLaunch) {
			// First non-empty line is the headline (e.g. "Async parallel: [scout+...] [...]"); the rest is
			// the interactive/headless guidance block. Surface the headline plus a compact detached hint.
			const headline = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
			const detachedHint = d?.mode ? ` · async (${d.mode})` : " · async";
			const mode = "detached" in d && (d as { detached?: boolean }).detached ? " · detached" : "";
			const display = `${contextPrefix}${headline}${detachedHint}${mode}`;
			const c = new Container();
			c.addChild(new Text(truncLine(display, width), 0, 0));
			c.addChild(new Text(truncLine(theme.fg("accent", `  Press ${liveDetailKeyText()} for full output`), width), 0, 0));
			return c;
		}
		if (d && !options.expanded && !result.isError) {
			const lines = text.split(/\r?\n/);
			const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";
			const c = new Container();
			c.addChild(new Text(truncLine(`${contextPrefix}${firstNonEmptyLine} · ${lines.length} lines`, width), 0, 0));
			c.addChild(new Text(truncLine(theme.fg("accent", `  Press ${liveDetailKeyText()} for full output`), width), 0, 0));
			return c;
		}
		const c = new Container();
		const wrapped = wrapPlainText(`${contextPrefix}${text}`, width);
		for (const line of wrapped) c.addChild(new Text(line, 0, 0));
		return c;
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme, frame);
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "running")
			: r.detached
				? theme.fg("warning", "detached")
				: r.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", "failed");
		const contextBadge = contextModeBadge(theme, r.context ?? d.context);
		const output = r.truncation?.text || getSingleResultOutput(r);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			const progressSnapshotNow = snapshotNowForProgress(r.progress);
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, progressSnapshotNow, 12)) {
				c.addChild(new Text(fit(`  ${nestedLine}`), 0, 0));
			}
			const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", liveDetailHintText())), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (toolLine || liveStatusLine || r.progress.recentTools?.length || r.progress.recentOutput?.length || r.artifactPaths) {
				c.addChild(new Spacer(1));
			}
		} else {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, r.progress?.lastActivityAt, 8)) {
				c.addChild(new Text(fit(`  ${nestedLine}`), 0, 0));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme, frame);

	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
	const hasWorkflowStop = d.results.some((r) => r.stopped && r.progress?.status !== "running") || workflowGraphHasStatus(d, ["stopped"]);
	const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: hasWorkflowFailure
				? theme.fg("error", "failed")
				: hasWorkflowStop
					? theme.fg("warning", "stopped")
					: hasWorkflowPause
						? theme.fg("warning", "paused")
					: ok === d.results.length
						? theme.fg("success", "ok")
						: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain"
							? acc.durationMs + prog.durationMs
							: Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const summaryParts = [
		totalSummary.toolCount || totalSummary.tokens
			? `${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "",
		formatTotalCostStat(d.totalCost),
	].filter(Boolean);
	const summaryStr = summaryParts.length ? ` | ${summaryParts.join(", ")}` : "";

	const modeLabel = d.mode;
	const contextBadge = contextModeBadge(theme, d.context);
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;

	const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "failed")
						: isEmptyWithoutTarget
							? theme.fg("warning", "warning")
							: isComplete
								? theme.fg("success", "done")
								: isCurrent && hasRunning
									? theme.fg("warning", "running")
									: theme.fg("dim", "pending");
					return `${stepIcon} ${agent}${contextModeBadge(theme, result?.context)}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `step-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `step-${rowNumber}`) };
	});

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`), 0, 0));
			c.addChild(new Text(theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`), 0, 0));
			if (entry.error) c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;

		if (!r) {
			const pendingLabel = entry.rowLabel ?? `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(fit(theme.fg("dim", `  ${pendingLabel}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i)
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";
		const stepNumber = typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "running")
			: r.exitCode !== 0
				? theme.fg("error", "failed")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "warning")
					: theme.fg("success", "done");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = modelThinkingBadge(theme, r.model);
		const stepLabel = entry.rowLabel ?? resultRowLabel(multiLabel, i, stepNumber);
		const contextBadge = contextModeBadge(theme, r.context);
		const stepHeader = rRunning
			? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.agent))}${contextBadge}${modelDisplay}${stats}`
			: `${statusIcon} ${stepLabel}: ${theme.bold(r.agent)}${contextBadge}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(stepHeader), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			const progressSnapshotNow = snapshotNowForProgress(rProg);
			const toolLine = formatCurrentToolLine(rProg, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, progressSnapshotNow, 8)) {
				c.addChild(new Text(fit(`    ${nestedLine}`), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", `    ${liveDetailHintText()}`)), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		if (!rRunning) {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, r.progress?.lastActivityAt, 8)) {
				c.addChild(new Text(fit(`    ${nestedLine}`), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
