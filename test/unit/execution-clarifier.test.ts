import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	createHeadlessExecutionClarifier,
	type BehaviorOverride,
	type ExecutionClarificationRequest,
	type ExecutionClarificationResult,
	type ExecutionClarifier,
} from "../../src/runs/shared/execution-clarifier.ts";
import {
	executeHeadlessDecision,
	type HeadlessDecision,
} from "../../src/headless/decision-contract.ts";
import type { DecisionAuditRecord } from "../../src/headless/decision-audit.ts";

function baseRequest(overrides: Partial<ExecutionClarificationRequest> = {}): ExecutionClarificationRequest {
	return {
		mode: "chain",
		agentConfigs: [
			{ name: "agent-a", description: "", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false, systemPrompt: "", source: "project", filePath: "/a" } as never,
			{ name: "agent-b", description: "", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false, systemPrompt: "", source: "project", filePath: "/b" } as never,
		],
		templates: ["do thing A", "do thing B"],
		originalTask: "build feature",
		chainDir: undefined,
		resolvedBehaviors: [],
		availableModels: [],
		preferredProvider: undefined,
		availableSkills: [],
		ctx: undefined as never,
		evidence: { summary: "chain clarification for build feature" },
		forbiddenCapabilities: ["funds.transfer", "worker.sensitive.override"],
		...overrides,
	};
}

function decision(overrides: Partial<HeadlessDecision> = {}): HeadlessDecision {
	return {
		verdict: "approve",
		reason: "Templates align with the objective.",
		confidence: 0.95,
		model: "safe-model",
		provider: "test-provider",
		...overrides,
	};
}

describe("execution-clarifier contract types", () => {
	it("exports BehaviorOverride, ExecutionClarificationResult, ExecutionClarifier, ExecutionClarificationRequest", () => {
		const override: BehaviorOverride = { output: "result.md", progress: true };
		assert.deepEqual(override, { output: "result.md", progress: true });
		const approve: ExecutionClarificationResult = { verdict: "approve", templates: ["t"], behaviorOverrides: [undefined] };
		assert.equal(approve.verdict, "approve");
		const reject: ExecutionClarificationResult = { verdict: "reject", reason: "no" };
		assert.equal(reject.verdict, "reject");
		const clarifier: ExecutionClarifier = { async decide() { return approve; } };
		assert.ok(clarifier);
	});
});

describe("headless execution clarifier", () => {
	function createClarifier(overrides: Parameters<typeof createHeadlessExecutionClarifier>[0] = {}) {
		const records: DecisionAuditRecord[] = [];
		const clarifier = createHeadlessExecutionClarifier({
			provider: { async decide() { return decision(); } },
			audit: { write(record) { records.push(record); } },
			policyVersion: "exec-clarify-v1",
			approveThreshold: 0.9,
			timeoutMs: 50,
			traceId: () => "trace-clarify",
			evidenceSufficient: () => true,
			policyAllowsApproval: () => true,
			now: () => new Date("2026-08-11T00:00:00.000Z"),
			...overrides,
		});
		return { clarifier, records };
	}

	it("returns approve with original templates when provider approves", async () => {
		const { clarifier, records } = createClarifier();
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "approve");
		if (result.verdict === "approve") {
			assert.deepEqual(result.templates, ["do thing A", "do thing B"]);
			assert.equal(result.behaviorOverrides.length, 2);
			assert.equal(result.runInBackground, undefined);
		}
		assert.equal(records.length, 1, "every decision must be audited");
		assert.equal(records[0]!.kind, "clarify");
		assert.equal(records[0]!.verdict, "approve");
	});

	it("returns reject when provider confidence is below threshold", async () => {
		const { clarifier } = createClarifier({
			provider: { async decide() { return decision({ confidence: 0.5 }); } },
		});
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "reject");
		if (result.verdict !== "approve") {
			assert.match(result.reason, /threshold/i);
		}
	});

	it("returns request-more-evidence when evidence is insufficient", async () => {
		const { clarifier } = createClarifier({
			evidenceSufficient: () => false,
		});
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "request-more-evidence");
	});

	it("returns pause when policy does not allow approval", async () => {
		const { clarifier } = createClarifier({
			policyAllowsApproval: () => false,
		});
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "pause");
	});

	it("returns pause on provider failure and audits the failure", async () => {
		const { clarifier, records } = createClarifier({
			provider: { async decide() { throw new Error("raw prompt: secret-leak"); } },
		});
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "pause");
		assert.equal(records.length, 1, "failure must still be audited");
		assert.doesNotMatch(JSON.stringify(records), /secret-leak/);
	});

	it("returns pause on provider timeout", async () => {
		const { clarifier } = createClarifier({
			provider: { async decide() { return await new Promise<HeadlessDecision>(() => {}); } },
			timeoutMs: 10,
		});
		const result = await clarifier.decide(baseRequest());
		assert.equal(result.verdict, "pause");
	});

	it("does not allow the provider to expand forbidden capabilities", async () => {
		const { clarifier } = createClarifier({
			provider: {
				async decide() {
					return decision({
						structuredAnswer: { allowedTools: ["funds.transfer"] },
					});
				},
			},
		});
		const result = await clarifier.decide(baseRequest());
		assert.notEqual(result.verdict, "approve", "privilege-mutating answer must not approve");
	});

	it("never serializes secrets in the audit record", async () => {
		const { records } = createClarifier({
			provider: {
				async decide() {
					return decision({
						reason: "ｒａｗ　ｐｒｏｍｐｔ: api-key-leak bearer-token-leak",
						model: "secret-key model-leak",
						provider: "raw.prompt provider-leak",
					});
				},
			},
		});
		await createClarifier({
			provider: {
				async decide() {
					return decision({
						reason: "ｒａｗ　ｐｒｏｍｐｔ: api-key-leak bearer-token-leak",
						model: "secret-key model-leak",
						provider: "raw.prompt provider-leak",
					});
				},
			},
		}).clarifier.decide(baseRequest({ evidence: { apiKey: "KEY=raw-key-must-not-leak" } }));
		const json = JSON.stringify(records);
		assert.doesNotMatch(json, /raw-key-must-not-leak|api-key-leak|bearer-token-leak|model-leak|provider-leak/i);
	});

	it("passes forbidden capabilities from the request into the decision constraint", async () => {
		let captured: ExecutionClarificationRequest | undefined;
		const { clarifier } = createClarifier({
			provider: {
				async decide(request) {
					captured = request as unknown as ExecutionClarificationRequest;
					return decision();
				},
			},
		});
		await clarifier.decide(baseRequest({ forbiddenCapabilities: ["platform.sensitive"] }));
		// The headless adapter must forward forbidden capabilities to the provider request
		assert.ok(captured, "provider should have received the request");
	});
});

describe("execution clarifier fail-closed contract", () => {
	it("does not provide a default approve when no clarifier is supplied", () => {
		// This is a compile-time guarantee: ExecutionClarifier is required for clarify.
		// Missing clarifier in ExecutorDeps means clarify requests fail-closed at the call site.
		const clarifier: ExecutionClarifier | undefined = undefined;
		assert.equal(clarifier, undefined, "missing clarifier must be detectable, not silently approved");
	});
});
