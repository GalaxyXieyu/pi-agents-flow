import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	return env;
}

describe("default interactive entry", () => {
	it("still registers the subagent tool, workflow commands, renderers, and Activity Dock", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			const tools = [];
			const commands = [];
			const renderers = [];
			let dockRegistered = false;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { tools.push(tool.name); },
				registerCommand(name) { commands.push(name); },
				registerShortcut() {},
				registerMessageRenderer(type) { renderers.push(type); },
				sendMessage() {},
				getAllTools() { return tools.map((name) => ({ name })); },
				appendEntry() {},
				getSessionName() { return undefined; },
				getThinkingLevel() { return undefined; },
				sendUserMessage() {},
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			const widgets = [];
			const realFakePi = new Proxy(fakePi, {
				get(target, prop) {
					if (prop === "setWidget") return (key, value) => widgets.push({ key, value });
					return target[prop];
				},
			});
			registerSubagentExtension(realFakePi);
			if (!tools.includes("subagent")) throw new Error("subagent tool not registered: " + tools.join(","));
			if (!tools.includes("workflow")) throw new Error("workflow tool not registered");
			if (!tools.includes("workflow_assets")) throw new Error("workflow_assets tool not registered");
			if (!tools.includes("subagent_wait")) throw new Error("subagent_wait tool not registered");
			if (!commands.includes("workflow")) throw new Error("/workflow command not registered");
			if (!commands.includes("subagents-watchdog")) throw new Error("watchdog command not registered");
			const hasDockRenderer = renderers.some((r) => typeof r === "string" && r.includes("workflow"));
			if (!hasDockRenderer && renderers.length === 0) throw new Error("no renderers registered");
			process.stdout.write(JSON.stringify({ tools, commands, renderers, widgets }));
		`;
		const env = parentToolEnv();
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env, encoding: "utf-8" },
		);
		const parsed = JSON.parse(output) as { tools: string[]; commands: string[]; renderers: string[]; widgets: Array<{ key: string; value: unknown }> };
		assert.ok(parsed.tools.includes("subagent"));
		assert.ok(parsed.tools.includes("workflow"));
		assert.ok(parsed.tools.includes("workflow_assets"));
		assert.ok(parsed.tools.includes("subagent_wait"));
		assert.ok(parsed.commands.includes("workflow"));
		assert.ok(parsed.commands.includes("subagents-watchdog"));
		assert.ok(parsed.renderers.length > 0);
	});

	it("registers the Activity Dock widget on session_start with UI", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const handlers = new Map();
			const events = { on(channel, handler) { handlers.set(channel, handler); return () => {}; }, emit(channel, payload) { const h = handlers.get(channel); if (h) h(payload); } };
			const widgets = [];
			const fakePi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, handler); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getAllTools() { return []; }, appendEntry() {},
				getSessionName() { return undefined; }, getThinkingLevel() { return undefined; },
				sendUserMessage() {},
			}, {
				get(target, prop) {
					if (prop === "setWidget") return (key, value) => widgets.push({ key, value });
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			const ctx = {
				cwd: process.cwd(), hasUI: true,
				ui: {
					setToolsExpanded() {}, setWidget(key, value) { widgets.push({ key, value }); }, requestRender() {},
					theme: { fg(_n, t) { return t; }, bg(_n, t) { return t; }, bold(t) { return t; } },
				},
				sessionManager: { getSessionId() { return "s"; }, getSessionFile() { return null; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			registerSubagentExtension(fakePi);
			handlers.get("session_start")({ reason: "startup" }, ctx);
			// Emit an async run so the Activity Dock has content to render and
			// registers its widget (an empty session hides the dock, which is the
			// intended behavior and proves nothing about the wiring).
			events.emit("subagent:async-started", { id: "dock-run", pid: 4242, sessionId: "s", mode: "single", agent: "worker", asyncDir: "/tmp/dock-run" });
			handlers.get("tool_result")({ toolName: "subagent" }, ctx);
			const dock = widgets.filter((w) => w.key === "pi-agents-flow-activity-dock" && w.value !== undefined);
			if (dock.length === 0) throw new Error("Activity Dock widget not registered: " + JSON.stringify(widgets));
			handlers.get("session_shutdown")();
			process.stdout.write("dock-ok");
		`;
		const env = parentToolEnv();
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env, encoding: "utf-8" },
		);
		assert.match(output, /dock-ok/);
	});
});
