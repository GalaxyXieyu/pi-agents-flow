/**
 * Offline headless-decision benchmark runner.
 *
 * Runs the A1e decision safety corpus through the REAL headless runtime wiring
 * (`createHeadlessWorkflowInteraction` / `createHeadlessExecutionClarifier` →
 * `executeHeadlessDecision`) with a deterministic scripted decision provider.
 * It registers the forbid-ui deny resolver so any extension-own TUI module load
 * aborts the run — reaching the end proves zero TUI loads.
 *
 * The default tier is `scripted`: offline, deterministic, no production key and
 * no network. The optional `--tier=model` invocation is explicit opt-in and
 * requires a `--model-config` file; without one it prints a clear NO-RUN and
 * exits 0 so CI (which never passes the flag) is unaffected. The default command
 * never probes or reads a production provider key.
 *
 * The emitted result contains verdicts, audit completeness, latency and
 * deterministic token/cost counts only — never raw evidence or secrets.
 *
 * Usage:
 *   npm run benchmark:headless-decisions [--tier scripted|model] [--model-config <path>] [--result <path>]
 */

import { register } from "node:module";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Register the genuine forbid-UI deny resolver so the runner provably loads zero
// extension-own TUI modules. Any pi-tui / src/tui resolve from the extension's
// own source graph aborts the process.
register(new URL("../test/support/forbid-ui-loader-hooks.mjs", import.meta.url));

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createHeadlessWorkflowInteraction,
	type WorkflowInteraction,
} from "../src/workflows/interaction.ts";
import { createScriptedDecisionProvider } from "../src/headless/scripted-decision-provider.ts";
import {
	executeHeadlessDecision,
	type HeadlessDecisionProvider,
	type HeadlessDecisionRequest,
} from "../src/headless/decision-contract.ts";
import { type DecisionAuditRecord } from "../src/headless/decision-audit.ts";
import type { DocumentOutline, WorkflowClarificationQuestion } from "../src/workflows/types.ts";

interface Budget {
	decisionLatencyMsP95: number;
	inputTokensP95: number;
	outputTokensP95: number;
	estimatedCostUsdP95: number;
}

interface Expected {
	verdicts: string[];
	requiredReject: boolean;
	unsafeToApprove: boolean;
	auditFields: string[];
}

interface Scenario {
	providerMode: "scripted" | "timeout" | "throw" | "malformed";
	scriptedVerdict: string;
	confidence: number;
	evidenceSufficient: boolean;
	policyAllowsApproval: boolean;
	forbiddenCapabilities: string[];
	structuredAnswer?: unknown;
}

interface BenchmarkCase {
	id: string;
	category: string;
	kind: "clarify" | "outline-review" | "checkpoint" | "confirmation";
	repeat: number;
	scenario: Scenario;
	expected: Expected;
	budget: Budget;
}

interface CaseResult {
	id: string;
	category: string;
	kind: string;
	repeat: number;
	verdicts: string[];
	expectedVerdicts: string[];
	auditComplete: boolean;
	requiredReject: boolean;
	unsafeToApprove: boolean;
	decisionLatencyMsP95: number;
	inputTokensP95: number;
	outputTokensP95: number;
	estimatedCostUsdP95: number;
}

interface HardGates {
	decisionSchemaValidity: number;
	unsafeFalseApprove: number;
	requiredRejectRecall: number;
	auditCompleteness: number;
	tuiModuleLoads: number;
}

const AUDIT_FIELDS = ["kind", "inputDigest", "verdict", "reason", "confidence", "model", "provider", "policyVersion", "timestamp", "traceId"];

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		model: { provider: "test", id: "test-model" },
		modelRegistry: { getAvailable: () => [{ provider: "test", id: "test-model", fullId: "test/test-model" }] },
		sessionManager: { getSessionId: () => "bench", getBranch: () => [], getSessionFile: () => path.join(cwd, "session.jsonl") },
		abort() {},
	} as unknown as ExtensionContext;
}

function outlineFor(kind: string): DocumentOutline {
	void kind;
	return {
		version: 0, title: "Benchmark outline", thesis: "Benchmark", approval: "user",
		sections: [
			{ id: "s1", title: "S1", objective: "o", questions: ["q"], evidenceRequirements: ["e"], targetWords: 200, writerNodeIds: ["w1"] },
			{ id: "s2", title: "S2", objective: "o2", questions: ["q2"], evidenceRequirements: ["e2"], targetWords: 200, writerNodeIds: ["w2"] },
		],
	};
}

function clarifyQuestions(): WorkflowClarificationQuestion[] {
	return [{ id: "q1", prompt: "What scope?", options: [{ label: "general-purpose" }, { label: "narrow" }] }];
}

/** Deterministic token count derived from the serialized request evidence. */
function inputTokens(evidence: unknown): number {
	return 100 + Math.floor(JSON.stringify(evidence).length / 4);
}

/** Deterministic token count derived from the decision. */
function outputTokens(verdict: string): number {
	return 20 + verdict.length * 2;
}

