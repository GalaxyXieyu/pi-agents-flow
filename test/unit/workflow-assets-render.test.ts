import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildAssetCatalog, formatAssetCatalog } from "../../src/workflows/asset-catalog.ts";
import { registerWorkflowAssetsTool } from "../../src/workflows/tool.ts";
import { createWorkflowAssetsRenderer } from "../../src/tui/workflow-tool-renderer.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function assetsTool(): ToolDefinition {
	let captured: ToolDefinition | undefined;
	const pi = {
		registerTool(tool: ToolDefinition) { captured = tool; },
	} as unknown as ExtensionAPI;
	registerWorkflowAssetsTool(pi, createWorkflowAssetsRenderer());
	assert.ok(captured, "expected the workflow_assets tool to be registered");
	return captured;
}

function rendered(expanded: boolean): string {
	const tool = assetsTool();
	const catalog = buildAssetCatalog(projectRoot);
	const result = {
		content: [{ type: "text" as const, text: formatAssetCatalog(catalog) }],
		details: { catalog },
	};
	const component = tool.renderResult?.(
		result as never,
		{ expanded } as never,
		theme as never,
		{ lastComponent: undefined, showImages: false, cwd: projectRoot, isError: false, args: {}, state: {}, invalidate() {} } as never,
	);
	assert.ok(component, "expected renderResult to produce a component");
	return component.render(200).join("\n");
}

describe("workflow assets tool rendering", () => {
	it("collapses to counts so a large catalog cannot fill the screen", () => {
		const text = rendered(false);
		assert.match(text, /\d+ agents · \d+ skills · \d+ mcp tools/);
		assert.match(text, /\.\.\. \(\d+ lines, .*to expand\)/);
		// The per-agent detail must not be printed while collapsed.
		assert.doesNotMatch(text, /use as agentSpec\.baseAgent/);
		assert.doesNotMatch(text, /research-reviewer/);
		assert.ok(text.split("\n").length <= 2, `collapsed render should stay tiny, got:\n${text}`);
	});

	it("shows the whole catalog once expanded", () => {
		const text = rendered(true);
		assert.match(text, /Agents \(\d+\) - use as agentSpec\.baseAgent/);
		assert.match(text, /Skills \(\d+\) - use as agentSpec\.skills/);
		assert.match(text, /MCP tools \(\d+\)/);
		assert.match(text, /^- scout \[/m);
		// Hidden-but-model-invocable roles are now surfaced for Supervisor composition.
		for (const role of ["worker", "reviewer", "planner", "research-reviewer"]) {
			assert.match(text, new RegExp(`^- ${role} \\[`, "m"), `expected model-invocable role '${role}'`);
		}
		assert.ok(text.split("\n").length > 10, "expanded render should include the full discoverable catalog");
	});

	it("still hands the model the full catalog regardless of display state", async () => {
		const tool = assetsTool();
		const output = await tool.execute?.(
			"call-1",
			{},
			new AbortController().signal,
			undefined as never,
			{ cwd: projectRoot } as never,
		);
		const text = output?.content.find((entry) => entry.type === "text")?.text ?? "";
		// Collapsing is a rendering concern only; the model receives every discoverable asset.
		assert.match(text, /Agents \(\d+\) - use as agentSpec\.baseAgent/);
		assert.match(text, /^- scout \[/m);
		// Hidden-but-model-invocable roles reach the model unchanged by display state.
		assert.match(text, /^- planner \[/m);
		assert.match(text, /^- research-reviewer \[/m);
	});
});
