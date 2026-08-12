import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	executeHeadlessDecision,
	type HeadlessDecision,
	type HeadlessDecisionProvider,
	type HeadlessDecisionRequest,
} from "../../src/headless/decision-contract.ts";
import { decisionInputDigest, type DecisionAuditRecord } from "../../src/headless/decision-audit.ts";

const request: HeadlessDecisionRequest = {
	kind: "confirmation",
	evidence: { sufficient: true, summary: "verified plugin checkpoint", apiKey: "KEY=raw-key-must-not-leak" },
	policyVersion: "workflow-v1",
	traceId: "trace-1",
	forbiddenCapabilities: ["funds.transfer", "worker.sensitive.override"],
};

function decision(overrides: Partial<HeadlessDecision> = {}): HeadlessDecision {
	return {
		verdict: "approve",
		reason: "Evidence supports the plugin checkpoint.",
		confidence: 0.95,
		model: "safe-model",
		provider: "test-provider",
		...overrides,
	};
}

async function run(provider: HeadlessDecisionProvider, overrides: Partial<Parameters<typeof executeHeadlessDecision>[0]> = {}) {
	const records: DecisionAuditRecord[] = [];
	const result = await executeHeadlessDecision({
		provider,
		request,
		audit: { write(record) { records.push(record); } },
		approveThreshold: 0.9,
		evidenceSufficient: true,
		policyAllowsApproval: true,
		now: () => new Date("2026-08-11T00:00:00.000Z"),
		timeoutMs: 20,
		...overrides,
	});
	return { result, records };
}