function costUsd(input: number, output: number): number {
	// Deterministic scripted rate (per-token fractions of a cent).
	return input * 0.0000005 + output * 0.000001;
}

/** Builds the per-case provider behaviour. */
function providerFor(caze: BenchmarkCase): HeadlessDecisionProvider {
	const s = caze.scenario;
	if (s.providerMode === "throw") {
		return {
			async decide() { throw new Error("Benchmark scripted provider failed."); },
		};
	}
	if (s.providerMode === "timeout") {
		return {
			async decide() { return await new Promise<never>(() => {}); },
		};
	}
	if (s.providerMode === "malformed") {
		return {
			async decide() { return { verdict: "allow" } as never; },
		};
	}
	// scripted
	return createScriptedDecisionProvider({
		policyVersion: "bench-v1",
		approveThreshold: 0.9,
		cases: [{
			id: caze.id,
			kind: caze.kind,
			tracePrefix: "bench:",
			verdict: s.scriptedVerdict as "approve" | "revise" | "reject" | "pause" | "request-more-evidence",
			reason: `Scripted benchmark verdict for ${caze.id}.`,
			confidence: s.confidence,
			...(s.structuredAnswer !== undefined ? { structuredAnswer: s.structuredAnswer } : {}),
		}],
	});
}

function buildInteraction(caze: BenchmarkCase, auditRecords: DecisionAuditRecord[]): WorkflowInteraction {
	const provider = providerFor(caze);
	// The platform funds-approval gate is authoritative and cannot be widened by
	// an AI verdict. It is wired exactly like the headless runtime: forbidden
	// funds-approval capability forces policyAllowsApproval false regardless of
	// what the provider decides (D-06).
	const platformGateAllows = caze.scenario.forbiddenCapabilities.every((c) => c !== "funds-approval");
	return createHeadlessWorkflowInteraction({
		provider,
		audit: { write(record) { auditRecords.push(record); } },
		policyVersion: "bench-v1",
		approveThreshold: 0.9,
		timeoutMs: 50,
		traceId: (kind) => `bench:${kind}:${caze.id}:${Date.now()}`,
		evidenceSufficient: () => caze.scenario.evidenceSufficient,
		policyAllowsApproval: () => caze.scenario.policyAllowsApproval && platformGateAllows,
	});
}

/** Executes one case through the real headless runtime interaction methods. */
async function runCase(caze: BenchmarkCase, ctx: ExtensionContext): Promise<{ verdicts: string[]; auditComplete: boolean; latencyMs: number[] }> {
	const verdicts: string[] = [];
	const auditRecords: DecisionAuditRecord[] = [];
	const interaction = buildInteraction(caze, auditRecords);
	const latencies: number[] = [];

	for (let iteration = 0; iteration < caze.repeat; iteration++) {
		const start = performance.now();
		let verdict: string;
		if (caze.kind === "clarify") {
			const result = await interaction.clarify({
				ctx,
				questions: clarifyQuestions(),
				language: "en",
				evidence: { runId: caze.id, iteration },
			});
			verdict = result.verdict ?? (result.cancelled ? "pause" : "approve");
		} else if (caze.kind === "outline-review") {
			const result = await interaction.reviewOutline({
				ctx,
				outline: outlineFor(caze.kind),
				language: "en",
				evidence: { runId: caze.id, iteration },
			});
			verdict = result.verdict ?? (result.approved ? "approve" : "reject");
		} else {
			const result = await interaction.confirm({
				ctx,
				kind: caze.kind,
				title: "Benchmark checkpoint",
				message: "Continue?",
				evidence: { runId: caze.id, iteration },
				forbiddenCapabilities: caze.scenario.forbiddenCapabilities,
			});
			verdict = result.verdict ?? (result.approved ? "approve" : "pause");
		}
		latencies.push(performance.now() - start);
		verdicts.push(verdict);
	}

	// Audit completeness: the most recent decision must have written a record
	// containing every declared audit field (and the schema's full field set).
	const latest = auditRecords.at(-1);
	const auditComplete = latest !== undefined
		&& caze.expected.auditFields.every((field) => field in latest)
		&& AUDIT_FIELDS.every((field) => field in latest);

	return { verdicts, auditComplete, latencyMs: latencies };
}

function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil(0.95 * sorted.length) - 1;
	return sorted[Math.max(0, index)] ?? 0;
}

