#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage(message) {
	if (message) console.error(message);
	console.error("Usage: check-test-baseline.mjs --tap FILE --allow-file FILE --allow-full-name NAME --require-diagnostic TEXT");
	process.exit(2);
}

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) usage("Invalid arguments.");
		args[flag.slice(2)] = value;
	}
	for (const required of ["tap", "allow-file", "allow-full-name", "require-diagnostic"]) {
		if (!args[required]) usage(`Missing --${required}.`);
	}
	return args;
}

function indent(line) {
	return line.match(/^ */)?.[0].length ?? 0;
}

function matchesDiagnosticFingerprint(diagnostic, required) {
	if (diagnostic.includes(required)) return true;
	if (required !== ".pi/agents") return false;
	const requiredAdditions = ["codebase-mapper", "executor", "integration-checker", "phase-researcher", "plan-checker", "planner", "reviewer", "verifier"];
	return diagnostic.includes("Expected values to be strictly deep-equal")
		&& diagnostic.includes("operator: 'deepStrictEqual'")
		&& requiredAdditions.every((agent) => diagnostic.includes(`'${agent}'`));
}

function parseTap(tap) {
	const lines = tap.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const headerIndex = lines.indexOf("TAP version 13");
	if (headerIndex < 0) throw new Error("Missing TAP version 13 header.");
	const preamble = lines.slice(0, headerIndex);
	if (preamble.some((line) => line.trim() && !line.startsWith("> "))) throw new Error("Unrecognized content before TAP header.");
	lines.splice(0, headerIndex);

	const root = { name: "<root>", indent: -4, assertions: [], plan: undefined };
	const openSubtests = [];
	const subtests = [];
	const assertions = [];
	const leaves = [];
	let summaryStart = -1;

	for (let index = 1; index < lines.length; index++) {
		const line = lines[index];
		if (/^# tests \d+$/.test(line)) {
			summaryStart = index;
			break;
		}

		const subtestMatch = line.match(/^(\s*)# Subtest: (.+)$/);
		if (subtestMatch) {
			const level = subtestMatch[1].length;
			const parent = level === 0 ? root : openSubtests.at(-1);
			if (!parent || parent.indent + 4 !== level) throw new Error(`Subtest '${subtestMatch[2]}' has no valid parent level.`);
			const node = {
				indent: level,
				name: subtestMatch[2],
				fullName: [...openSubtests.map((entry) => entry.name), subtestMatch[2]].join(" > "),
				assertions: [],
				plan: undefined,
				aggregate: undefined,
			};
			openSubtests.push(node);
			subtests.push(node);
			continue;
		}

		const assertionMatch = line.match(/^(\s*)(ok|not ok) (\d+) - (.+)$/);
		if (assertionMatch) {
			const level = assertionMatch[1].length;
			const directive = assertionMatch[4].match(/\s+# (SKIP|TODO)(?:\s+.*)?$/)?.[1]?.toLowerCase();
			const assertionName = assertionMatch[4].replace(/\s+# (?:SKIP|TODO)(?:\s+.*)?$/, "");
			const closing = openSubtests.at(-1);
			if (!closing || closing.indent !== level || closing.name !== assertionName) {
				throw new Error(`Assertion '${assertionMatch[4]}' does not close the current nested subtest.`);
			}
			let end = index + 1;
			while (end < lines.length && (lines[end].trim() === "" || indent(lines[end]) > level)) end++;
			const block = lines.slice(index, end).join("\n");
			const aggregate = /failureType:\s*'subtestsFailed'/.test(block);
			const cancelled = /failureType:\s*'(?:cancelledByParent|testTimeoutFailure)'/.test(block);
			const entry = {
				ok: assertionMatch[2] === "ok",
				number: Number(assertionMatch[3]),
				name: assertionName,
				fullName: closing.fullName,
				level,
				block,
				aggregate,
				directive,
				cancelled,
				node: closing,
			};
			closing.aggregate = entry;
			openSubtests.pop();
			const parent = level === 0 ? root : openSubtests.at(-1);
			if (!parent || parent.indent + 4 !== level) throw new Error(`Assertion '${entry.name}' has no valid parent level.`);
			parent.assertions.push(entry);
			assertions.push(entry);
			if (!entry.ok && !aggregate && !directive && !cancelled) {
				const location = block.match(/location:\s*'([^']+)'/)?.[1];
				const file = location?.replace(/:\d+:\d+$/, "");
				leaves.push({ fullName: entry.fullName, file, diagnostic: block, node: closing });
			}
			continue;
		}

		const planMatch = line.match(/^(\s*)1\.\.(\d+)$/);
		if (planMatch) {
			const level = planMatch[1].length;
			const owner = level === 0 ? root : openSubtests.at(-1);
			if (!owner || owner.indent + 4 !== level) throw new Error(`Plan at indentation ${level} has no parent subtest.`);
			if (owner.plan !== undefined) throw new Error(`Duplicate plan for '${owner.name}'.`);
			owner.plan = Number(planMatch[2]);
			continue;
		}

		if (line.trim() === "" || /^# (?!tests |suites |pass |fail |cancelled |skipped |todo |duration_ms )/.test(line) || /^\s+(?:---|\.\.\.|#|[A-Za-z][A-Za-z0-9_-]*:|[-+ ].*)/.test(line)) continue;
		throw new Error(`Unparsed TAP content before summary: ${line}`);
	}

	if (summaryStart < 0) throw new Error("Missing TAP summary.");
	if (openSubtests.length > 0) throw new Error(`Unclosed nested subtest '${openSubtests.at(-1).name}'.`);
	if (root.plan === undefined) throw new Error("Missing top-level TAP plan.");

	const summary = {};
	let index = summaryStart;
	for (; index < lines.length; index++) {
		const match = lines[index].match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/);
		if (!match) break;
		summary[match[1]] = Number(match[2]);
	}
	if (index !== lines.length) throw new Error(`Trailing unparsed TAP content: ${lines[index]}`);
	for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
		if (summary[key] === undefined) throw new Error(`Missing # ${key} summary.`);
	}

	for (const container of [root, ...subtests.filter((node) => node.plan !== undefined || node.assertions.length > 0)]) {
		if (container.plan === undefined) throw new Error(`Missing plan for '${container.name}'.`);
		if (container.assertions.length !== container.plan || container.assertions.some((entry, assertionIndex) => entry.number !== assertionIndex + 1)) {
			throw new Error(`Plan/assertion mismatch for '${container.name}'.`);
		}
	}
	for (const node of subtests) {
		if (!node.aggregate) throw new Error(`Missing aggregate assertion for '${node.fullName}'.`);
		if (node.assertions.length > 0) {
			const hasFailedChild = node.assertions.some((entry) => !entry.ok);
			if (node.aggregate.ok === hasFailedChild) throw new Error(`Aggregate result mismatch for '${node.fullName}'.`);
			if (!node.aggregate.ok && !node.aggregate.aggregate) throw new Error(`Failed suite aggregate '${node.fullName}' lacks subtestsFailed diagnostic.`);
		}
	}

	const leafClosures = subtests.filter((node) => node.assertions.length === 0).map((node) => node.aggregate);
	const actual = { tests: leafClosures.length, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
	for (const closure of leafClosures) {
		if (closure.directive === "skip") actual.skipped++;
		else if (closure.directive === "todo") actual.todo++;
		else if (closure.cancelled) actual.cancelled++;
		else if (closure.ok) actual.pass++;
		else actual.fail++;
	}
	for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
		if (summary[key] !== actual[key]) throw new Error(`TAP # ${key}/leaf-closure mismatch: summary ${summary[key]}, actual ${actual[key]}.`);
	}
	const failedTop = root.assertions.filter((entry) => !entry.ok).length;
	if (failedTop === 0 || actual.fail !== leaves.length) throw new Error("TAP failed-leaf classification mismatch.");
	return leaves;
}

const args = parseArgs(process.argv.slice(2));
try {
	const failures = parseTap(fs.readFileSync(args.tap, "utf-8"));
	if (failures.length !== 1) throw new Error(`Expected exactly 1 allowed failure, found ${failures.length}.`);
	const [failure] = failures;
	const normalizedFile = failure.file?.split(path.sep).join("/");
	const allowedFile = args["allow-file"].split(path.sep).join("/");
	if (!normalizedFile || !(normalizedFile === allowedFile || normalizedFile.endsWith(`/${allowedFile}`))) throw new Error(`Failure file mismatch: ${failure.file ?? "unassociated"}.`);
	if (failure.fullName !== args["allow-full-name"]) throw new Error(`Failure name mismatch: ${failure.fullName}.`);
	if (!matchesDiagnosticFingerprint(failure.diagnostic, args["require-diagnostic"])) throw new Error(`Failure diagnostic lacks required fingerprint '${args["require-diagnostic"]}'.`);
	console.log(`TAP baseline matched exactly 1 allowed failure: ${failure.fullName}`);
} catch (error) {
	console.error(`TAP baseline rejected: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
