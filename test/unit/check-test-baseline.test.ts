import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const script = path.resolve("scripts/check-test-baseline.mjs");
const tempFiles: string[] = [];

function leaf(input: { name: string; file: string; diagnostic: string }): string {
	return `    # Subtest: ${input.name}\n    not ok 1 - ${input.name}\n      ---\n      location: '${input.file}:111:2'\n      failureType: 'testCodeFailure'\n      error: |-\n        ${input.diagnostic}\n      ...\n`;
}

function tap(...leaves: string[]): string {
	return `TAP version 13\n# Subtest: agent invocation policy\n${leaves.join("")}    1..${leaves.length}\nnot ok 1 - agent invocation policy\n  ---\n  failureType: 'subtestsFailed'\n  error: '${leaves.length} subtest failed'\n  ...\n1..1\n# tests ${leaves.length}\n# pass 0\n# fail ${leaves.length}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function tapWithNonFailureOutcomes(baseline: string): string {
	const skip = "    # Subtest: skipped leaf\n    ok 2 - skipped leaf # SKIP unsupported here\n";
	const todo = "    # Subtest: todo leaf\n    not ok 3 - todo leaf # TODO later\n";
	const cancelled = "    # Subtest: cancelled leaf\n    not ok 4 - cancelled leaf\n      ---\n      failureType: 'cancelledByParent'\n      ...\n";
	return `TAP version 13\n# Subtest: agent invocation policy\n${baseline}${skip}${todo}${cancelled}    1..4\nnot ok 1 - agent invocation policy\n  ---\n  failureType: 'subtestsFailed'\n  ...\n1..1\n# tests 4\n# pass 0\n# fail 1\n# cancelled 1\n# skipped 1\n# todo 1\n`;
}

function classify(content: string) {
	const file = path.join(os.tmpdir(), `t147-baseline-${process.pid}-${tempFiles.length}.tap`);
	fs.writeFileSync(file, content);
	tempFiles.push(file);
	return spawnSync(process.execPath, [script, "--tap", file,
		"--allow-file", "test/unit/agent-invocation-policy.test.ts",
		"--allow-full-name", "agent invocation policy > keeps user-profile Coding workers hidden and model-only",
		"--require-diagnostic", ".pi/agents"], { encoding: "utf-8" });
}

afterEach(() => {
	for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

describe("TAP baseline classifier", () => {
	const baseline = leaf({
		name: "keeps user-profile Coding workers hidden and model-only",
		file: "/repo/test/unit/agent-invocation-policy.test.ts",
		diagnostic: "Expected workers discovered from .pi/agents to remain hidden",
	});

	it("accepts exactly the known baseline leaf", () => {
		const result = classify(tap(baseline));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /exactly 1 allowed failure/);
	});

	it("rejects a phantom pass claimed only by the summary", () => {
		const phantomPass = tap(baseline)
			.replace("# tests 1", "# tests 2")
			.replace("# pass 0", "# pass 1");
		assert.notEqual(classify(phantomPass).status, 0);
	});

	it("accepts and exactly counts skip, todo, and cancelled leaf closures", () => {
		const valid = tapWithNonFailureOutcomes(baseline);
		assert.equal(classify(valid).status, 0);
		for (const mutation of [
			valid.replace("# skipped 1", "# skipped 0").replace("# pass 0", "# pass 1"),
			valid.replace("# todo 1", "# todo 0").replace("# pass 0", "# pass 1"),
			valid.replace("# cancelled 1", "# cancelled 0").replace("# pass 0", "# pass 1"),
		]) assert.notEqual(classify(mutation).status, 0);
	});

	it("rejects another failure even when its diagnostic mentions the baseline text", () => {
		const other = leaf({
			name: "unrelated behavior",
			file: "/repo/test/unit/other.test.ts",
			diagnostic: "agent-invocation-policy .pi/agents keeps user-profile Coding workers hidden and model-only",
		});
		assert.notEqual(classify(tap(other)).status, 0);
	});

	it("rejects the baseline plus any second failure", () => {
		const extra = leaf({ name: "extra failure", file: "/repo/test/unit/extra.test.ts", diagnostic: "boom" });
		assert.notEqual(classify(tap(baseline, extra)).status, 0);
	});

	it("rejects a nested plan that claims more assertions than the allowlisted leaf", () => {
		assert.notEqual(classify(tap(baseline).replace("    1..1", "    1..2")).status, 0);
	});

	it("rejects nested assertion numbering gaps and duplicates", () => {
		assert.notEqual(classify(tap(baseline).replace("not ok 1 - keeps", "not ok 2 - keeps")).status, 0);
		assert.notEqual(classify(tap(baseline, baseline)).status, 0);
	});

	it("rejects a missing nested plan", () => {
		assert.notEqual(classify(tap(baseline).replace("    1..1\n", "")).status, 0);
	});

	it("rejects an extra nested assertion beyond its plan", () => {
		assert.notEqual(classify(tap(baseline, baseline).replace("    1..2", "    1..1")).status, 0);
	});

	it("rejects the baseline plus an unrelated suite-level failure", () => {
		const extraSuite = `# Subtest: unrelated suite\n    1..1\nnot ok 2 - unrelated suite\n  ---\n  failureType: 'subtestsFailed'\n  error: 'aggregate only'\n  ...\n`;
		assert.notEqual(classify(tap(baseline).replace("1..1\n# tests", `${extraSuite}1..2\n# tests`)).status, 0);
	});

	it("rejects valid baseline TAP with malformed trailing content", () => {
		assert.notEqual(classify(`${tap(baseline)}MALFORMED TRAILING TAP GARBAGE\n`).status, 0);
	});

	it("rejects aggregate-only name and diagnostic bait", () => {
		const bait = `TAP version 13\n# Subtest: agent invocation policy\n    1..1\nnot ok 1 - agent invocation policy\n  ---\n  failureType: 'subtestsFailed'\n  error: 'keeps user-profile Coding workers hidden and model-only .pi/agents'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n`;
		assert.notEqual(classify(bait).status, 0);
	});

	it("rejects malformed or unassociated failure TAP", () => {
		assert.notEqual(classify("TAP version 13\nnot ok 1 - unknown\n1..1\n# fail 1\n").status, 0);
	});
});
