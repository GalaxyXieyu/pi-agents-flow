import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createPiSwarmKeymap, panelHintBar, type PiSwarmPanelAction } from "./keymap.ts";
import { discoverAgents, resolveAgentName, type AgentConfig } from "../agents/agents.ts";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../shared/formatters.ts";
import { type Details, type SubagentState } from "../shared/types.ts";
import { collectFleetSnapshot } from "../activity/fleet-projection.ts";
import type { FleetItem, FleetSnapshot } from "../activity/fleet-types.ts";
export type { FleetItem, FleetSnapshot } from "../activity/fleet-types.ts";
export { collectFleetSnapshot } from "../activity/fleet-projection.ts";
import { readStatus } from "../shared/utils.ts";
import { formatAsyncRunTranscript } from "../runs/background/fleet-view.ts";
import type { AsyncRunSummary } from "../runs/background/async-status.ts";
import { steerAsyncRun } from "../runs/foreground/async-steering-action.ts";
import { foregroundSteerAvailable, steerForegroundRun } from "../runs/foreground/foreground-steering.ts";
import { stopAsyncRun } from "../runs/foreground/async-stop-action.ts";
import { contextModeBadge, contextModeLabel } from "../runs/shared/context-mode.ts";
import { FleetAvatarRenderer, type FleetAvatarRender } from "./fleet-avatar.ts";
import { fleetIdentity, type FleetIdentity, type FleetIdentityLanguage } from "./fleet-identity.ts";
import { readFleetTranscript, renderFleetTranscriptView, type FleetTranscript, type FleetTranscriptEventSpan } from "./fleet-transcript.ts";
import { fit, rightAlign } from "./render-helpers.ts";
import { selectionMarker, statusBadge } from "./visual-language.ts";

const REFRESH_MS = 750;
const TRANSCRIPT_LINES = 200;

const FLEET_HINT_ORDER: PiSwarmPanelAction[] = [
	"selectUp",
	"selectDown",
	"scrollUp",
	"scrollDown",
	"pageUp",
	"pageDown",
	"scrollStart",
	"scrollEnd",
	"toggleView",
	"cycleView",
	"confirm",
	"follow",
	"expandTools",
	"refresh",
	"steer",
	"stop",
	"close",
];

type Theme = ExtensionContext["ui"]["theme"];
type FleetTui = {
	terminal?: { rows: number };
	requestRender(): void;
};
type AsyncStep = AsyncRunSummary["steps"][number];

export interface FleetActionResult {
	text: string;
	isError?: boolean;
}

export interface FleetActionHandlers {
	steer(input: { runId: string; asyncDir?: string; index?: number; source: "async" | "foreground"; message: string }): Promise<FleetActionResult>;
	stop(input: { runId: string; asyncDir: string; index?: number }): Promise<FleetActionResult> | FleetActionResult;
}

export type FleetPromptRequest = {
	kind: "steer" | "stop";
	itemKey: string;
	runId: string;
	asyncDir?: string;
	index?: number;
	agent: string;
	source: "async" | "foreground";
};

export interface FleetViewOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	refreshMs?: number;
	initialKey?: string;
	markdownTheme?: MarkdownTheme;
	actions?: FleetActionHandlers;
	agents?: AgentConfig[];
	language?: FleetIdentityLanguage;
}

function statusGlyph(item: FleetItem, theme: Theme): string {
	return statusBadge(item.state, theme);
}

function foregroundActiveDetail(item: Extract<FleetItem, { kind: "foreground-active" }>): string[] {
	const { control } = item;
	const live = item.activeChild ?? control;
	const modelThinking = formatModelThinking(live.model, live.thinking);
	const currentToolDuration = live.currentToolStartedAt === undefined ? undefined : formatDuration(Math.max(0, Date.now() - live.currentToolStartedAt));
	const recentTools = live.recentTools?.slice(-8) ?? [];
	const recentOutput = live.recentOutput?.filter((line) => line.trim()).slice(-20) ?? [];
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: running`,
		`Mode: ${control.mode}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})` : `Agent: ${item.agent}`,
		modelThinking ? `Model: ${modelThinking}` : undefined,
		`Started: ${new Date(live.startedAt).toISOString()}`,
		live.currentTool ? `Current tool: ${live.currentTool}${live.currentToolArgs ? ` ${live.currentToolArgs}` : ""}${currentToolDuration ? ` · ${currentToolDuration}` : ""}${live.currentPath ? ` · ${shortenPath(live.currentPath)}` : ""}` : undefined,
		live.turnCount !== undefined ? `Turns: ${live.turnCount}` : undefined,
		live.toolCount !== undefined ? `Tools: ${live.toolCount}` : undefined,
		live.tokens !== undefined ? `Tokens: ${formatTokens(live.tokens)}` : undefined,
		"",
		"Live activity",
		live.currentTool ? `◐ ${live.currentTool}${live.currentToolArgs ? ` ${live.currentToolArgs}` : ""}` : "○ Waiting for the next model or tool event",
		...(recentTools.length ? ["", "Recent tool calls", ...recentTools.map((tool) => `● ${tool.tool}${tool.args ? ` ${tool.args}` : ""}`)] : []),
		...(recentOutput.length ? ["", "Recent output", ...recentOutput] : []),
		...(!recentTools.length && !recentOutput.length ? ["", "Streaming data will appear here as soon as the child emits output or starts a tool."] : []),
	];
	return lines.filter((line): line is string => line !== undefined);
}

function foregroundRecentDetail(item: Extract<FleetItem, { kind: "foreground-recent" }>): string[] {
	const { child, run } = item;
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	const modelThinking = formatModelThinking(child.model, child.thinking);
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: ${child.status}`,
		`Mode: ${run.mode}`,
		`Child: ${child.index} (${child.agent})${contextModeLabel(child.context) ? ` ${contextModeLabel(child.context)}` : ""}`,
		modelThinking ? `Model: ${modelThinking}` : undefined,
		`Updated: ${new Date(child.updatedAt ?? run.updatedAt).toISOString()}`,
		outputPath ? `Output: ${outputPath}` : undefined,
		child.sessionFile ? `Session: ${child.sessionFile}` : undefined,
		child.transcriptPath ? `Transcript file: ${child.transcriptPath}` : undefined,
		child.error ? `Error: ${child.error}` : undefined,
		child.outputSaveError ? `Output warning: ${child.outputSaveError}` : undefined,
		child.transcriptError ? `Transcript warning: ${child.transcriptError}` : undefined,
		"",
		"Result transcript tail",
	];
	const outputLines = (child.finalOutput ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(-TRANSCRIPT_LINES);
	lines.push(...(outputLines.length ? outputLines : ["(no recovered output available)"]));
	return lines.filter((line): line is string => line !== undefined);
}

