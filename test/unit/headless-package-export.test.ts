import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("headless package export", () => {
	it("resolves pi-agents-flow/headless through package exports", async () => {
		const headless = await import("pi-agents-flow/headless");
		assert.equal(typeof headless.createHeadlessExtension, "function");
		assert.equal(typeof headless.createScriptedDecisionProvider, "function");
		assert.equal(typeof headless.buildChildEnvironment, "function");
	});

	it("headless entry does not reverse-import the interactive index.ts entry", () => {
		const source = fs.readFileSync(path.join(projectRoot, "src", "extension", "headless.ts"), "utf8");
		assert.doesNotMatch(source, /from\s+["'].*index\.ts["']/, "headless must not import the interactive entry");
	});

	it("headless entry resolves with zero pi-tui or src/tui modules under forbid-ui-loader", () => {
		const script = String.raw`
			import { createHeadlessExtension, defaultScriptedProvider } from "./src/extension/headless.ts";
			import { createHeadlessWorkflowInteraction } from "./src/workflows/interaction.ts";
			const provider = defaultScriptedProvider({ policyVersion: "v1" });
			const audit = { write() {} };
			const factory = createHeadlessExtension({
				decisionProvider: provider,
				decisionAuditSink: audit,
				policyVersion: "v1",
			});
			const interaction = createHeadlessWorkflowInteraction({
				provider,
				audit,
				policyVersion: "v1",
				approveThreshold: 0.9,
				timeoutMs: 50,
				traceId: (k) => "headless-package-export:" + k,
				evidenceSufficient: () => true,
				policyAllowsApproval: () => true,
			});
			if (typeof factory !== "function") throw new Error("createHeadlessExtension must return a factory");
			if (typeof interaction.clarify !== "function") throw new Error("interaction missing");
			process.stdout.write("headless-zero-ui-ok");
		`;
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/forbid-ui-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, encoding: "utf-8" },
		);
		assert.match(output, /headless-zero-ui-ok/);
	});

	it("createHeadlessExtension rejects model network access", async () => {
		const headless = await import("pi-agents-flow/headless");
		const provider = { async decide() { throw new Error("unused"); } };
		const audit = { write() {} };
		assert.throws(
			() => headless.createHeadlessExtension({
				decisionProvider: provider,
				decisionAuditSink: audit,
				policyVersion: "v1",
				allowModelNetwork: true,
			}),
			/does not allow model network access/,
		);
	});

	it("default `.` entry is unchanged", async () => {
		const entry = await import("pi-agents-flow");
		assert.equal(typeof entry.default, "function");
		assert.match(fs.readFileSync(path.join(projectRoot, "index.ts"), "utf8").trim(), /^export \{ default \} from "\.\/src\/extension\/index\.ts";$/);
	});
});
