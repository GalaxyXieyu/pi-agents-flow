import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const script = String.raw`
	import registerSubagentExtension from "./index.ts";
	const tools = [];
	const commands = [];
	const events = { on() { return () => {}; }, emit() {} };
	const fakePi = new Proxy({
		events,
		registerTool(tool) { tools.push(tool.name); },
		registerCommand(name) { commands.push(name); },
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry() {},
		getSessionName() { return undefined; },
	}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
	registerSubagentExtension(fakePi);
	process.stdout.write(JSON.stringify({ tools, commands }));
`;

function runExtension(child: boolean): { tools: string[]; commands: string[] } {
	const env = { ...process.env };
	if (child) env[SUBAGENT_CHILD_ENV] = "1";
	else delete env[SUBAGENT_CHILD_ENV];
	const output = execFileSync(process.execPath, [
		"--experimental-strip-types",
		"--import",
		"./test/support/register-loader.mjs",
		"--input-type=module",
		"--eval",
		script,
	], { cwd: projectRoot, env, encoding: "utf-8" });
	return JSON.parse(output) as { tools: string[]; commands: string[] };
}

describe("workflow extension registration", () => {
	it("registers workflow controls only in the root Pi session", () => {
		const parent = runExtension(false);
		assert.ok(parent.tools.includes("workflow"));
		assert.ok(parent.commands.includes("workflow"));
		assert.ok(parent.commands.includes("coding"));
		assert.ok(parent.commands.includes("deep-research"));
		assert.ok(parent.commands.includes("swarm"));

		const child = runExtension(true);
		assert.deepEqual(child.tools, []);
		assert.deepEqual(child.commands, []);
	});

	it("registers the asset catalog tool and composition command in the root session only", () => {
		const parent = runExtension(false);
		assert.ok(parent.tools.includes("workflow_assets"), "expected the workflow_assets tool");
		assert.ok(parent.commands.includes("composition"), "expected the /composition command");

		const child = runExtension(true);
		assert.equal(child.tools.includes("workflow_assets"), false);
		assert.equal(child.commands.includes("composition"), false);
	});
});