function asyncDetail(item: Extract<FleetItem, { kind: "async" }>): string[] {
	const status = readStatus(item.run.asyncDir);
	if (status) {
		return formatAsyncRunTranscript(status, item.run.asyncDir, { index: item.index, lines: TRANSCRIPT_LINES }).split("\n");
	}
	const outputPath = item.index !== undefined ? path.join(item.run.asyncDir, `output-${item.index}.log`) : undefined;
	return [
		`Run: ${item.runId}`,
		"Source: async",
		`State: ${item.state}`,
		`Mode: ${item.run.mode}${contextModeLabel(item.run.context) ? ` ${contextModeLabel(item.run.context)}` : ""}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})${contextModeLabel(item.step?.context) ? ` ${contextModeLabel(item.step?.context)}` : ""}` : `Agent: ${item.agent}${contextModeLabel(item.run.context) ? ` ${contextModeLabel(item.run.context)}` : ""}`,
		outputPath ? `Output: ${outputPath}` : undefined,
		item.step?.sessionFile ? `Session: ${item.step.sessionFile}` : item.run.sessionFile ? `Session: ${item.run.sessionFile}` : undefined,
		"",
		"Transcript",
		"(status is no longer available)",
	].filter((line): line is string => line !== undefined);
}

function detailLines(item: FleetItem | undefined, error: string | undefined): string[] {
	if (!item) return [error ? `Fleet scan failed: ${error}` : "No current-session foreground or recent async children.", "", "New runs appear here automatically while this inspector remains open."];
	const lines = item.kind === "foreground-active"
		? foregroundActiveDetail(item)
		: item.kind === "foreground-recent"
			? foregroundRecentDetail(item)
			: asyncDetail(item);
	if (error) lines.unshift(`Fleet scan warning: ${error}`, "");
	return lines;
}

function wrapDetailLines(lines: string[], width: number, theme: Theme): string[] {
	const wrappedLines: string[] = [];
	for (const line of lines) {
		const styled = /^(Run|State|Mode|Source|Child|Agent|Model|Description|Definition):/.test(line)
			? theme.bold(line)
			: /^(Transcript|Result transcript tail|System prompt)$/.test(line)
				? theme.fg("accent", line)
				: /^(Output|Session|Transcript file|Artifacts|File|Tools|Skills|Extensions|Context|Thinking):/.test(line)
					? theme.fg("muted", line)
					: /^Transcript preview warning:/.test(line)
						? theme.fg("warning", line)
						: line;
		const wrapped = wrapTextWithAnsi(styled, Math.max(1, width));
		wrappedLines.push(...(wrapped.length ? wrapped : [""]));
	}
	return wrappedLines;
}

function isActionableAsyncState(state: string): boolean {
	return state === "running" || state === "queued" || state === "pending";
}

function firstToolResultText(result: AgentToolResult<Details> | null, fallback: string): FleetActionResult {
	if (!result) return { text: fallback, isError: true };
	const text = result.content.find((item) => item.type === "text")?.text ?? fallback;
	return { text, ...(result.isError ? { isError: true } : {}) };
}

function uniquePaths(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value)))];
}

function fleetArtifactsRoot(state: SubagentState, cwd: string): string {
	return getArtifactsDir(
		state.parentSessionFile ?? null,
		cwd,
		state.artifactDirPreference ?? "project",
	);
}

function transcriptTarget(item: FleetItem, state: SubagentState): { path: string; trustedRoots: string[] } | undefined {
	if (item.kind === "foreground-active") {
		const artifactsRoot = fleetArtifactsRoot(state, item.control.cwd ?? state.baseCwd);
		return {
			path: getArtifactPaths(artifactsRoot, item.runId, item.agent, item.index ?? 0).transcriptPath,
			trustedRoots: [artifactsRoot],
		};
	}
	if (item.kind === "foreground-recent") {
		if (!item.child.transcriptPath) return undefined;
		const transcriptPath = path.isAbsolute(item.child.transcriptPath)
			? item.child.transcriptPath
			: path.resolve(item.run.cwd, item.child.transcriptPath);
		return {
			path: transcriptPath,
			trustedRoots: uniquePaths([
				fleetArtifactsRoot(state, item.run.cwd),
				fleetArtifactsRoot(state, state.baseCwd),
			]),
		};
	}
	const step = item.step ?? (item.run.steps.length === 1 ? item.run.steps[0] : undefined);
	if (!step?.transcriptPath) return undefined;
	const transcriptPath = path.isAbsolute(step.transcriptPath)
		? step.transcriptPath
		: path.resolve(item.run.asyncDir, step.transcriptPath);
	const trackedJob = state.fleetJobs?.get(item.runId) ?? state.asyncJobs.get(item.runId);
	return {
		path: transcriptPath,
		trustedRoots: uniquePaths([
			item.run.asyncDir,
			fleetArtifactsRoot(state, state.baseCwd),
			trackedJob?.cwd ? fleetArtifactsRoot(state, trackedJob.cwd) : undefined,
		]),
	};
}

