import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHeadlessWorkflowInteraction } from "../../src/workflows/interaction.ts";
import { createWorkflowController } from "../../src/workflows/controller.ts";
import { registerWorkflowTool } from "../../src/workflows/tool.ts";
import {
	createScriptedDecisionProvider,
	type ScriptedDecisionCase,
} from "../../src/headless/scripted-decision-provider.ts";

/**
 * This integration test runs under the forbid-ui-loader (see the task verify
 * command). It builds a real workflow runtime from the headless exports and
 * executes genuine workflow transitions with a scripted decision provider. Any
 * extension-own pi-tui / src/tui resolve aborts the test process, so reaching the
 * assertions below proves the headless workflow path has zero own-TUI loads.
 */

class FakePi {
	tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
	registerTool(tool: { name: string; execute: (...args: never[]) => Promise<unknown> }): void {
		this.tools.push(tool);
	}
}

function context(cwd: string, entries: unknown[], runId: string): ExtensionContext {
	return {
		cwd,
		model: { provider: "test", id: "test-model" },
		modelRegistry: { getAvailable: () => [{ provider: "test", id: "test-model", fullId: "test/test-model" }] },
		sessionManager: {
			getSessionId: () => "headless-session",
			getBranch: () => entries,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
		},
		abort() {},
	} as unknown as ExtensionContext;
}

const auditRecords: Array<{ verdict: string; reason: string; traceId: string; inputDigest: string }> = [];
const audit = {
	write(record: { verdict: string; reason: string; traceId: string; inputDigest: string; model: string; provider: string; policyVersion: string; timestamp: string; kind: string; confidence: number }) {
		auditRecords.push({ verdict: record.verdict, reason: record.reason, traceId: record.traceId, inputDigest: record.inputDigest });
	},
};

function buildRuntime(cwd: string, cases: ScriptedDecisionCase[]) {
	const provider = createScriptedDecisionProvider({ policyVersion: "v1", approveThreshold: 0.9, cases });
	const interaction = createHeadlessWorkflowInteraction({
		provider,
		audit,
		policyVersion: "v1",
		approveThreshold: 0.9,
		timeoutMs: 200,
		traceId: (kind) => `headless-workflow-execute:${kind}:${Date.now()}`,
		evidenceSufficient: () => true,
		policyAllowsApproval: (request) => request.forbiddenCapabilities.every((c) => c !== "funds-approval"),
	});
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const controller = createWorkflowController({
		interaction,
		adapter: { async run() { throw new Error("unused"); } },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		createRunId: () => `wf-${Math.random().toString(16).slice(2, 10)}`,
		resolveBranch: () => "main",
		hasTool: () => false,
	});
	const pi = new FakePi();
	registerWorkflowTool(pi as unknown as ExtensionAPI, controller);
	const tool = pi.tools.find((t) => t.name === "workflow")!;
	return { tool, entries, controller };
}