describe("headless decision contract", () => {
	it("accepts only an explicitly policy-allowed, sufficiently evidenced, high-confidence approval", async () => {
		const { result, records } = await run({ async decide() { return decision(); } });
		assert.equal(result.verdict, "approve");
		assert.equal(records.length, 1);
		assert.deepEqual(Object.keys(records[0]!).sort(), [
			"confidence", "inputDigest", "kind", "model", "policyVersion", "provider", "reason", "timestamp", "traceId", "verdict",
		].sort());
		assert.match(records[0]!.inputDigest, /^[a-f0-9]{64}$/);
	});

	it("normalizes low confidence, insufficient evidence, and policy conflict without default approval", async () => {
		const low = await run({ async decide() { return decision({ confidence: 0.89 }); } });
		assert.equal(low.result.verdict, "reject");
		const insufficient = await run({ async decide() { return decision(); } }, { evidenceSufficient: false });
		assert.equal(insufficient.result.verdict, "request-more-evidence");
		const conflict = await run({ async decide() { return decision(); } }, { policyAllowsApproval: false });
		assert.equal(conflict.result.verdict, "pause");
	});

	it("fails closed for malformed output, provider throw, and timeout and audits every result", async () => {
		const malformed = await run({ async decide() { return { verdict: "allow" } as never; } });
		assert.equal(malformed.result.verdict, "reject");
		assert.equal(malformed.records.length, 1);

		const thrown = await run({ async decide() { throw new Error("raw prompt: provider-token-must-not-leak"); } });
		assert.equal(thrown.result.verdict, "pause");
		assert.equal(thrown.result.reason, "Headless decision provider failed.");
		assert.equal(thrown.records.length, 1);
		assert.doesNotMatch(JSON.stringify(thrown.records), /provider-token-must-not-leak/);

		const timedOut = await run({ async decide() { return await new Promise<HeadlessDecision>(() => {}); } });
		assert.equal(timedOut.result.verdict, "pause");
		assert.equal(timedOut.result.reason, "Headless decision provider timed out.");
		assert.equal(timedOut.records.length, 1);
	});

	it("never serializes raw evidence or secrets and bounds/redacts every free-form audit field", async () => {
		const hostileRequest: HeadlessDecisionRequest = {
			...request,
			policyVersion: `ｓｅｃｒｅｔ policy-leak ${"p".repeat(500)}`,
			traceId: `authori.zation trace-leak ${"t".repeat(500)}`,
		};
		const { records } = await run({
			async decide() {
				return decision({
					reason: `ｒａｗ　ｐｒｏｍｐｔ: raw-prompt-leak Ｂｅａｒｅｒ bearer-leak ${"x".repeat(2_000)}`,
					model: "API-key model-leak",
					provider: "raw.prompt provider-leak",
				});
			},
		}, { request: hostileRequest });
		const json = JSON.stringify(records);
		assert.doesNotMatch(json, /raw-key-must-not-leak|raw-prompt-leak|bearer-leak|model-leak|provider-leak|policy-leak|trace-leak/i);
		assert.deepEqual({
			reason: records[0]!.reason,
			model: records[0]!.model,
			provider: records[0]!.provider,
			policyVersion: records[0]!.policyVersion,
			traceId: records[0]!.traceId,
		}, {
			reason: "[redacted]",
			model: "[redacted]",
			provider: "[redacted]",
			policyVersion: "[redacted]",
			traceId: "[redacted]",
		});
		assert.ok(records[0]!.reason.length <= 512);
		assert.ok(records[0]!.model.length <= 128);
		assert.ok(records[0]!.provider.length <= 128);
		assert.ok(records[0]!.policyVersion.length <= 128);
		assert.ok(records[0]!.traceId.length <= 128);
	});

	it("enforces an exact provider-result schema before considering approval", async () => {
		for (const extra of [
			{ allowedTools: ["funds.transfer"] },
			{ harmlessMetadata: "also forbidden by the exact schema" },
		]) {
			const { result } = await run({ async decide() { return { ...decision(), ...extra } as HeadlessDecision; } });
			assert.equal(result.verdict, "reject");
		}
	});

	it("takes one descriptor snapshot and never re-reads a provider Proxy", async () => {
		const target = decision({ structuredAnswer: { allowedTools: ["funds.transfer"] } });
		let ownKeysCalls = 0;
		const descriptorCalls = new Map<PropertyKey, number>();
		let structuredReads = 0;
		const hostile = new Proxy(target, {
			ownKeys(inner) {
				ownKeysCalls += 1;
				return ownKeysCalls === 1 ? Reflect.ownKeys(inner) : Reflect.ownKeys(inner).filter((key) => key !== "structuredAnswer");
			},
			getOwnPropertyDescriptor(inner, key) {
				const calls = (descriptorCalls.get(key) ?? 0) + 1;
				descriptorCalls.set(key, calls);
				if (key === "structuredAnswer" && calls > 1) {
					return { configurable: true, enumerable: true, writable: true, value: {} };
				}
				return Reflect.getOwnPropertyDescriptor(inner, key);
			},
			get(inner, key, receiver) {
				if (key === "structuredAnswer") {
					structuredReads += 1;
					return structuredReads === 1 ? {} : { allowedTools: ["funds.transfer"] };
				}
				return Reflect.get(inner, key, receiver);
			},
		});

		const { result } = await run({ async decide() { return hostile; } });
		assert.equal(result.verdict, "pause");
		assert.equal(ownKeysCalls, 1);
		assert.equal(structuredReads, 0);
		assert.equal(descriptorCalls.get("structuredAnswer"), 1);
	});

	it("deep-copies and freezes descriptor values without retaining nested Proxies, accessors, or prototypes", async () => {
		let nestedOwnKeysCalls = 0;
		let nestedReads = 0;
		const nestedTarget = { answer: "stable" };
		const nested = new Proxy(nestedTarget, {
			ownKeys(inner) { nestedOwnKeysCalls += 1; return Reflect.ownKeys(inner); },
			get(inner, key, receiver) { nestedReads += 1; return Reflect.get(inner, key, receiver); },
		});
		const { result } = await run({ async decide() { return decision({ structuredAnswer: { nested } }); } });
		assert.equal(result.verdict, "approve");
		assert.equal(nestedOwnKeysCalls, 1);
		assert.equal(nestedReads, 0);
		assert.notEqual((result.structuredAnswer as { nested: unknown }).nested, nested);
		assert.equal(Object.getPrototypeOf(result.structuredAnswer), Object.prototype);
		assert.equal(Object.getPrototypeOf((result.structuredAnswer as { nested: unknown }).nested), Object.prototype);
		assert.equal(Object.isFrozen(result), true);
		assert.equal(Object.isFrozen(result.structuredAnswer), true);
		assert.equal(Object.isFrozen((result.structuredAnswer as { nested: unknown }).nested), true);
		assert.equal(Object.getOwnPropertyDescriptor((result.structuredAnswer as { nested: { answer: string } }).nested, "answer")?.get, undefined);
	});

	it("uses the first nested descriptor snapshot when Proxy keys and descriptors later change", async () => {
		const nestedTarget = { allowedTools: ["funds.transfer"] };
		let ownKeysCalls = 0;
		let descriptorCalls = 0;
		const nested = new Proxy(nestedTarget, {
			ownKeys(inner) {
				ownKeysCalls += 1;
				return ownKeysCalls === 1 ? Reflect.ownKeys(inner) : [];
			},
			getOwnPropertyDescriptor(inner, key) {
				descriptorCalls += 1;
				return descriptorCalls === 1
					? Reflect.getOwnPropertyDescriptor(inner, key)
					: { configurable: true, enumerable: true, writable: true, value: "safe" };
			},
		});
		const { result } = await run({ async decide() { return decision({ structuredAnswer: { nested } }); } });
		assert.equal(result.verdict, "pause");
		assert.equal(ownKeysCalls, 1);
		assert.equal(descriptorCalls, 1);
	});

	it("rejects descriptor snapshots with accessors, symbols, non-enumerable fields, or custom prototypes", async () => {
		const symbol = Symbol("hidden");
		const attacks: unknown[] = [
			Object.defineProperty(decision(), "reason", { enumerable: true, get: () => "looks safe" }),
			Object.assign(decision(), { [symbol]: "hidden" }),
			Object.defineProperty(decision(), "hidden", { enumerable: false, value: true }),
			Object.assign(Object.create({ inherited: true }), decision()),
		];
		for (const attack of attacks) {
			const { result } = await run({ async decide() { return attack as HeadlessDecision; } });
			assert.equal(result.verdict, "reject");
		}
	});

	it("blocks grant-shaped keys across punctuation, whitespace, case, Unicode, objects, and arrays", async () => {
		const attacks: unknown[] = [
			{ "allowed.tools": ["funds.transfer"] },
			{ "Allowed Tools": ["funds.transfer"] },
			{ "ＰＥＲＭＩＳＳＩＯＮ　ＧＲＡＮＴＳ": ["funds.transfer"] },
			{ nested: { "capability grant": "worker.sensitive.override" } },
			{ nested: [{ "tool-permissions": ["funds.transfer"] }] },
			[{ "privilege_grants": true }],
			{ "capability access override": "worker.sensitive.override" },
		];
		for (const structuredAnswer of attacks) {
			const { result } = await run({ async decide() { return decision({ structuredAnswer }); } });
			assert.equal(result.verdict, "pause", JSON.stringify(structuredAnswer));
		}
		assert.deepEqual(request.forbiddenCapabilities, ["funds.transfer", "worker.sensitive.override"]);
	});

	it("does not mistake ordinary answer text or declared business fields for a grant", async () => {
		const { result } = await run({ async decide() {
			return decision({ structuredAnswer: { answer: "The operator does not have permission to use that tool.", summary: "No capability changes were made." } });
		} });
		assert.equal(result.verdict, "approve");
	});

	it("uses a deterministic, type-preserving and unambiguous decision-input digest", () => {
		const withEvidence = (evidence: unknown): HeadlessDecisionRequest => ({ ...request, evidence });
		assert.throws(() => decisionInputDigest(withEvidence(Number.NaN)), /unsupported/i);
		assert.doesNotThrow(() => decisionInputDigest(withEvidence("NaN")));
		assert.throws(() => decisionInputDigest(withEvidence(Number.POSITIVE_INFINITY)), /unsupported/i);
		assert.doesNotThrow(() => decisionInputDigest(withEvidence("Infinity")));
		assert.notEqual(decisionInputDigest(withEvidence(1n)), decisionInputDigest(withEvidence("1")));
		assert.notEqual(decisionInputDigest(withEvidence(undefined)), decisionInputDigest(withEvidence("[undefined]")));
		assert.notEqual(decisionInputDigest(withEvidence(-0)), decisionInputDigest(withEvidence(0)));
		assert.notEqual(decisionInputDigest(withEvidence(["a", "b"])), decisionInputDigest(withEvidence(["a", "b", undefined])));
		assert.notEqual(decisionInputDigest(withEvidence({ value: undefined })), decisionInputDigest(withEvidence({ value: "[undefined]" })));

		const left = withEvidence({ z: [true, null], a: { y: 2, x: "two" } });
		const right = withEvidence({ a: { x: "two", y: 2 }, z: [true, null] });
		assert.equal(decisionInputDigest(left), decisionInputDigest(right));
	});

	it("fails closed rather than silently canonicalizing unsupported evidence values", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const evidence of [new Date(0), new Map(), new Set(), () => undefined, Symbol("evidence"), cycle]) {
			assert.throws(() => decisionInputDigest({ ...request, evidence }), /unsupported/i);
		}
	});

	it("preflights unsupported evidence before provider invocation or audit", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const evidence of [new Date(0), new Map(), cycle, Number.NaN, Number.POSITIVE_INFINITY]) {
			let providerCalls = 0;
			let auditWrites = 0;
			await assert.rejects(() => executeHeadlessDecision({
				provider: { async decide() { providerCalls += 1; return decision(); } },
				request: { ...request, evidence },
				audit: { write() { auditWrites += 1; } },
				approveThreshold: 0.9,
				evidenceSufficient: true,
				policyAllowsApproval: true,
				timeoutMs: 20,
			}), /unsupported/i);
			assert.equal(providerCalls, 0);
			assert.equal(auditWrites, 0);
		}
	});

	it("calls the provider and audit sink exactly once on every handled normal path", async () => {
		for (const providerDecision of [decision(), decision({ verdict: "reject" })]) {
			let providerCalls = 0;
			let auditWrites = 0;
			const result = await executeHeadlessDecision({
				provider: { async decide() { providerCalls += 1; return providerDecision; } },
				request,
				audit: { write() { auditWrites += 1; } },
				approveThreshold: 0.9,
				evidenceSufficient: true,
				policyAllowsApproval: true,
				timeoutMs: 20,
			});
			assert.equal(result.verdict, providerDecision.verdict);
			assert.equal(providerCalls, 1);
			assert.equal(auditWrites, 1);
		}
	});

	it("keeps audit sink failure as a hard stop", async () => {
		await assert.rejects(() => executeHeadlessDecision({
			provider: { async decide() { return decision(); } },
			request,
			audit: { write() { throw new Error("sink unavailable"); } },
			approveThreshold: 0.9,
			evidenceSufficient: true,
			policyAllowsApproval: true,
			timeoutMs: 20,
		}), /sink unavailable/);
	});
});
