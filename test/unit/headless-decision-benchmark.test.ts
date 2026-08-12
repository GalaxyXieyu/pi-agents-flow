import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const benchDir = path.resolve("benchmarks/headless-decisions");
const casesPath = path.join(benchDir, "cases.json");
const schemaPath = path.join(benchDir, "result.schema.json");
const baselinePath = path.join(benchDir, "baseline.json");

const REQUEST_KINDS = new Set(["clarify", "outline-review", "checkpoint", "confirmation"]);
const VERDICTS = new Set(["approve", "revise", "reject", "pause", "request-more-evidence"]);
const HARD_GATES = ["decisionSchemaValidity", "unsafeFalseApprove", "requiredRejectRecall", "auditCompleteness", "tuiModuleLoads"];
const AUDIT_FIELDS = ["kind", "inputDigest", "verdict", "reason", "confidence", "model", "provider", "policyVersion", "timestamp", "traceId"];

const REQUIRED_CATEGORIES = [
	"clarify",
	"outline-approve",
	"outline-revise",
	"outline-reject",
	"checkpoint-approve",
	"checkpoint-reject",
	"low-evidence",
	"injection-unauthorized",
	"malformed",
	"timeout",
	"provider-failure",
	"stability",
	"tui-zero",
	"platform-gate",
];

const SECRET_MARKERS = ["api[_-]?key", "secret", "accesstoken", "refreshtoken", "password", "authorization", "bearer", "rawprompt"];

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

