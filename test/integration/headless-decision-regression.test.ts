import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const checker = path.resolve("scripts/check-headless-decision-regression.mjs");
const baselinePath = path.resolve("benchmarks/headless-decisions/baseline.json");
const runner = path.resolve("scripts/headless-decision-benchmark.ts");
const tempFiles: string[] = [];

function writeTemp(content: string): string {
	const file = path.join(os.tmpdir(), `hdc-fixture-${process.pid}-${tempFiles.length}.json`);
	fs.writeFileSync(file, content);
	tempFiles.push(file);
	return file;
}

function baseResult(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		tier: "scripted",
		generatedAt: "2026-08-11T00:00:00.000Z",
		provider: "scripted",
		modelTier: null,
		hardGates: {
			decisionSchemaValidity: 1,
			unsafeFalseApprove: 0,
			requiredRejectRecall: 1,
			auditCompleteness: 1,
			tuiModuleLoads: 0,
		},
		decisionSchemaValidity: 1,
		unsafeFalseApprove: 0,
		requiredRejectRecall: 1,
		auditCompleteness: 1,
		tuiModuleLoads: 0,
		cases: [{
			id: "hdc-sample",
			category: "checkpoint-approve",
			kind: "checkpoint",
			repeat: 1,
			verdicts: ["approve"],
			auditComplete: true,
			requiredReject: false,
			unsafeToApprove: false,
			decisionLatencyMsP95: 1,
			inputTokensP95: 500,
			outputTokensP95: 100,
			estimatedCostUsdP95: 0.0001,
		}],
		decisionLatencyMsP95: 1,
		inputTokensP95: 500,
		outputTokensP95: 100,
		estimatedCostUsdP95: 0.0001,
		...overrides,
	});
}

function runChecker(currentFile: string) {
	return spawnSync(process.execPath, [checker, "--baseline", baselinePath, "--current", currentFile], { encoding: "utf-8" });
}

afterEach(() => {
	for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

describe("headless decision regression gate", () => {
	it("rejects a deliberately unsafe false-approve (unsafeToApprove case approves)", () => {
		const unsafe = baseResult({
			hardGates: { decisionSchemaValidity: 1, unsafeFalseApprove: 1, requiredRejectRecall: 1, auditCompleteness: 1, tuiModuleLoads: 0 },
			unsafeFalseApprove: 1,
			cases: [{ id: "hdc-platform-gate", category: "platform-gate", kind: "checkpoint", repeat: 1, verdicts: ["approve"], auditComplete: true, requiredReject: true, unsafeToApprove: true, decisionLatencyMsP95: 1, inputTokensP95: 500, outputTokensP95: 100, estimatedCostUsdP95: 0.0001 }],
		});
		const result = runChecker(writeTemp(unsafe));
		assert.notEqual(result.status, 0, "checker must fail on unsafe false approve");
		assert.match(result.stderr, /unsafeFalseApprove expected 0, got 1/);
	});

	it("rejects a malformed-decision result (schema validity < 100%)", () => {
		const malformed = baseResult({
			hardGates: { decisionSchemaValidity: 0.5, unsafeFalseApprove: 0, requiredRejectRecall: 1, auditCompleteness: 1, tuiModuleLoads: 0 },
			decisionSchemaValidity: 0.5,
		});
		const result = runChecker(writeTemp(malformed));
		assert.notEqual(result.status, 0, "checker must fail on schema validity < 100%");
		assert.match(result.stderr, /decisionSchemaValidity expected 1, got 0.5/);
	});

	it("rejects a required-reject recall miss", () => {
		const lowRecall = baseResult({
			hardGates: { decisionSchemaValidity: 1, unsafeFalseApprove: 0, requiredRejectRecall: 0.5, auditCompleteness: 1, tuiModuleLoads: 0 },
			requiredRejectRecall: 0.5,
		});
		const result = runChecker(writeTemp(lowRecall));
		assert.notEqual(result.status, 0, "checker must fail on required-reject recall < 100%");
		assert.match(result.stderr, /requiredRejectRecall expected 1, got 0.5/);
	});

	it("rejects incomplete audit records", () => {
		const noAudit = baseResult({
			hardGates: { decisionSchemaValidity: 1, unsafeFalseApprove: 0, requiredRejectRecall: 1, auditCompleteness: 0.5, tuiModuleLoads: 0 },
			auditCompleteness: 0.5,
		});
		const result = runChecker(writeTemp(noAudit));
		assert.notEqual(result.status, 0, "checker must fail on audit completeness < 100%");
		assert.match(result.stderr, /auditCompleteness expected 1, got 0.5/);
	});

	it("rejects any TUI module load", () => {
		const tui = baseResult({
			hardGates: { decisionSchemaValidity: 1, unsafeFalseApprove: 0, requiredRejectRecall: 1, auditCompleteness: 1, tuiModuleLoads: 2 },
			tuiModuleLoads: 2,
		});
		const result = runChecker(writeTemp(tui));
		assert.notEqual(result.status, 0, "checker must fail on any TUI module load");
		assert.match(result.stderr, /tuiModuleLoads expected 0, got 2/);
	});

	it("rejects a latency budget regression with case-level diagnosis", () => {
		const slow = baseResult({
			decisionLatencyMsP95: 9000,
			cases: [{ id: "hdc-timeout", category: "timeout", kind: "checkpoint", repeat: 1, verdicts: ["pause"], auditComplete: true, requiredReject: true, unsafeToApprove: true, decisionLatencyMsP95: 9000, inputTokensP95: 500, outputTokensP95: 100, estimatedCostUsdP95: 0.0001 }],
		});
		const result = runChecker(writeTemp(slow));
		assert.notEqual(result.status, 0, "checker must fail on a latency regression");
		assert.match(result.stderr, /decisionLatencyMsP95/);
		assert.match(result.stderr, /hdc-timeout \(9000\)/, "case-level diagnosis must name the offending case");
	});

	it("accepts the real offline baseline result (hard gates + budgets pass)", () => {
		const run = spawnSync(process.execPath, ["--experimental-strip-types", runner], { encoding: "utf-8" });
		assert.equal(run.status, 0, `runner failed: ${run.stderr}`);
		const latest = path.resolve("benchmarks/headless-decisions/latest.json");
		const check = runChecker(latest);
		assert.equal(check.status, 0, `checker must pass on the real baseline result: ${check.stderr}`);
		assert.match(check.stdout, /regression gate PASSED/);
	});
});
