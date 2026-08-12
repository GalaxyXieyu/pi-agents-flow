import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { buildPiArgs, SUBAGENT_PARENT_SESSION_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Fixture {
	pi: Record<string, unknown>;
	handlers: Map<string, Array<(event: unknown, ctx: any) => unknown>>;
	events: { emit(channel: string, payload: unknown): void };
	unsubscribed: string[];
	ctx: any;
}

function createFixture(sessionId: string): Fixture {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
	const unsubscribed: string[] = [];
	const events = {
		on(channel: string, handler: (payload: unknown) => void) {
			let listeners = eventListeners.get(channel);
			if (!listeners) eventListeners.set(channel, listeners = new Set());
			listeners.add(handler);
			return () => {
				listeners!.delete(handler);
				unsubscribed.push(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const listener of [...(eventListeners.get(channel) ?? [])]) listener(payload);
		},
	};
	const pi = new Proxy({
		events,
		on(channel: string, handler: (event: unknown, ctx: any) => unknown) {
			const listeners = handlers.get(channel) ?? [];
			listeners.push(handler);
			handlers.set(channel, listeners);
		},
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
		sendMessage() {}, appendEntry() {}, getSessionName() { return undefined; }, getAllTools() { return []; },
	}, { get(target, prop) { return prop in target ? target[prop as keyof typeof target] : () => undefined; } });
	const ctx = {
		cwd: projectRoot,
		hasUI: false,
		ui: { setWidget() {}, requestRender() {}, setToolsExpanded() {}, theme: { fg(_name: string, text: string) { return text; }, bg(_name: string, text: string) { return text; }, bold(text: string) { return text; } } },
		sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; }, getBranch() { return []; } },
		modelRegistry: { getAvailable() { return []; } },
	};
	return { pi, handlers, events, unsubscribed, ctx };
}

async function emitLifecycle(fixture: Fixture, channel: string, event: unknown = {}): Promise<void> {
	for (const handler of fixture.handlers.get(channel) ?? []) await handler(event, fixture.ctx);
}

describe("extension host instance isolation", () => {
	it("keeps interleaved factory instances independently owned", async () => {
		delete (globalThis as Record<string, unknown>).__piSubagentRuntimeCleanup;
		delete (globalThis as Record<string, unknown>).__piSubagentEventUnsubscribes;
		delete (globalThis as Record<string, unknown>).__piSubagentVisibleControlNotices;
		process.env[SUBAGENT_PARENT_SESSION_ENV] = "ambient-sentinel";

		const a = createFixture("parent-A");
		const b = createFixture("parent-B");
		registerSubagentExtension(a.pi as never);
		registerSubagentExtension(b.pi as never);
		await emitLifecycle(a, "session_start", { reason: "startup" });
		await emitLifecycle(b, "session_start", { reason: "startup" });

		assert.equal((globalThis as Record<string, unknown>).__piSubagentRuntimeCleanup, undefined);
		assert.equal((globalThis as Record<string, unknown>).__piSubagentEventUnsubscribes, undefined);
		assert.equal((globalThis as Record<string, unknown>).__piSubagentVisibleControlNotices, undefined);
		assert.equal(process.env[SUBAGENT_PARENT_SESSION_ENV], "ambient-sentinel");

		await emitLifecycle(a, "session_shutdown");
		assert.equal(process.env[SUBAGENT_PARENT_SESSION_ENV], "ambient-sentinel");
		assert.equal(b.unsubscribed.length, 0, "shutting down A must not unsubscribe B");
		b.events.emit("subagent:async-started", { id: "b-run", pid: 1, sessionId: "parent-B", mode: "single", agent: "worker", asyncDir: "/tmp/b-run" });
		await emitLifecycle(b, "tool_result", { toolName: "subagent" });
		await emitLifecycle(b, "session_shutdown");

		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
	});

	it("fails closed without an explicit parent session id", () => {
		process.env[SUBAGENT_PARENT_SESSION_ENV] = "ambient-parent";
		assert.throws(() => buildPiArgs({
			baseArgs: ["-p"], task: "hello", sessionEnabled: false,
			inheritProjectContext: false, inheritSkills: false,
		}), /parentSessionId/i);
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
	});

	it("contains no process-global cleanup ownership or session lifecycle env writes", () => {
		const source = fs.readFileSync(path.join(projectRoot, "src", "extension", "index.ts"), "utf-8");
		assert.doesNotMatch(source, /__piSubagent(?:RuntimeCleanup|EventUnsubscribes|VisibleControlNotices)/);
		assert.doesNotMatch(source, /process\.env\[SUBAGENT_PARENT_SESSION_ENV\]\s*=/);
		assert.doesNotMatch(source, /delete process\.env\[SUBAGENT_PARENT_SESSION_ENV\]/);
	});
});