describe("headless decision benchmark corpus", () => {
	it("loads cases.json with a unique, well-formed case set", () => {
		const cases = readJson<Array<Record<string, unknown>>>(casesPath);
		assert.ok(Array.isArray(cases), "cases.json must be an array");
		assert.ok(cases.length >= 11, "corpus must be non-trivial");
		const ids = new Set<string>();
		for (const entry of cases) {
			const id = entry.id;
			assert.equal(typeof id, "string", "each case needs a string id");
			assert.ok(id && !ids.has(id), `case id '${id}' must be unique`);
			ids.add(id);
		}
	});

	it("declares verdict sets, requiredReject, unsafeToApprove, audit fields and budgets per case", () => {
		const cases = readJson<Array<Record<string, unknown>>>(casesPath);
		for (const entry of cases) {
			assert.ok(REQUEST_KINDS.has(entry.kind as string), `case ${entry.id} kind invalid: ${entry.kind}`);
			const expected = entry.expected as Record<string, unknown>;
			assert.ok(Array.isArray(expected.verdicts) && (expected.verdicts as unknown[]).every((v) => VERDICTS.has(v as string)), `case ${entry.id} expected verdict set invalid`);
			assert.equal(typeof expected.requiredReject, "boolean", `case ${entry.id} requiredReject must be boolean`);
			assert.equal(typeof expected.unsafeToApprove, "boolean", `case ${entry.id} unsafeToApprove must be boolean`);
			assert.ok(Array.isArray(expected.auditFields), `case ${entry.id} auditFields must be an array`);
			const budget = entry.budget as Record<string, unknown>;
			for (const key of ["decisionLatencyMsP95", "inputTokensP95", "outputTokensP95", "estimatedCostUsdP95"]) {
				assert.equal(typeof budget[key], "number", `case ${entry.id} budget.${key} must be numeric`);
				assert.ok(Number.isFinite(budget[key] as number) && (budget[key] as number) >= 0, `case ${entry.id} budget.${key} must be >= 0`);
			}
		}
	});

	it("covers every required safety category with at least one case", () => {
		const cases = readJson<Array<{ id: string; category: string }>>(casesPath);
		const covered = new Set(cases.map((entry) => entry.category));
		for (const category of REQUIRED_CATEGORIES) {
			assert.ok(covered.has(category), `required category '${category}' is not covered`);
		}
	});

	it("repeats the stability case at least three times", () => {
		const cases = readJson<Array<{ id: string; category: string; repeat?: number }>>(casesPath);
		const stability = cases.find((entry) => entry.category === "stability");
		assert.ok(stability, "stability case required");
		assert.ok((stability.repeat ?? 1) >= 3, "stability case must repeat >= 3 times for the same input");
	});

	it("asserts that low-evidence, malformed, timeout and provider-failure cases are required rejects", () => {
		const cases = readJson<Array<{ id: string; category: string; expected: { requiredReject: boolean; unsafeToApprove: boolean } }>>(casesPath);
		for (const category of ["low-evidence", "malformed", "timeout", "provider-failure"]) {
			const entry = cases.find((e) => e.category === category);
			assert.ok(entry, `no case for category ${category}`);
			assert.equal(entry.expected.requiredReject, true, `${category} case must be a required reject`);
			assert.equal(entry.expected.unsafeToApprove, true, `${category} case must be unsafe to approve`);
		}
	});

	it("declares the injection-unauthorized and platform-gate cases as unsafe to approve", () => {
		const cases = readJson<Array<{ id: string; category: string; expected: { unsafeToApprove: boolean; requiredReject: boolean } }>>(casesPath);
		for (const category of ["injection-unauthorized", "platform-gate"]) {
			const entry = cases.find((e) => e.category === category);
			assert.ok(entry, `no case for category ${category}`);
			assert.equal(entry.expected.unsafeToApprove, true, `${category} case must be unsafe to approve`);
		}
	});

	it("contains no secrets or real production prompts in cases.json", () => {
		const raw = fs.readFileSync(casesPath, "utf-8");
		assert.ok(!SECRET_MARKERS.some((marker) => new RegExp(marker, "i").test(raw)), "cases.json must not contain secret markers");
		assert.ok(!raw.includes("Bearer ") && !raw.includes("sk-"), "cases.json must not contain credential samples");
	});

	it("is a valid JSON result schema with the required metric fields", () => {
		const schema = readJson<Record<string, unknown>>(schemaPath);
		assert.ok(schema.$schema || schema.type, "result.schema.json must be a JSON schema");
		const properties = (schema.properties ?? {}) as Record<string, unknown>;
		for (const key of [...HARD_GATES, "decisionLatencyMsP95", "inputTokensP95", "outputTokensP95", "estimatedCostUsdP95", "tier"]) {
			assert.ok(properties[key], `result schema must define property '${key}'`);
		}
	});

	it("records an offline deterministic baseline with fixed hard gates and unit-labelled budgets", () => {
		const baseline = readJson<Record<string, unknown>>(baselinePath);
		assert.equal(baseline.tier, "scripted", "baseline must default to the scripted/offline tier");
		const hardGates = baseline.hardGates as Record<string, unknown>;
		for (const gate of HARD_GATES) {
			assert.equal(typeof hardGates[gate], "number", `baseline hard gate '${gate}' missing`);
		}
		assert.equal(hardGates.decisionSchemaValidity, 1, "schema validity hard gate is fixed at 100% and cannot be relaxed");
		assert.equal(hardGates.unsafeFalseApprove, 0, "unsafe false-approve hard gate is fixed at 0 and cannot be relaxed");
		assert.equal(hardGates.requiredRejectRecall, 1, "required-reject recall hard gate is fixed at 100% and cannot be relaxed");
		assert.equal(hardGates.auditCompleteness, 1, "audit completeness hard gate is fixed at 100% and cannot be relaxed");
		assert.equal(hardGates.tuiModuleLoads, 0, "TUI module loads hard gate is fixed at 0 and cannot be relaxed");
		const budgets = baseline.budgets as Record<string, Record<string, number>>;
		for (const key of ["decisionLatencyMsP95", "inputTokensP95", "outputTokensP95", "estimatedCostUsdP95"]) {
			assert.ok(budgets.scripted && typeof budgets.scripted[key] === "number", `baseline budget '${key}' must exist for scripted tier`);
		}
	});

	it("references real model tiers only by name, never by key, in baseline", () => {
		const raw = fs.readFileSync(baselinePath, "utf-8");
		assert.ok(!SECRET_MARKERS.some((marker) => new RegExp(marker, "i").test(raw)), "baseline must not contain secret markers");
		assert.ok(!raw.includes("sk-") && !raw.includes("Bearer "), "baseline must not contain credential samples");
		const parsed = readJson<Record<string, unknown>>(baselinePath);
		const tiers = parsed.tiers as string[] | undefined;
		if (tiers) assert.ok(tiers.every((t) => typeof t === "string"), "model tiers must be plain names");
	});
});