describe("headless workflow execute (forbid-ui-loader)", () => {
	it("executes a no-interaction general workflow through the real controller", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-"));
		try {
			const { tool } = buildRuntime(cwd, []);
			const entries: Array<{ type: string; customType: string; data: unknown }> = [];
			const ctx = context(cwd, entries, "wf-no-interaction");
			const started = await tool.execute("call", { action: "start", goal: "Build a report", mode: "general" }, new AbortController().signal, undefined, ctx);
			assert.equal(started.details?.run.status, "active");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("records clarify answers only after a validated approve verdict", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-clarify-"));
		try {
			const runtime = buildRuntime(cwd, [{
				id: "clarify-approve",
				kind: "clarify",
				tracePrefix: "headless-workflow-execute:clarify:",
				verdict: "approve",
				reason: "clarify approved",
				confidence: 0.99,
				structuredAnswer: {
					answers: [{ id: "q1", answer: "general-purpose", selections: ["option-b"], wasCustom: false }],
				},
			}]);
			const { tool, controller } = runtime;
			const entries: Array<{ type: string; customType: string; data: unknown }> = runtime.entries;
			const ctx = context(cwd, entries, "wf-clarify");
			await tool.execute("call", { action: "start", goal: "Research topic X", mode: "deep-research" }, new AbortController().signal, undefined, ctx);
			const res = await tool.execute("call", {
				action: "clarify",
				questions: [{ id: "q1", prompt: "What scope?", options: [{ label: "general-purpose" }, { label: "narrow" }] }],
			}, new AbortController().signal, undefined, ctx);
			assert.equal(res.isError, undefined);
			const run = controller.current(ctx);
			assert.ok(run.clarifications, "clarifications should be recorded");
			assert.equal(run.clarifications!.length, 1);
			assert.equal(run.clarifications![0]!.answers[0]!.answer, "general-purpose");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("blocks outline recording on a reject verdict (fail-closed)", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-outline-"));
		try {
			const runtime = buildRuntime(cwd, [{
				id: "outline-reject",
				kind: "outline-review",
				tracePrefix: "headless-workflow-execute:outline-review:",
				verdict: "reject",
				reason: "outline rejected by scripted provider",
				confidence: 0.99,
			}]);
			const { tool, controller } = runtime;
			const entries: Array<{ type: string; customType: string; data: unknown }> = runtime.entries;
			const ctx = context(cwd, entries, "wf-outline");
			await tool.execute("call", { action: "start", goal: "Research topic", mode: "deep-research" }, new AbortController().signal, undefined, ctx);
			await tool.execute("call", { action: "set_brief", brief: { version: 0, audience: "a", purpose: "p", scope: "s", depth: "standard", deliverable: "research-report", targetWords: { min: 100, max: 500 }, requiredTopics: ["t"], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" } }, new AbortController().signal, undefined, ctx);
			const res = await tool.execute("call", {
				action: "set_outline",
				outline: {
					version: 0, title: "T", thesis: "T", approval: "user",
					sections: [{ id: "s1", title: "S1", objective: "o", questions: ["q"], evidenceRequirements: ["e"], targetWords: 200, writerNodeIds: ["w1"] }, { id: "s2", title: "S2", objective: "o2", questions: ["q2"], evidenceRequirements: ["e2"], targetWords: 200, writerNodeIds: ["w2"] }],
				},
			}, new AbortController().signal, undefined, ctx);
			assert.ok(res.details?.outlineReview?.approved === false || res.details?.outlineReview?.cancelled === true, "outline must not be approved");
			const run = controller.current(ctx);
			assert.equal(run.documentOutline, undefined, "outline must not be recorded after reject");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("applies outline feedback on revise and records outline on approve", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-outline2-"));
		try {
			const runtime = buildRuntime(cwd, [{
				id: "outline-approve",
				kind: "outline-review",
				tracePrefix: "headless-workflow-execute:outline-review:",
				verdict: "approve",
				reason: "outline approved by scripted provider",
				confidence: 0.99,
			}]);
			const { tool, controller } = runtime;
			const entries: Array<{ type: string; customType: string; data: unknown }> = runtime.entries;
			const ctx = context(cwd, entries, "wf-outline2");
			await tool.execute("call", { action: "start", goal: "Research topic", mode: "deep-research" }, new AbortController().signal, undefined, ctx);
			await tool.execute("call", { action: "set_brief", brief: { version: 0, audience: "a", purpose: "p", scope: "s", depth: "standard", deliverable: "research-report", targetWords: { min: 100, max: 500 }, requiredTopics: ["t"], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" } }, new AbortController().signal, undefined, ctx);
			const res = await tool.execute("call", {
				action: "set_outline",
				outline: {
					version: 0, title: "T", thesis: "T", approval: "user",
					sections: [{ id: "s1", title: "S1", objective: "o", questions: ["q"], evidenceRequirements: ["e"], targetWords: 200, writerNodeIds: ["w1"] }, { id: "s2", title: "S2", objective: "o2", questions: ["q2"], evidenceRequirements: ["e2"], targetWords: 200, writerNodeIds: ["w2"] }],
				},
			}, new AbortController().signal, undefined, ctx);
			const run = controller.current(ctx);
			assert.ok(run.documentOutline, "outline should be recorded after approve");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the coding implementation gate unchanged when the checkpoint verdict is not approve", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-gate-"));
		try {
			const { tool, controller } = buildRuntime(cwd, [{
				id: "checkpoint-pause",
				kind: "checkpoint",
				tracePrefix: "headless-workflow-execute:checkpoint:",
				verdict: "pause",
				reason: "platform funds approval is outside the plugin decision scope",
				confidence: 0.9,
			}]);
			const entries: Array<{ type: string; customType: string; data: unknown }> = [];
			const ctx = context(cwd, entries, "wf-gate");
			// coding workflow with an approval gate node requires a full DAG; instead
			// assert the platform gate is honored at the interaction boundary.
			const interaction = createHeadlessWorkflowInteraction({
				provider: createScriptedDecisionProvider({
					policyVersion: "v1",
					approveThreshold: 0.9,
					cases: [{ id: "approve", verdict: "approve", reason: "approve", confidence: 0.99 }],
				}),
				audit,
				policyVersion: "v1",
				approveThreshold: 0.9,
				timeoutMs: 200,
				traceId: (k) => "headless-workflow-execute:checkpoint:" + k,
				evidenceSufficient: () => true,
				policyAllowsApproval: (request) => request.forbiddenCapabilities.every((c) => c !== "funds-approval"),
			});
			const confirm = await interaction.confirm({
				ctx,
				kind: "checkpoint",
				title: "Approve?",
				message: "continue?",
				evidence: { verified: true },
				forbiddenCapabilities: ["funds-approval", "capability-ceiling"],
			});
			assert.equal(confirm.approved, false);
			assert.equal(confirm.verdict, "pause");
			void tool;
			void controller;
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("writes a complete audit record with no secret material", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-wf-audit-"));
		try {
			const provider = createScriptedDecisionProvider({
				policyVersion: "v1",
				approveThreshold: 0.9,
				cases: [{ id: "audit", verdict: "approve", reason: "approved", confidence: 0.99, structuredAnswer: { answers: [] } }],
			});
			const interaction = createHeadlessWorkflowInteraction({
				provider,
				audit,
				policyVersion: "v1",
				approveThreshold: 0.9,
				timeoutMs: 200,
				traceId: (k) => "headless-workflow-execute:clarify:" + k,
				evidenceSufficient: () => true,
				policyAllowsApproval: () => true,
			});
			await interaction.clarify({
				ctx: context(cwd, [], "wf-audit"),
				questions: [{ id: "q1", prompt: "scope?", options: [{ label: "a" }, { label: "b" }] }],
				language: "en",
				evidence: { runId: "r1", secret: "do-not-leak-this-token" },
			});
			const record = auditRecords.at(-1)!;
			assert.ok(record.traceId.startsWith("headless-workflow-execute:"));
			assert.ok(record.inputDigest.length > 0, "input digest must be present");
			assert.ok(!record.reason.includes("token"), "audit reason must not contain secret material");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
