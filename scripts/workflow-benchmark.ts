import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { summarizeSearchBenchmarkRuns, type SearchBenchmarkRun, type SearchQualityBenchmarkResult } from "../src/workflows/benchmark.ts";
import type { WorkflowQualityReport } from "../src/workflows/quality.ts";
import type { WorkflowRun } from "../src/workflows/types.ts";

interface BenchmarkQuestion {
	id: string;
	question: string;
}

// ── Timing helpers (exported for reuse by other scripts) ──────────────────

export interface TimedResult<T> {
	result: T;
	ms: number;
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<TimedResult<T>> {
	const start = Date.now();
	const result = await fn();
	return { result, ms: Date.now() - start };
}

export class BenchmarkTimings {
	private entries: Array<{ label: string; ms: number }> = [];

	record(label: string, ms: number): void {
		this.entries.push({ label, ms });
	}

	toJSON(): Record<string, number> {
		const result: Record<string, number> = {};
		const groups = new Map<string, number[]>();
		for (const entry of this.entries) {
			const list = groups.get(entry.label) ?? [];
			list.push(entry.ms);
			groups.set(entry.label, list);
		}
		for (const [label, values] of groups) {
			result[label] = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
		}
		return result;
	}
}

// ── Benchmark loading ───────────────────────────────────────────────────────

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function questions(): BenchmarkQuestion[] {
	return readJson<BenchmarkQuestion[]>(path.resolve("benchmarks/deep-research/questions.json"));
}

function questionId(run: WorkflowRun, fixtures: BenchmarkQuestion[]): string {
	const exact = fixtures.find((fixture) => fixture.question.trim() === run.goal.trim());
	if (exact) return exact.id;
	return `custom-${createHash("sha256").update(run.goal).digest("hex").slice(0, 10)}`;
}

function provider(run: WorkflowRun): string {
	const models = [...new Set(Object.values(run.nodes).flatMap((node) => node.attempts.map((attempt) => attempt.model).filter((model): model is string => Boolean(model))))];
	return models.length > 0 ? models.join("+") : "unknown";
}

function loadRun(runDir: string, fixtures: BenchmarkQuestion[], variant: string): SearchBenchmarkRun {
	const manifestPath = path.join(runDir, "manifest.json");
	const qualityPath = path.join(runDir, "bundles", "quality-report.json");
	const run = readJson<WorkflowRun>(manifestPath);
	const quality = readJson<WorkflowQualityReport>(qualityPath);
	if (!quality.searchBenchmark) throw new Error(`${qualityPath} has no searchBenchmark. Accept at least one research lane and run /workflow quality first.`);
	return {
		questionId: questionId(run, fixtures),
		variant,
		provider: provider(run),
		result: quality.searchBenchmark as SearchQualityBenchmarkResult,
	};
}

function markdown(runs: SearchBenchmarkRun[]): string {
	const summary = summarizeSearchBenchmarkRuns(runs);
	const lines = [
		"| question | variant | provider | runs | score | stddev | support | unsupported | diversity | fetch |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const group of summary.groups) {
		lines.push(`| ${group.questionId} | ${group.variant} | ${group.provider} | ${group.runs} | ${group.meanScore.toFixed(1)} | ${group.scoreStdDev.toFixed(1)} | ${(group.meanClaimSupportRate * 100).toFixed(0)}% | ${(group.meanUnsupportedClaimRate * 100).toFixed(0)}% | ${(group.meanSourceDiversity * 100).toFixed(0)}% | ${(group.meanFetchedCoverage * 100).toFixed(0)}% |`);
	}
	return lines.join("\n");
}

function humanSummary(runs: SearchBenchmarkRun[]): string {
	const summary = summarizeSearchBenchmarkRuns(runs);
	const lines = [`Benchmark summary (${runs.length} runs, ${summary.groups.length} groups)`];
	for (const group of summary.groups) {
		lines.push(`  ${group.questionId} [${group.variant}/${group.provider}]: ${group.runs} run(s), score ${group.meanScore.toFixed(1)} ± ${group.scoreStdDev.toFixed(1)}, support ${(group.meanClaimSupportRate * 100).toFixed(0)}%, fetch ${(group.meanFetchedCoverage * 100).toFixed(0)}%`);
	}
	return lines.join("\n");
}

function buildBaseline(runs: SearchBenchmarkRun[]): { generatedAt: string; variant: string; runs: SearchBenchmarkRun[]; summary: ReturnType<typeof summarizeSearchBenchmarkRuns> } {
	return {
		generatedAt: new Date().toISOString(),
		variant: runs[0]?.variant ?? "unknown",
		runs,
		summary: summarizeSearchBenchmarkRuns(runs),
	};
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
	const args = process.argv.slice(2);
	const variantIndex = args.indexOf("--variant");
	const jsonIndex = args.indexOf("--json");
	const humanIndex = args.indexOf("--human");
	const variant = variantIndex >= 0 ? args[variantIndex + 1]?.trim() || "runtime-planned" : "runtime-planned";
	const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1]?.trim() : undefined;
	const wantHuman = humanIndex >= 0;
	const positionalArgs = args.filter((arg, index) => {
		if (arg === "--variant" || arg === "--json" || arg === "--human") return false;
		if (index === variantIndex + 1 || index === jsonIndex + 1) return false;
		return true;
	});
	const runDirs = positionalArgs.map((dir) => path.resolve(dir));

	if (runDirs.length === 0) {
		process.stderr.write("Usage: npm run benchmark:workflow -- [--variant name] [--json <path>] [--human] <workflow-run-dir> [...]\n");
		process.exitCode = 1;
	} else {
		const fixtures = questions();
		const runs = runDirs.map((runDir) => loadRun(runDir, fixtures, variant));
		if (jsonPath) {
			fs.writeFileSync(jsonPath, JSON.stringify(buildBaseline(runs), null, 2));
			process.stdout.write(`Baseline written to ${jsonPath}\n`);
		}
		if (wantHuman) {
			process.stdout.write(`${humanSummary(runs)}\n\n`);
		}
		// Default: markdown table + JSON summary to stdout (unless only --json was requested)
		if (!jsonPath || wantHuman) {
			process.stdout.write(`${markdown(runs)}\n\n${JSON.stringify(summarizeSearchBenchmarkRuns(runs), null, 2)}\n`);
		}
	}
}