function itemContext(item: FleetItem): string | undefined {
	if (item.kind === "async") return contextModeLabel(item.step?.context ?? item.run.context);
	if (item.kind === "foreground-recent") return contextModeLabel(item.child.context);
	return undefined;
}

function itemMode(item: FleetItem): string {
	return item.kind === "foreground-active" ? item.control.mode : item.run.mode;
}

function itemSource(item: FleetItem): string {
	if (item.kind === "async") return "background";
	return item.kind === "foreground-active" ? "foreground · live" : "foreground · recent";
}

function itemAgentName(item: FleetItem): string {
	if (item.kind === "foreground-active") return item.activeChild?.agent ?? item.control.currentAgent ?? item.agent;
	if (item.kind === "foreground-recent") return item.child.agent;
	return item.step?.agent ?? item.agent;
}

function itemWorkingDirectory(item: FleetItem, state: SubagentState): string {
	if (item.kind === "foreground-active") return item.control.cwd ?? state.baseCwd;
	if (item.kind === "foreground-recent") return item.run.cwd;
	return state.fleetJobs?.get(item.runId)?.cwd ?? state.asyncJobs.get(item.runId)?.cwd ?? item.run.cwd ?? state.baseCwd;
}

export function fleetItemIdentityKey(item: FleetItem): string {
	return `${item.runId}:${item.index ?? 0}:${itemAgentName(item)}`;
}

export function itemIdentity(item: FleetItem, language: FleetIdentityLanguage = "en"): FleetIdentity {
	return fleetIdentity(fleetItemIdentityKey(item), language);
}

function agentDefinitionLines(agent: AgentConfig | undefined, item: FleetItem): string[] {
	if (!agent) {
		return [
			"Definition",
			`Agent: ${itemAgentName(item)}`,
			"",
			"No matching Agent definition was found in the current project, user, package, or built-in scopes.",
		];
	}
	const capabilities = [
		agent.tools?.length ? `Tools: ${agent.tools.join(", ")}` : undefined,
		agent.skills?.length ? `Skills: ${agent.skills.join(", ")}` : undefined,
		agent.extensions?.length ? `Extensions: ${agent.extensions.join(", ")}` : undefined,
	].filter((value): value is string => Boolean(value));
	return [
		"Definition",
		`Agent: ${agent.name}`,
		`Description: ${agent.description}`,
		`Source: ${agent.source}`,
		`File: ${agent.filePath}`,
		agent.model ? `Model: ${agent.model}` : undefined,
		agent.thinking !== undefined ? `Thinking: ${String(agent.thinking)}` : undefined,
		`Context: ${agent.defaultContext ?? "configured at launch"}`,
		...capabilities,
		"",
		"System prompt",
		...(agent.systemPrompt.trim() ? agent.systemPrompt.split(/\r?\n/) : ["(empty)"]),
	].filter((line): line is string => line !== undefined);
}

function itemStats(item: FleetItem): string[] {
	let model: string | undefined;
	let tokens: number | undefined;
	let tools: number | undefined;
	let durationMs: number | undefined;
	if (item.kind === "foreground-active") {
		const live = item.activeChild ?? item.control;
		model = formatModelThinking(live.model, live.thinking) || undefined;
		tokens = live.tokens;
		tools = live.toolCount;
		durationMs = Math.max(0, Date.now() - live.startedAt);
	} else if (item.kind === "foreground-recent") {
		model = formatModelThinking(item.child.model, item.child.thinking) || undefined;
		tokens = item.child.tokens;
		tools = item.child.toolCount;
	} else {
		model = item.step?.model;
		tokens = item.step?.tokens?.total ?? (item.index === undefined ? item.run.totalTokens?.total : undefined);
		tools = item.step?.toolCount ?? (item.index === undefined ? item.run.toolCount : undefined);
		const terminalRun = item.state !== "queued" && item.state !== "running" && item.state !== "pending";
		const endTime = item.run.endedAt ?? (terminalRun ? item.run.lastUpdate : undefined) ?? Date.now();
		durationMs = item.step?.durationMs ?? Math.max(0, endTime - item.run.startedAt);
	}
	return [
		model,
		tokens !== undefined ? `${formatTokens(tokens)} tok` : undefined,
		tools !== undefined ? `${tools} tool${tools === 1 ? "" : "s"}` : undefined,
		durationMs !== undefined ? formatDuration(durationMs) : undefined,
	].filter((value): value is string => Boolean(value));
}

function itemPinnedActivity(item: FleetItem): string | undefined {
	if (item.kind !== "foreground-active") return undefined;
	const live = item.activeChild ?? item.control;
	if (!live.currentTool) return undefined;
	return `Current tool: ${live.currentTool}${live.currentToolArgs ? ` ${live.currentToolArgs}` : ""}`;
}

