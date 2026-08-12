import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHeadlessWorkflowInteraction } from "../../src/workflows/interaction.ts";
import { createWorkflowController } from "../../src/workflows/controller.ts";
import { registerWorkflowTool } from "../../src/workflows/tool.ts";

class FakePi {
	tools: ToolDefinition[] = [];
	registerTool(tool: ToolDefinition): void { this.tools.push(tool); }
}

function context(cwd: string, entries: unknown[]): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "session-headless", getBranch: () => entries },
		modelRegistry: { getAvailable: () => [] },
		abort() {},
	} as unknown as ExtensionContext;
}

describe("workflow headless core", () => {
	it("has no static workflow-core edge to TUI renderers or UI decision APIs", () => {
		for (const file of ["src/workflows/controller.ts", "src/workflows/controller-helpers.ts", "src/workflows/interaction.ts", "src/workflows/tool.ts"]) {
			const source = fs.readFileSync(file, "utf-8");
			assert.doesNotMatch(source, /pi-tui|\.\.\/tui\/|ctx\.ui|hasUI/, file);
		}
	});

	it("builds and executes the real workflow tool without resolving a presentation adapter", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-headless-core-"));
		try {
			const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
			const interaction = createHeadlessWorkflowInteraction({
				provider: { async decide() { return { verdict: "approve", reason: "safe", confidence: 0.99, model: "m", provider: "p" }; } },
				audit: { write() {} },
				policyVersion: "v1",
				approveThreshold: 0.9,
				timeoutMs: 50,
				traceId: () => "trace",
				evidenceSufficient: () => true,
				policyAllowsApproval: () => true,
			});
			const controller = createWorkflowController({
				interaction,
				adapter: { async run() { throw new Error("unused"); } },
				appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
				createRunId: () => "headless-run",
				now: () => 1,
				resolveBranch: () => "main",
			});
			const pi = new FakePi();
			registerWorkflowTool(pi as unknown as ExtensionAPI, controller);
			const result = await pi.tools[0]!.execute("call", { action: "start", goal: "Run headless" }, undefined, undefined, context(cwd, entries));
			assert.equal(result.details?.run.id, "headless-run");
			assert.equal(pi.tools[0]!.renderResult, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("maps all non-approval decision verdicts to blocked interaction outcomes", async () => {
		for (const verdict of ["revise", "reject", "pause", "request-more-evidence"] as const) {
			const interaction = createHeadlessWorkflowInteraction({
				provider: { async decide() { return { verdict, reason: `${verdict} safely`, confidence: 0.99, model: "m", provider: "p", structuredAnswer: { feedback: "revise safely" } }; } },
				audit: { write() {} }, policyVersion: "v1", approveThreshold: 0.9, timeoutMs: 50,
				traceId: () => `trace-${verdict}`, evidenceSufficient: () => true, policyAllowsApproval: () => true,
			});
			const review = await interaction.reviewOutline({
				ctx: {} as ExtensionContext,
				outline: { version: 0, title: "T", thesis: "T", approval: "user", sections: [] },
				language: "en",
				evidence: { verified: true },
			});
			assert.equal(review.approved, false, verdict);
			assert.equal(review.verdict, verdict);
			if (verdict === "revise") assert.equal(review.feedback, "revise safely");
		}
	});

	it("keeps plugin decisions below the platform forbidden-capability gate", async () => {
		let seenForbidden: readonly string[] = [];
		const interaction = createHeadlessWorkflowInteraction({
			provider: { async decide(request) { seenForbidden = request.forbiddenCapabilities; return { verdict: "approve", reason: "plugin only", confidence: 0.99, model: "m", provider: "p" }; } },
			audit: { write() {} }, policyVersion: "v1", approveThreshold: 0.9, timeoutMs: 50,
			traceId: () => "trace", evidenceSufficient: () => true,
			policyAllowsApproval: (request) => request.forbiddenCapabilities.includes("funds-approval") === false,
		});
		const result = await interaction.confirm({
			ctx: {} as ExtensionContext,
			kind: "checkpoint",
			title: "Plugin checkpoint",
			message: "continue?",
			evidence: { verified: true },
			forbiddenCapabilities: ["funds-approval", "sensitive-tool-approval"],
		});
		assert.equal(result.approved, false);
		assert.equal(result.verdict, "pause");
		assert.deepEqual(seenForbidden, ["funds-approval", "sensitive-tool-approval"]);
	});
});
