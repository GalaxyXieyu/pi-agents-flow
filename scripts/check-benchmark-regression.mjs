// Benchmark regression gate for CI.
//
// Compares a fresh benchmark JSON against a stored baseline and reports any
// metric that regressed beyond `--threshold` (a percentage, default 20%).
// Deliberately advisory: it prints warnings but exits 0, so a slow machine or a
// genuinely heavier workload never blocks a deploy. Upgrade to a hard failure by
// passing `--fail` when you want the gate enforced.
//
// Usage:
//   node scripts/check-benchmark-regression.mjs --baseline ci/baseline.json --current ci/latest.json [--threshold 20] [--fail]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function usage() {
	process.stderr.write(
		"Usage: node scripts/check-benchmark-regression.mjs --baseline <json> --current <json> [--threshold <pct>] [--fail]\n",
	);
	process.exitCode = 2;
}

function parseArgs() {
	const args = process.argv.slice(2);
	const options = { baseline: undefined, current: undefined, threshold: 20, fail: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--baseline") options.baseline = args[++i];
		else if (arg === "--current") options.current = args[++i];
		else if (arg === "--threshold") options.threshold = Number(args[++i]);
		else if (arg === "--fail") options.fail = true;
		else {
			process.stderr.write(`Unknown option: ${arg}\n`);
			usage();
		}
	}
	return options;
}

function flatten(prefix, value, out) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) flatten(`${prefix ? `${prefix}.` : ""}${key}`, child, out);
		return;
	}
	if (value !== null && value !== undefined) out[prefix] = value;
}

async function main() {
	const options = parseArgs();
	if (!options.baseline || !options.current) return usage();
	const [baselineRaw, currentRaw] = await Promise.all([
		readFile(fileURLToPath(new URL(options.baseline, `file://${process.cwd()}/`)), "utf-8"),
		readFile(fileURLToPath(new URL(options.current, `file://${process.cwd()}/`)), "utf-8"),
	]);
	const baseline = JSON.parse(baselineRaw);
	const current = JSON.parse(currentRaw);
	const baselineFlat = {};
	const currentFlat = {};
	flatten("", baseline, baselineFlat);
	flatten("", current, currentFlat);

	const warnings = [];
	for (const [key, baseValue] of Object.entries(baselineFlat)) {
		if (!(key in currentFlat)) continue;
		const curValue = currentFlat[key];
		if (typeof baseValue !== "number" || typeof curValue !== "number") continue;
		if (baseValue === 0) continue; // avoid divide-by-zero
		const deltaPct = ((curValue - baseValue) / Math.abs(baseValue)) * 100;
		if (deltaPct > options.threshold) {
			warnings.push(`${key}: ${baseValue} -> ${curValue} (+${deltaPct.toFixed(1)}% > ${options.threshold}%)`);
		}
	}

	if (warnings.length > 0) {
		for (const warning of warnings) process.stderr.write(`[benchmark-regression] ${warning}\n`);
		if (options.fail) {
			process.stderr.write("Benchmark regression gate FAILED (--fail).\n");
			process.exitCode = 1;
		} else {
			process.stderr.write("Benchmark regression warning only (advisory; pass --fail to enforce).\n");
		}
	} else {
		process.stdout.write("Benchmark regression: no metric exceeded threshold.\n");
	}
}

main().catch((error) => {
	process.stderr.write(`check-benchmark-regression failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});