function structuredHeader(item: FleetItem, profile: FleetIdentity, width: number, theme: Theme, avatar: FleetAvatarRender): string[] {
	const avatarWidth = avatar.lines.length > 0 ? avatar.width + 1 : 0;
	const contentWidth = Math.max(1, width - avatarWidth);
	const child = item.index !== undefined ? ` · child ${item.index + 1}` : "";
	const context = itemContext(item);
	const sourceIdentity = `${itemSource(item)} · ${item.runId.slice(0, 8)}${child} · ${itemMode(item)}${context ? ` ${context}` : ""}`;
	const stats = itemStats(item);
	const pinnedActivity = itemPinnedActivity(item);
	const task = item.description?.replace(/\s+/g, " ").trim() || "Awaiting assignment";
	const profileLines = [
		rightAlign(theme.bold(profile.name), `${statusGlyph(item, theme)} ${theme.fg("dim", item.state)}`, contentWidth),
		`${theme.fg("dim", "Role    ")}${theme.fg("accent", `${itemAgentName(item)} · ${itemMode(item)}`)}`,
		`${theme.fg("dim", "Usage   ")}${stats.length ? theme.fg("muted", stats.join(" · ")) : theme.fg("dim", "No usage reported")}`,
		`${theme.fg("dim", "Active  ")}${pinnedActivity ? theme.fg("warning", pinnedActivity.replace(/^Current tool:\s*/, "")) : theme.fg("dim", "No active tool")}`,
		`${theme.fg("dim", "Task    ")}${task}`,
		`${theme.fg("dim", "Source  ")}${theme.fg("muted", sourceIdentity)}`,
		`${theme.fg("dim", "Run     ")}${theme.fg("muted", item.runId)}`,
	];
	if (avatar.lines.length === 0) return profileLines.map((line) => truncateToWidth(line, width));
	const lineCount = Math.max(avatar.lines.length, profileLines.length);
	return Array.from({ length: lineCount }, (_, index) => {
		const avatarLine = avatar.lines[index] ?? "";
		const gap = " ".repeat(Math.max(1, avatarWidth - (avatarLine ? avatar.width : 0)));
		return truncateToWidth(`${avatarLine}${gap}${profileLines[index] ?? ""}`, width);
	});
}

interface FleetDetailSections {
	header: string[];
	body: string[];
	activity?: string;
}

interface FleetTranscriptCache {
	path: string;
	fingerprint: string;
	width: number;
	expandedSignature: string;
	selectedEventKey?: string;
	transcript: FleetTranscript;
	body: string[];
	eventSpans: FleetTranscriptEventSpan[];
}

