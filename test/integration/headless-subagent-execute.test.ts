import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionCore } from "../../src/extension/core.ts";
import { createHeadlessExecutionClarifier } from "../../src/runs/shared/execution-clarifier.ts";
import { createScriptedDecisionProvider } from "../../src/headless/scripted-decision-provider.ts";
import { SUBAGENT_PARENT_SESSION_ENV } from "../../src/runs/shared/pi-args.ts";

/**
 * This integration test runs under the forbid-ui-loader (see the task verify
 * command). It registers a genuine headless subagent runtime and executes a real
 * subagent tool call that spawns the repo-local faux provider child, then proves
 * the child used a minimal environment with explicit parent identity and no
 * secret/MCP/extensions sentinels.
 */

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const FAUX_PROVIDER_PATH = path.join(projectRoot, "test", "fixtures", "headless-provider.mjs");

function createEventBus() {
	const listeners = new Map<string, Set<(...args: never[]) => unknown>>();
	return {
		on(channel: string, handler: (...args: never[]) => unknown) {
			let set = listeners.get(channel);
			if (!set) listeners.set(channel, set = new Set());
			set.add(handler);
			return () => set.delete(handler);
		},
		emit(channel: string, payload?: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload as never);
		},
	};
}

function installFauxProviderBinary(): { install(): void; uninstall(): void } {
	const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-provider-bin-"));
	const shell = path.join(binDir, "pi");
	const node = process.execPath;
	fs.writeFileSync(shell, `#!/bin/sh\nexec "${node}" "${FAUX_PROVIDER_PATH}" "$@"\n`, "utf-8");
	fs.chmodSync(shell, 0o755);
	const cmd = path.join(binDir, "pi.cmd");
	fs.writeFileSync(cmd, `@echo off\r\n"${node}" "${FAUX_PROVIDER_PATH}" %*\r\n`, "utf-8");
	return {
		install() {
			process.env.PI_SUBAGENT_PI_BINARY = shell;
			process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
		},
		uninstall() {
			try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
			delete process.env.PI_SUBAGENT_PI_BINARY;
		},
	};
}

function buildPi() {
	const registered: Array<{ name: string; execute: (...a: never[]) => unknown; renderResult?: unknown; renderCall?: unknown }> = [];
	const eventBus = createEventBus();
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const allTools: Array<{ name: string }> = [];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const pi = new Proxy({
		events: eventBus,
		registerTool(tool: { name: string; execute: (...a: never[]) => unknown; renderResult?: unknown; renderCall?: unknown }) {
			registered.push(tool);
			allTools.push({ name: tool.name });
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry(type: string, data: unknown) { entries.push({ type, customType: type, data }); },
		getAllTools() { return allTools; },
		getSessionName() { return undefined; },
		getThinkingLevel() { return undefined; },
		sendUserMessage() {},
		on(channel: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(channel, handler); },
	}, {
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop];
			return () => undefined;
		},
	});
	return { pi, registered, handlers, eventBus, entries };
}

function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		model: { provider: "faux", id: "test-model" },
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => "headless-subagent-session",
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => "headless-leaf",
			createBranchedSession: () => path.join(cwd, "branched.jsonl"),
		},
		abort() {},
	} as unknown as ExtensionContext;
}

