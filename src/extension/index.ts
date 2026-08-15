/**
 * Interactive subagent extension entry.
 *
 * Assembles the shared instance-owned core (`createExtensionCore` from
 * `./core.ts`) with the TUI-specific presentation: message renderers, the
 * Activity Dock controller, the interactive workflow/clarify interaction and
 * chain clarifier, the TUI render presentations, and the interactive slash and
 * workflow commands. The default package entry `.` resolves here.
 *
 * Headless server deployments resolve `pi-agents-flow/headless`
 * (`./headless.ts`) instead; both share the exact same core tool-registration
 * path, so there is no second scheduler or divergent copy of the shared tools.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Key, Text, type Component } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { clearLegacyResultAnimationTimer, renderSubagentResult } from "../tui/render.ts";
import { buildActivitySnapshot } from "../activity/projection.ts";
import { createActivityDockController } from "../tui/activity-dock.ts";
import { openActivityBoard } from "../tui/activity-board.ts";
import { createInteractiveExecutionClarifier } from "../runs/foreground/chain-clarify.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerWorkflowCommands } from "../workflows/commands.ts";
import { registerMainWatchdog } from "../watchdog/register-main.ts";
import { createTuiWorkflowInteraction } from "../tui/workflow-interaction-adapter.ts";
import { createWorkflowAssetsRenderer, createWorkflowToolRenderer } from "../tui/workflow-tool-renderer.ts";
import { noticePrefix, statusBadge } from "../tui/visual-language.ts";
import {
	formatSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";
import { formatSteeringNotice, SUBAGENT_STEERING_MESSAGE_TYPE, type SubagentSteeringMessageDetails } from "./steering-notices.ts";
import { getSlashRenderableSnapshot, resolveSlashMessageDetails, type SlashMessageDetails } from "../slash/slash-live-state.ts";
import { SUBAGENT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { workflowRunLanguage } from "../workflows/language.ts";
import registerSubagentNotify, { parseSubagentNotifyContent, type SubagentNotifyDetails } from "../runs/background/notify.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { SubagentParams } from "./schemas.ts";
import {
	type Details,
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SUBAGENT_STEERING_NOTICE_EVENT,
} from "../shared/types.ts";
import { createExtensionCore, type ExtensionCore, type SubagentToolPresentation } from "./core.ts";

export { loadConfig } from "./config.ts";

export type { WorkflowToolPresentation, WorkflowAssetsPresentation } from "../workflows/tool.ts";

function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function rebuildSlashResultContainer(
	container: Container,
	result: { content: unknown; details?: Details },
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result as { details?: Details }) ? "toolPendingBg" : isSlashResultError(result as { details?: Details }) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result as never, options, theme));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

class SubagentControlNoticeComponent implements Component {
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(details: SubagentControlMessageDetails, theme: ExtensionContext["ui"]["theme"]) {
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, width - 2);
		const borderChar = "─";
		const header = ` ${noticePrefix("warning")} Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}

function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
	if (!tasks || tasks.length === 0) return 0;
	return tasks.reduce((total, task) => {
		const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
		return total + count;
	}, 0);
}

function buildSubagentPresentation(): SubagentToolPresentation {
	return {
		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true && args.clarify !== true ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})${asyncLabel}`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			clearLegacyResultAnimationTimer(context);
			return renderSubagentResult(result, options, theme);
		},
	};
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}

	// Interactive-only watchdog runtime + its TUI command/renderer registration.
	const mainWatchdog = registerMainWatchdog(pi);

	createExtensionCore({
		pi,
		interaction: createTuiWorkflowInteraction(),
		clarifier: createInteractiveExecutionClarifier(),
		watchdog: mainWatchdog,
		ui: {
			presentations: (core) => ({
				workflowPresentation: createWorkflowToolRenderer(() => core.activityDock?.getSnapshot()),
				workflowAssetsPresentation: createWorkflowAssetsRenderer(),
				subagentPresentation: buildSubagentPresentation(),
			}),
			decorate: (core) => {
				// TUI message renderers.
				pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
					const details = resolveSlashMessageDetails(message.details);
					if (!details) return undefined;
					return createSlashResultComponent(details, options, theme);
				});

				pi.registerMessageRenderer<undefined>("workflow-status", (message, options, theme) => {
					const content = typeof message.content === "string"
						? message.content.trim()
						: message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n").trim();
					const lines = content.split("\n").filter(Boolean);
					const visible = options.expanded ? lines : lines.slice(0, 1);
					let text = `${theme.fg("toolTitle", theme.bold("Workflow"))} ${visible.join("\n")}`.trimEnd();
					if (!options.expanded && lines.length > 1) text += theme.fg("dim", ` · ${lines.length - 1} more`);
					return new Text(text, 0, 0);
				});

				pi.registerMessageRenderer<undefined>(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
					const content = typeof message.content === "string"
						? message.content
						: message.content
							.filter((entry) => entry.type === "text")
							.map((entry) => entry.text)
							.join("\n");
					return new Text(content, 0, 0);
				});

				pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
					const content = typeof message.content === "string" ? message.content : "";
					const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
					if (!details) return new Text(content, 0, 0);
					const icon = statusBadge(details.status, theme);
					const parts: string[] = [];
					if (details.taskInfo) parts.push(details.taskInfo);
					if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
					let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
					if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
					const trimmedPreview = details.resultPreview.trim();
					const previewLines = options.expanded
						? trimmedPreview.split("\n").filter((line) => line.trim())
						: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
					for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
						text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
					}
					if (!options.expanded && trimmedPreview.includes("\n")) {
						const expandKey = keyText("app.tools.expand");
						text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
					}
					if (details.sessionLabel && details.sessionValue) {
						text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
					}
					return new Text(text, 0, 0);
				});

				pi.registerMessageRenderer<SubagentSteeringMessageDetails>(SUBAGENT_STEERING_MESSAGE_TYPE, (message, _options, theme) => {
					const details = message.details as SubagentSteeringMessageDetails | undefined;
					if (!details) return undefined;
					return new Text(theme.fg(details.state === "recovered" ? "warning" : "error", formatSteeringNotice(details)), 0, 0);
				});

				pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
					const details = message.details as SubagentControlMessageDetails | undefined;
					if (!details?.event) return undefined;
					const content = typeof message.content === "string" ? message.content : undefined;
					return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
				});

				// Interactive Activity Dock controller.
				const activityDock = createActivityDockController({
					getSnapshot: () => {
						const ctx = core.state.lastUiContext;
						let run: ReturnType<typeof core.workflowController.current>;
						try {
							run = ctx ? core.workflowController.current(ctx) : undefined;
						} catch {
							run = undefined;
						}
						return buildActivitySnapshot(core.state, run);
					},
					openSelection: (selection, perspective) => {
						const ctx = core.state.lastUiContext;
						if (!ctx?.hasUI) return;
						return openActivityBoard(ctx, core.state, () => {
							let run: ReturnType<typeof core.workflowController.current>;
							try { run = core.workflowController.current(ctx); } catch { run = undefined; }
							return buildActivitySnapshot(core.state, run);
						}, { initialPerspective: perspective, initialKey: selection.key });
					},
				});
				core.activityDock = activityDock;

				// The dock mounts above the editor (goal-panel style), so ↓ no longer
				// enters the panel. Ctrl+Alt+A toggles expand/collapse from anywhere,
				// including while the editor already holds text.
				pi.registerShortcut(Key.ctrlAlt("a"), {
					description: "Toggle the activity dock panel",
					handler: () => activityDock.toggle(),
				});

				// Interactive slash + workflow commands.
				registerSlashCommands(pi, core.state, {
					resolveLanguage: (ctx) => {
						try {
							const run = core.workflowController.current(ctx);
							if (run) return workflowRunLanguage(run);
						} catch {
							// Fleet remains available when no workflow is bound to this session.
						}
						return core.config.workflowLanguage === "zh" ? "zh" : "en";
					},
				});
				registerWorkflowCommands(pi, core.workflowController, {
					openActivity: async (ctx, runId) => {
						await openActivityBoard(ctx, core.state, () => {
							let run: ReturnType<typeof core.workflowController.current>;
							try { run = core.workflowController.current(ctx); } catch { run = undefined; }
							return buildActivitySnapshot(core.state, run);
						}, { initialPerspective: "work" });
					},
				});
			},
		},
	});
}