function transcriptFingerprint(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

export class SubagentFleetComponent implements Component {
	private snapshot: FleetSnapshot = { items: [] };
	private selected = 0;
	private selectedKey: string | undefined;
	private detailScroll = 0;
	private detailAutoFollow = true;
	private detailMode: "live" | "agent" = "live";
	private focus: "roster" | "detail" = "roster";
	private selectedEventKey: string | undefined;
	private eventSpans: FleetTranscriptEventSpan[] = [];
	private detailLineCount = 0;
	private detailViewportHeight = 8;
	private bodyHeight = 8;
	private readonly expandedToolKeys = new Set<string>();
	private actionNotice: FleetActionResult | undefined;
	private transcriptCache: FleetTranscriptCache | undefined;
	private readonly agentCache = new Map<string, AgentConfig | null>();
	private readonly avatarRenderer: FleetAvatarRenderer;
	private readonly keymap = createPiSwarmKeymap();
	private disposed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly tui: FleetTui;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly state: SubagentState;
	private readonly done: (result: FleetPromptRequest | undefined) => void;
	private readonly options: FleetViewOptions;

	constructor(
		tui: FleetTui,
		theme: Theme,
		state: SubagentState,
		done: (result: FleetPromptRequest | undefined) => void,
		options: FleetViewOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.avatarRenderer = new FleetAvatarRenderer(theme);
		this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
		this.state = state;
		this.done = done;
		this.options = options;
		this.selectedKey = options.initialKey;
		this.refresh();
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.invalidate();
			this.tui.requestRender();
		}, options.refreshMs ?? REFRESH_MS);
		this.timer.unref?.();
	}

	private refresh(): void {
		const previousKey = this.snapshot.items[this.selected]?.key ?? this.selectedKey;
		this.snapshot = collectFleetSnapshot(this.state, this.options);
		const preserved = previousKey ? this.snapshot.items.findIndex((item) => item.key === previousKey) : -1;
		this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.snapshot.items.length - 1));
		this.selectedKey = this.snapshot.items[this.selected]?.key;
	}

	private moveSelection(delta: number): void {
		if (this.snapshot.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.snapshot.items.length - 1, this.selected + delta));
		this.selectedKey = this.snapshot.items[this.selected]?.key;
		this.detailAutoFollow = true;
		this.detailScroll = 0;
		this.selectedEventKey = undefined;
		this.eventSpans = [];
		this.actionNotice = undefined;
		this.tui.requestRender();
	}

	private selectedAsyncAction(): { item: Extract<FleetItem, { kind: "async" }> } | { reason: string } {
		const item = this.snapshot.items[this.selected];
		if (!item) return { reason: "No child is selected." };
		if (item.kind !== "async") return { reason: "Fleet controls are available for current-session top-level async runs only." };
		if (!isActionableAsyncState(item.run.state) || !isActionableAsyncState(item.state)) return { reason: `Selected child is ${item.state}; controls require a running or queued async child.` };
		return { item };
	}

	private selectedSteerAction(): { item: Extract<FleetItem, { kind: "async" | "foreground-active" }> } | { reason: string } {
		const item = this.snapshot.items[this.selected];
		if (!item) return { reason: "No child is selected." };
		if (item.kind === "async") return this.selectedAsyncAction();
		if (item.kind !== "foreground-active") return { reason: `Selected child is ${item.state}; only active children can be steered.` };
		const index = item.index ?? item.control.currentIndex ?? 0;
		if (!foregroundSteerAvailable(item.control, index)) return { reason: "Selected foreground child does not support live steering yet." };
		return { item };
	}

	private actionLines(): string[] {
		return this.actionNotice
			? [this.theme.fg(this.actionNotice.isError ? "error" : "success", this.actionNotice.text)]
			: [];
	}

	private withActionLines(body: string[]): string[] {
		const actionLines = this.actionLines();
		return actionLines.length ? [...actionLines, "", ...body] : body;
	}

	private setActionNotice(result: FleetActionResult): void {
		this.actionNotice = result;
		this.detailAutoFollow = false;
		this.detailScroll = 0;
		this.refresh();
		this.tui.requestRender();
	}

	private scrollDetail(delta: number): void {
		const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
		this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll + delta));
		this.detailAutoFollow = this.detailMode === "live" && this.detailScroll >= maxScroll;
		this.tui.requestRender();
	}

	private scrollStart(): void {
		this.detailScroll = 0;
		this.detailAutoFollow = false;
		this.tui.requestRender();
	}

	private scrollEnd(follow = false): void {
		this.detailScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
		this.detailAutoFollow = this.detailMode === "live" && follow;
		if (this.detailAutoFollow && this.focus === "detail") {
			this.selectedEventKey = this.eventSpans.at(-1)?.key;
			this.transcriptCache = undefined;
		}
		this.tui.requestRender();
	}

	private cycleDetailMode(): void {
		this.detailMode = this.detailMode === "live" ? "agent" : "live";
		this.detailScroll = 0;
		this.detailAutoFollow = this.detailMode === "live";
		this.selectedEventKey = undefined;
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	private toggleFocus(): void {
		this.focus = this.focus === "roster" ? "detail" : "roster";
		if (this.focus === "roster") this.selectedEventKey = undefined;
		else if (this.detailMode === "live") this.selectedEventKey = this.eventSpans.at(-1)?.key;
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	private moveDetailSelection(delta: number): void {
		if (this.detailMode !== "live" || this.eventSpans.length === 0) return;
		const current = Math.max(0, this.eventSpans.findIndex((span) => span.key === this.selectedEventKey));
		const next = this.eventSpans[Math.max(0, Math.min(this.eventSpans.length - 1, current + delta))];
		if (!next) return;
		this.selectedEventKey = next.key;
		this.detailAutoFollow = next === this.eventSpans.at(-1);
		this.detailScroll = Math.max(0, Math.min(next.startLine, Math.max(0, this.detailLineCount - this.detailViewportHeight)));
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	private toggleSelectedTool(): void {
		const span = this.eventSpans.find((candidate) => candidate.key === this.selectedEventKey);
		if (!span || span.kind !== "tool") return;
		if (this.expandedToolKeys.has(span.key)) this.expandedToolKeys.delete(span.key);
		else this.expandedToolKeys.add(span.key);
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	private selectedAgentDefinition(item: FleetItem): AgentConfig | undefined {
		const cwd = itemWorkingDirectory(item, this.state);
		const name = itemAgentName(item);
		const key = `${cwd}\0${name}`;
		if (this.agentCache.has(key)) return this.agentCache.get(key) ?? undefined;
		try {
			const agents = this.options.agents ?? discoverAgents(cwd, "both").agents;
			const resolved = resolveAgentName(name, agents).agent;
			this.agentCache.set(key, resolved ?? null);
			return resolved;
		} catch {
			this.agentCache.set(key, null);
			return undefined;
		}
	}

	private hintAvailable(action: PiSwarmPanelAction): boolean {
		if (action === "steer") return this.options.actions !== undefined && !("reason" in this.selectedSteerAction());
		if (action === "stop") return this.options.actions !== undefined && !("reason" in this.selectedAsyncAction());
		if (action === "follow") return this.detailMode === "live";
		if (action === "expandTools") return this.focus === "detail";
		if (action === "confirm") return true;
		return true;
	}

	handleInput(data: string): void {
		if (this.keymap.matches(data, "close")) {
			const escapeOnly = data === "\x1b";
			if (escapeOnly && this.focus === "detail") {
				this.focus = "roster";
				this.selectedEventKey = undefined;
				this.transcriptCache = undefined;
				this.tui.requestRender();
				return;
			}
			this.done(undefined);
			return;
		}
		if (this.keymap.matches(data, "toggleView")) return this.toggleFocus();
		if (this.keymap.matches(data, "cycleView")) return this.cycleDetailMode();
		if (this.keymap.matches(data, "scrollUp")) return this.scrollDetail(-1);
		if (this.keymap.matches(data, "scrollDown")) return this.scrollDetail(1);
		if (this.keymap.matches(data, "selectUp")) return this.focus === "detail" ? this.moveDetailSelection(-1) : this.moveSelection(-1);
		if (this.keymap.matches(data, "selectDown")) return this.focus === "detail" ? this.moveDetailSelection(1) : this.moveSelection(1);
		if (this.keymap.matches(data, "scrollStart")) return this.scrollStart();
		if (this.keymap.matches(data, "scrollEnd")) return this.scrollEnd(true);
		if (this.keymap.matches(data, "pageUp")) return this.scrollDetail(-this.detailViewportHeight);
		if (this.keymap.matches(data, "pageDown")) return this.scrollDetail(this.detailViewportHeight);
		if (this.keymap.matches(data, "follow")) {
			if (this.detailMode !== "live") {
				this.setActionNotice({ text: "Follow is only available in the live view; press Tab to switch back.", isError: true });
				return;
			}
			// Follow is an idempotent "latest" command. Scrolling upward pauses it;
			// pressing f always returns to the tail and resumes future updates.
			this.scrollEnd(true);
			return;
		}
		if (this.keymap.matches(data, "refresh")) {
			this.transcriptCache = undefined;
			this.agentCache.clear();
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (this.keymap.matches(data, "steer")) {
			const target = this.selectedSteerAction();
			if ("reason" in target || !this.options.actions) this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
			else {
				this.done(this.promptRequest("steer", target.item));
			}
			return;
		}
		if (this.keymap.matches(data, "stop")) {
			const target = this.selectedAsyncAction();
			if ("reason" in target || !this.options.actions) this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
			else {
				this.done(this.promptRequest("stop", target.item));
			}
			return;
		}
		if (this.keymap.matches(data, "confirm") || this.keymap.matches(data, "expandTools")) {
			const expandRequested = this.keymap.matches(data, "expandTools");
			if (this.focus === "roster") {
				this.focus = "detail";
				this.selectedEventKey = expandRequested
					? [...this.eventSpans].reverse().find((span) => span.kind === "tool")?.key
					: this.eventSpans.at(-1)?.key;
				this.transcriptCache = undefined;
				if (expandRequested && this.selectedEventKey) this.toggleSelectedTool();
				else this.tui.requestRender();
				return;
			}
			this.toggleSelectedTool();
		}
	}

	private promptRequest(kind: FleetPromptRequest["kind"], item: Extract<FleetItem, { kind: "async" | "foreground-active" }>): FleetPromptRequest {
		return {
			kind,
			itemKey: item.key,
			runId: item.runId,
			...(item.kind === "async" ? { asyncDir: item.run.asyncDir, source: "async" as const } : { source: "foreground" as const }),
			...(item.index !== undefined ? { index: item.index } : {}),
			agent: itemAgentName(item),
		};
	}

	private rosterLines(width: number): string[] {
		if (this.snapshot.items.length === 0) return [this.theme.fg("dim", "No tracked children")];
		const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.snapshot.items.length - this.bodyHeight)));
		return this.snapshot.items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const marker = selectionMarker(index === this.selected, this.theme);
			const context = item.kind === "async" ? contextModeBadge(this.theme, item.step?.context ?? item.run.context) : item.kind === "foreground-recent" ? contextModeBadge(this.theme, item.child.context) : "";
			const profile = itemIdentity(item, this.options.language);
			const name = index === this.selected ? this.theme.bold(profile.name) : profile.name;
			const task = item.description?.replace(/\s+/g, " ").trim() || item.runId.slice(0, 8);
			const left = `${marker} ${statusGlyph(item, this.theme)} ${name} ${this.theme.fg("muted", itemAgentName(item))}${context} ${this.theme.fg("dim", `· ${task}`)}`;
			return fit(left, width);
		});
	}

	private renderedTranscript(target: { path: string; trustedRoots: string[] }, width: number): { transcript: FleetTranscript; body: string[]; eventSpans: FleetTranscriptEventSpan[] } {
		const fingerprint = `${target.trustedRoots.join("\0")}|${transcriptFingerprint(target.path)}`;
		const expandedSignature = [...this.expandedToolKeys].sort().join("\0");
		if (this.transcriptCache
			&& this.transcriptCache.path === target.path
			&& this.transcriptCache.fingerprint === fingerprint
			&& this.transcriptCache.width === width
			&& this.transcriptCache.expandedSignature === expandedSignature
			&& this.transcriptCache.selectedEventKey === this.selectedEventKey) {
			return { transcript: this.transcriptCache.transcript, body: [...this.transcriptCache.body], eventSpans: [...this.transcriptCache.eventSpans] };
		}
		const transcript = readFleetTranscript(target.path, { trustedRoots: target.trustedRoots });
		let rendered = transcript.events.length > 0
			? renderFleetTranscriptView(transcript, width, this.theme, this.markdownTheme, {
				expandedToolKeys: this.expandedToolKeys,
				...(this.focus === "detail" && this.selectedEventKey ? { selectedEventKey: this.selectedEventKey } : {}),
			})
			: { lines: [], eventSpans: [] };
		this.eventSpans = rendered.eventSpans;
		if (this.focus === "detail") {
			const nextSelectedKey = this.detailAutoFollow
				? this.eventSpans.at(-1)?.key
				: this.eventSpans.some((span) => span.key === this.selectedEventKey) ? this.selectedEventKey : this.eventSpans.at(-1)?.key;
			if (nextSelectedKey !== this.selectedEventKey) {
				this.selectedEventKey = nextSelectedKey;
				rendered = renderFleetTranscriptView(transcript, width, this.theme, this.markdownTheme, {
					expandedToolKeys: this.expandedToolKeys,
					...(this.selectedEventKey ? { selectedEventKey: this.selectedEventKey } : {}),
				});
				this.eventSpans = rendered.eventSpans;
			}
		}
		this.transcriptCache = {
			path: target.path,
			fingerprint,
			width,
			expandedSignature,
			...(this.selectedEventKey ? { selectedEventKey: this.selectedEventKey } : {}),
			transcript,
			body: rendered.lines,
			eventSpans: rendered.eventSpans,
		};
		return { transcript, body: [...rendered.lines], eventSpans: [...rendered.eventSpans] };
	}

	private wrappedDetail(width: number): FleetDetailSections {
		const selected = this.snapshot.items[this.selected];
		const identity = selected ? itemIdentity(selected, this.options.language) : undefined;
		const header = selected && identity
			? structuredHeader(selected, identity, width, this.theme, this.avatarRenderer.render(identity))
			: [];
		if (selected && this.detailMode === "agent") {
			return {
				header,
				body: wrapDetailLines(agentDefinitionLines(this.selectedAgentDefinition(selected), selected), width, this.theme),
				activity: "definition",
			};
		}
		let transcriptWarning: string | undefined;
		if (selected) {
			const target = transcriptTarget(selected, this.state);
			if (target) {
				const { transcript, body, eventSpans } = this.renderedTranscript(target, width);
				transcriptWarning = transcript.warning;
				if (transcript.events.length > 0) {
					const prefixLines: string[] = [];
					if (this.snapshot.error) prefixLines.push(this.theme.fg("warning", `Fleet scan warning: ${this.snapshot.error}`), "");
					const actionLines = this.actionLines();
					if (actionLines.length) prefixLines.push(...actionLines, "");
					this.eventSpans = eventSpans.map((span) => ({ ...span, startLine: span.startLine + prefixLines.length, endLine: span.endLine + prefixLines.length }));
					body.unshift(...prefixLines);
					const latest = transcript.events.at(-1);
					const activity = latest?.kind === "assistant"
						? "assistant response"
						: latest?.kind === "user"
							? "supervisor message"
							: latest?.kind === "tool"
								? `${latest.name} · ${latest.status}`
								: "activity";
					return { header, body, activity };
				}
			}
		}

		const raw = detailLines(selected, this.snapshot.error);
		if (transcriptWarning) raw.unshift(`Transcript preview warning: ${transcriptWarning}`, "");
		return { header, body: this.withActionLines(wrapDetailLines(raw, width, this.theme)), activity: "activity" };
	}

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth("Subagent fleet needs at least 36 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		if (rows < 10) {
			const selected = this.snapshot.items[this.selected];
			const compact = [
				this.theme.bold(this.options.language === "zh" ? "子 Agent 平台 · 实时" : "Subagents Platform · Live"),
				selected ? `${statusGlyph(selected, this.theme)} ${itemIdentity(selected, this.options.language).name} · ${selected.state}` : "No tracked children",
				this.theme.fg("dim", "q/Esc close"),
			];
			return compact.slice(0, Math.max(1, rows)).map((line) => truncateToWidth(line, width));
		}
		this.bodyHeight = Math.max(2, Math.min(30, Math.floor(rows * 0.85) - 6));
		if (width < 88) {
			const maxOverlayLines = Math.max(7, Math.floor(rows * 0.85));
			const totalBodyHeight = Math.max(3, maxOverlayLines - 6);
			const rosterHeight = Math.max(1, Math.min(5, Math.floor(totalBodyHeight * 0.32)));
			const detailHeight = Math.max(2, totalBodyHeight - rosterHeight);
			this.bodyHeight = rosterHeight;
			const roster = this.rosterLines(innerWidth);
			const detail = this.wrappedDetail(innerWidth);
			const detailHeader = detail.header.slice(0, Math.max(0, detailHeight - 2));
			this.detailViewportHeight = Math.max(1, detailHeight - detailHeader.length - 2);
			this.detailLineCount = detail.body.length;
			const maxDetailScroll = Math.max(0, detail.body.length - this.detailViewportHeight);
			if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
			else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
			const firstVisible = detail.body.length === 0 ? 0 : this.detailScroll + 1;
			const lastVisible = Math.min(detail.body.length, this.detailScroll + this.detailViewportHeight);
			const followState = this.detailMode === "live" ? `${this.focus === "detail" ? "detail" : "agents"} · ${this.detailAutoFollow ? "follow" : "paused"}` : "definition";
			const detailStatus = rightAlign(
				` ${this.theme.bold(this.detailMode === "live" ? "Live" : "Agent")}${detail.activity ? ` ${this.theme.fg("dim", `· ${detail.activity}`)}` : ""}`,
				this.theme.fg("dim", `${followState} · ${firstVisible}-${lastVisible}/${detail.body.length} `),
				innerWidth,
			);
			const detailDivider = this.theme.fg("borderMuted", "─".repeat(innerWidth));
			const visibleDetails = [
				...detailHeader,
				detailDivider,
				detailStatus,
				...detail.body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
			];
			const selected = this.snapshot.items[this.selected];
			const title = ` ${this.theme.bold(this.options.language === "zh" ? "子 Agent 平台 · 实时" : "Subagents Platform · Live")}`;
			const selectedStatus = selected
				? `${statusGlyph(selected, this.theme)} ${itemIdentity(selected, this.options.language).name} · ${selected.state} `
				: this.theme.fg("dim", "no children ");
			const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
			lines.push(this.theme.fg("border", "│") + rightAlign(title, selectedStatus, innerWidth) + this.theme.fg("border", "│"));
			lines.push(this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
			for (let index = 0; index < rosterHeight; index++) lines.push(this.theme.fg("border", "│") + fit(roster[index] ?? "", innerWidth) + this.theme.fg("border", "│"));
			lines.push(this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
			for (let index = 0; index < detailHeight; index++) lines.push(this.theme.fg("border", "│") + fit(visibleDetails[index] ?? "", innerWidth) + this.theme.fg("border", "│"));
			lines.push(this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
			const position = this.snapshot.items.length ? `${this.selected + 1}/${this.snapshot.items.length}` : "0/0";
			const footer = panelHintBar(this.keymap, FLEET_HINT_ORDER, (action) => this.hintAvailable(action), position);
			lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
			lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
			return lines.map((line) => truncateToWidth(line, width));
		}
		const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const detail = this.wrappedDetail(detailWidth);
		const detailHeader = detail.header.slice(0, Math.max(0, this.bodyHeight - 2));
		this.detailViewportHeight = Math.max(1, this.bodyHeight - detailHeader.length - 2);
		this.detailLineCount = detail.body.length;
		const maxDetailScroll = Math.max(0, detail.body.length - this.detailViewportHeight);
		if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
		else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
		const firstVisible = detail.body.length === 0 ? 0 : this.detailScroll + 1;
		const lastVisible = Math.min(detail.body.length, this.detailScroll + this.detailViewportHeight);
		const followState = this.detailMode === "live" ? `${this.focus === "detail" ? "detail" : "agents"} · ${this.detailAutoFollow ? "follow" : "paused"}` : "definition";
		const detailStatus = rightAlign(
			` ${this.theme.bold(this.detailMode === "live" ? "Live" : "Agent")}${detail.activity ? ` ${this.theme.fg("dim", `· ${detail.activity}`)}` : ""}`,
			this.theme.fg("dim", `${followState} · ${firstVisible}-${lastVisible}/${detail.body.length} `),
			detailWidth,
		);
		const detailDivider = this.theme.fg("borderMuted", "─".repeat(detailWidth));
		const visibleDetails = [
			...detailHeader,
			detailDivider,
			detailStatus,
			...detail.body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
		];
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		const selected = this.snapshot.items[this.selected];
		const title = ` ${this.theme.bold(this.options.language === "zh" ? "子 Agent 平台 · 实时" : "Subagents Platform · Live")}`;
		const selectedStatus = selected
			? `${statusGlyph(selected, this.theme)} ${itemIdentity(selected, this.options.language).name} · ${selected.state} `
			: this.theme.fg("dim", "no children ");
		lines.push(this.theme.fg("border", "│") + rightAlign(title, selectedStatus, innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index++) {
			lines.push(
				this.theme.fg("border", "│")
				+ fit(roster[index] ?? "", rosterWidth)
				+ this.theme.fg("border", "│")
				+ fit(visibleDetails[index] ?? "", detailWidth)
				+ this.theme.fg("border", "│"),
			);
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const position = this.snapshot.items.length ? `${this.selected + 1}/${this.snapshot.items.length}` : "0/0";
		const footer = panelHintBar(this.keymap, FLEET_HINT_ORDER, (action) => this.hintAvailable(action), position);
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.transcriptCache = undefined;
		this.avatarRenderer.invalidate();
		this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

export async function openSubagentFleet(ctx: ExtensionContext, state: SubagentState, options: FleetViewOptions = {}): Promise<void> {
	const wasOpen = state.fleetInspectorOpen === true;
	state.fleetInspectorOpen = true;
	const actions = options.actions ?? {
		steer: async (input: { runId: string; asyncDir?: string; index?: number; source: "async" | "foreground"; message: string }) => input.source === "foreground"
			? steerForegroundRun({ control: state.foregroundControls.get(input.runId), index: input.index ?? 0, message: input.message })
			: firstToolResultText(await steerAsyncRun({
				state,
				runId: input.runId,
				...(input.index !== undefined ? { index: input.index } : {}),
				message: input.message,
				location: { asyncDir: input.asyncDir ?? null },
			}), `Failed to steer async run ${input.runId}.`),
		stop: (input: { runId: string; asyncDir: string; index?: number }) => firstToolResultText(stopAsyncRun(state, input.runId, undefined, { asyncDir: input.asyncDir, resolvedId: input.runId }), `Failed to stop async run ${input.runId}.`),
	} satisfies FleetActionHandlers;
	try {
		let initialKey = options.initialKey;
		while (true) {
			const request = await ctx.ui.custom<FleetPromptRequest | undefined>(
				(tui, theme, _keybindings, done) => new SubagentFleetComponent(tui, theme, state, done, { ...options, initialKey, actions }),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
				},
			);
			if (!request) break;
			initialKey = request.itemKey;
			try {
				if (request.kind === "steer") {
					const message = await ctx.ui.editor(`Steer ${request.agent}`, "");
					if (!message?.trim()) continue;
					const result = await actions.steer({
						runId: request.runId,
						...(request.asyncDir ? { asyncDir: request.asyncDir } : {}),
						...(request.index !== undefined ? { index: request.index } : {}),
						source: request.source,
						message: message.trim(),
					});
					ctx.ui.notify(result.text, result.isError ? "error" : "success");
					continue;
				}
				if (!request.asyncDir) throw new Error("Foreground stop is not supported from Fleet.");
				const confirmed = await ctx.ui.confirm(
					`Stop ${request.agent}?`,
					`Stop async run ${request.runId}. This ends the run; use interrupt when a resumable pause is required.`,
				);
				if (!confirmed) continue;
				const result = await actions.stop({
					runId: request.runId,
					asyncDir: request.asyncDir,
					...(request.index !== undefined ? { index: request.index } : {}),
				});
				ctx.ui.notify(result.text, result.isError ? "error" : "success");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
	} finally {
		state.fleetInspectorOpen = wasOpen;
	}
}
