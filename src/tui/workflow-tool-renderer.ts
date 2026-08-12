import { keyText, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { buildTaskActivitiesFromRun } from "../activity/projection.ts";
import type { ActivitySnapshot } from "../activity/types.ts";
import { compactText } from "../shared/formatters.ts";
import { workflowRunLanguage } from "../workflows/language.ts";
import type { WorkflowRun } from "../workflows/types.ts";
import type { WorkflowAssetsPresentation, WorkflowToolPresentation } from "../workflows/tool.ts";
import { noticePrefix } from "./visual-language.ts";
import { renderWorkflowInlineCard, type WorkflowInlineCardInput } from "./workflow-inline-card.ts";

function compact(ctx: ExtensionContext): void {
	if (typeof ctx.ui?.setToolsExpanded === "function") ctx.ui.setToolsExpanded(false);
}

function snapshotForWorkflowCard(run: WorkflowRun, getSnapshot?: () => ActivitySnapshot | undefined): ActivitySnapshot {
	let live: ActivitySnapshot | undefined;
	try { live = getSnapshot?.(); } catch { /* keep rendering from durable run */ }
	if (live?.workflow?.runId === run.id) return live;
	return {
		version: 1,
		language: workflowRunLanguage(run),
		workflow: { runId: run.id, goal: run.goal, status: run.status, tasks: buildTaskActivitiesFromRun(run) },
		executions: [],
		independent: [],
		updatedAt: Date.now(),
	};
}

function renderWorkflowInlineCardFromRun(run: WorkflowRun, theme: Theme, getSnapshot?: () => ActivitySnapshot | undefined, expanded = false): import("@earendil-works/pi-tui").Component {
	const container = new Container();
	const lines = renderWorkflowInlineCard(
		{ runId: run.id, language: workflowRunLanguage(run), status: run.status, snapshot: snapshotForWorkflowCard(run, getSnapshot), createdAt: run.createdAt, updatedAt: run.updatedAt } as WorkflowInlineCardInput,
		theme,
		process.stdout.columns || 120,
		expanded,
	);
	for (const line of lines) container.addChild(new Text(line, 0, 0));
	return container;
}

export function createWorkflowToolRenderer(getSnapshot?: () => ActivitySnapshot | undefined): WorkflowToolPresentation {
	return {
		beforeExecute: compact,
		renderCall() { return new Text("", 0, 0); },
		renderResult(result, options, theme) {
			const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
			if (result.isError || !result.details?.run) return new Text(`${noticePrefix("error")} ${compactText(text, 96)}`, 0, 0);
			return renderWorkflowInlineCardFromRun(result.details.run, theme, getSnapshot, options.expanded);
		},
	};
}

export function createWorkflowAssetsRenderer(): WorkflowAssetsPresentation {
	return {
		beforeExecute: compact,
		renderResult(result, options, theme) {
			const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
			if (options.expanded) return new Text(text, 0, 0);
			const catalog = result.details?.catalog;
			if (!catalog) return new Text(`${noticePrefix("error")} ${compactText(text, 96)}`, 0, 0);
			const counts = `${catalog.agents.length} agents · ${catalog.skills.length} skills · ${catalog.mcpTools.length} mcp tools`;
			const total = text.split("\n").length;
			return new Text(`${theme.fg("dim", counts)}${theme.fg("muted", ` ... (${total} lines, ${keyText("app.tools.expand")} to expand)`)}`, 0, 0);
		},
	};
}