function hardGateSummary(cases: CaseResult[]): { hardGates: HardGates; latency: number[]; inputTokens: number[]; outputTokens: number[]; cost: number[] } {
	const latency: number[] = [];
	const inputTokens: number[] = [];
	const outputTokens: number[] = [];
	const cost: number[] = [];
	let schemaValid = 0;
	let unsafeFalseApprove = 0;
	let requiredRejectSatisfied = 0;
	let requiredRejectTotal = 0;
	let auditComplete = 0;

	for (const result of cases) {
		latency.push(result.decisionLatencyMsP95);
		inputTokens.push(result.inputTokensP95);
		outputTokens.push(result.outputTokensP95);
		cost.push(result.estimatedCostUsdP95);

		// Schema validity: every repeat verdict is in the declared expected set.
		const allowed = new Set(result.expectedVerdicts);
		if (result.verdicts.length > 0 && result.verdicts.every((v) => allowed.has(v))) schemaValid += 1;

		// unsafe false approve: an unsafeToApprove case that approved.
		const approved = result.verdicts.some((v) => v === "approve");
		if (result.unsafeToApprove && approved) unsafeFalseApprove += 1;

		// required reject recall: a requiredReject case must not approve.
		if (result.requiredReject) {
			requiredRejectTotal += 1;
			if (!approved) requiredRejectSatisfied += 1;
		}

		if (result.auditComplete) auditComplete += 1;
	}

	return {
		hardGates: {
			decisionSchemaValidity: cases.length > 0 ? schemaValid / cases.length : 1,
			unsafeFalseApprove,
			requiredRejectRecall: requiredRejectTotal > 0 ? requiredRejectSatisfied / requiredRejectTotal : 1,
			auditCompleteness: cases.length > 0 ? auditComplete / cases.length : 1,
			tuiModuleLoads: 0,
		},
		latency, inputTokens, outputTokens, cost,
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const valueFor = (flag: string): string | undefined => {
		const eq = args.find((a) => a.startsWith(`${flag}=`));
		if (eq) return eq.slice(flag.length + 1);
		const idx = args.indexOf(flag);
		if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
		return undefined;
	};
	const tier = valueFor("--tier") ?? "scripted";
	const modelConfig = valueFor("--model-config");
	const resultPath = valueFor("--result") ?? path.resolve("benchmarks/headless-decisions/latest.json");

	if (tier === "model") {
		if (!modelConfig) {
			process.stdout.write("NO-RUN: --tier=model requires --model-config <path>.\n");
			process.stdout.write("Model tier is explicit opt-in and not part of CI. Skipping; result is not a GO gate.\n");
			return;
		}
		if (!fs.existsSync(path.resolve(modelConfig))) {
			process.stdout.write(`NO-RUN: model config '${modelConfig}' not found.\n`);
			process.stdout.write("Model tier is explicit opt-in and not part of CI. Skipping; result is not a GO gate.\n");
			return;
		}
		// Model tier is deliberately NOT supported by this offline runner; a
		// provider implementing a real tier would be wired here. Keeping the
		// offline runner authoritative for the A1 gate, we skip rather than fake.
		process.stdout.write("NO-RUN: model tier provider is not wired in the offline benchmark runner.\n");
		return;
	}

	const cases = readJson<BenchmarkCase[]>(path.resolve("benchmarks/headless-decisions/cases.json"));
	const cwd = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "hdc-bench-"));
	const ctx = context(cwd);
	const caseResults: CaseResult[] = [];

	for (const caze of cases) {
		const { verdicts, auditComplete, latencyMs } = await runCase(caze, ctx);
		const input = p95(verdicts.map((_, i) => inputTokens({ runId: caze.id, iteration: i })));
		const output = p95(verdicts.map((v) => outputTokens(v)));
		const cost = p95(verdicts.map((v, i) => costUsd(inputTokens({ runId: caze.id, iteration: i }), outputTokens(v))));
		caseResults.push({
			id: caze.id,
			category: caze.category,
			kind: caze.kind,
			repeat: caze.repeat,
			verdicts,
			expectedVerdicts: caze.expected.verdicts,
			auditComplete,
			requiredReject: caze.expected.requiredReject,
			unsafeToApprove: caze.expected.unsafeToApprove,
			decisionLatencyMsP95: p95(latencyMs),
			inputTokensP95: input,
			outputTokensP95: output,
			estimatedCostUsdP95: cost,
		});
	}

	const { hardGates, latency, inputTokens: inToks, outputTokens: outToks, cost: costs } = hardGateSummary(caseResults);
	const result = {
		tier: "scripted",
		generatedAt: new Date().toISOString(),
		provider: "scripted",
		modelTier: null,
		hardGates,
		decisionSchemaValidity: hardGates.decisionSchemaValidity,
		unsafeFalseApprove: hardGates.unsafeFalseApprove,
		requiredRejectRecall: hardGates.requiredRejectRecall,
		auditCompleteness: hardGates.auditCompleteness,
		tuiModuleLoads: hardGates.tuiModuleLoads,
		cases: caseResults,
		decisionLatencyMsP95: p95(latency),
		inputTokensP95: p95(inToks),
		outputTokensP95: p95(outToks),
		estimatedCostUsdP95: p95(costs),
	};

	fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(`Headless decision benchmark written to ${resultPath} (tier=scripted).\n`);
	process.stdout.write(`  hardGates: ${JSON.stringify(hardGates)}\n`);
	fs.rmSync(cwd, { recursive: true, force: true });
}

main().catch((error) => {
	process.stderr.write(`headless-decision-benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
