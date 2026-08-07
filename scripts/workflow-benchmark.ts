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

const args = process.argv.slice(2);
const variantIndex = args.indexOf("--variant");
const variant = variantIndex >= 0 ? args[variantIndex + 1]?.trim() || "runtime-planned" : "runtime-planned";
const runDirs = args.filter((arg, index) => arg !== "--variant" && index !== variantIndex + 1).map((dir) => path.resolve(dir));
if (runDirs.length === 0) {
	process.stderr.write("Usage: npm run benchmark:workflow -- [--variant name] <workflow-run-dir> [...]\n");
	process.exitCode = 1;
} else {
	const fixtures = questions();
	const runs = runDirs.map((runDir) => loadRun(runDir, fixtures, variant));
	process.stdout.write(`${markdown(runs)}\n\n${JSON.stringify(summarizeSearchBenchmarkRuns(runs), null, 2)}\n`);
}