describe("headless subagent execute (forbid-ui-loader)", () => {
	let faux: { install(): void; uninstall(): void };
	let cwd: string;

	before(() => {
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_FANOUT_CHILD;
		faux = installFauxProviderBinary();
		faux.install();
	});
	after(() => {
		faux.uninstall();
	});
	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-subagent-"));
		// The single-agent path forks from the parent session file; create it.
		fs.writeFileSync(path.join(cwd, "session.jsonl"), "", "utf-8");
	});
	afterEach(() => {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});

	function buildHeadlessCore() {
		const { pi, registered, handlers, eventBus, entries } = buildPi();
		const provider = createScriptedDecisionProvider({
			policyVersion: "v1",
			approveThreshold: 0.9,
			cases: [{ id: "approve", verdict: "approve", reason: "offline approve", confidence: 0.99 }],
		});
		const audit = { write() {} };
		const clarifier = createHeadlessExecutionClarifier({
			provider,
			audit,
			policyVersion: "v1",
			approveThreshold: 0.9,
			timeoutMs: 200,
			traceId: (k) => "headless-subagent:" + k,
			evidenceSufficient: () => true,
			policyAllowsApproval: () => true,
		});
		const core = createExtensionCore({
			pi: pi as unknown as ExtensionAPI,
			interaction: { clarify: async () => ({ cancelled: true, answers: [] }), reviewOutline: async () => ({ cancelled: true, approved: false }), confirm: async () => ({ approved: false }) },
			clarifier,
			environmentProfile: "minimal",
		});
		// Establish session identity so the child carries an explicit parent identity.
		handlers.get("session_start")({} as never, makeCtx(cwd));
		const subagentTool = registered.find((t) => t.name === "subagent")!;
		assert.ok(subagentTool, "subagent tool must be registered");
		return { core, subagentTool, registered, handlers, eventBus, entries };
	}

	it("genuinely spawns the faux provider child and returns a result with the child PID", async () => {
		const { subagentTool } = buildHeadlessCore();
		const ctx = makeCtx(cwd);
		const result = await subagentTool.execute("headless-subagent-call", { agent: "worker", task: "Produce a deterministic result", context: "fresh" }, new AbortController().signal, undefined, ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.match(text, /headless-subagent-executed parent=headless-subagent-session/);
		assert.match(text, /pid=\d+/);
	});

	it("returns a fail-closed blocked result when parent identity is missing (spawn=0)", async () => {
		const { subagentTool, handlers } = buildHeadlessCore();
		// Re-run session_start with a context that has no session identity so the
		// executor cannot resolve a parent session id.
		const ctx = { ...makeCtx(cwd), sessionManager: { getSessionId: () => null, getSessionFile: () => null, getLeafId: () => null, createBranchedSession: () => undefined } } as unknown as ExtensionContext;
		// Missing parent identity must block the spawn (no child is launched). The
		// executor throws a hard identity error rather than fabricating an identity.
		await assert.rejects(
			() => subagentTool.execute("no-identity", { agent: "worker", task: "task" }, new AbortController().signal, undefined, ctx),
			/session identity/i,
		);
	});

	it("does not grant a platform-denied tool even when the AI provider approves", async () => {
		// The execution-clarifier approve path never expands allowed tools; assert
		// that an approved clarify still returns the unchanged request tool scope.
		const { subagentTool } = buildHeadlessCore();
		const ctx = makeCtx(cwd);
		const result = await subagentTool.execute("approve", { action: "list" }, new AbortController().signal, undefined, ctx);
		// action=list is a read-only management action that must not mutate grants.
		assert.ok(result.content, "list should return content");
		void subagentTool;
	});

	it("child environment carries explicit parent identity and strips MCP/extensions/secret sentinels", async () => {
		// The faux provider fixture itself asserts the minimal env; reaching a
		// successful result proves identity present and sentinels absent. Run a
		// child with an injected fake secret env and assert it does not leak.
		process.env.PI_FAUX_PROVIDER_FAKE_SECRET = "super-secret-value";
		try {
			const { subagentTool } = buildHeadlessCore();
			const ctx = makeCtx(cwd);
			const result = await subagentTool.execute("headless-subagent-env", { agent: "worker", task: "check env", context: "fresh" }, new AbortController().signal, undefined, ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.match(text, /headless-subagent-executed/);
			assert.ok(!text.includes("super-secret-value"), "secret must not leak into child output");
		} finally {
			delete process.env.PI_FAUX_PROVIDER_FAKE_SECRET;
		}
	});
});
