import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationInvalidResponse,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../../src/api/delegation.ts";
import { parseSubagentDelegationRequest } from "../../src/slash/delegation-request.ts";
import {
	registerPromptTemplateDelegationBridge,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const request: SubagentDelegationRequest = {
	version: 2,
	requestId: "attempt-1",
	ownerRunId: "owner-1",
	nodeId: "node-1",
	agent: "reviewer",
	task: "Review evidence",
	context: "fresh",
	cwd: "/repo",
	model: "openai/gpt-5",
	thinking: "high",
	timeoutMs: 1_000,
	turnBudget: { maxTurns: 4, graceTurns: 1 },
	toolBudget: { soft: 3, hard: 5, block: "*" },
	skill: ["review"],
	artifacts: true,
	result: { kind: "structured", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
};

describe("public subagent delegation contract", () => {
	it("uses the existing prompt-template event family as the only transport", () => {
		assert.equal(SUBAGENT_DELEGATION_PROTOCOL_VERSION, 2);
		assert.equal(SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
		assert.equal(SUBAGENT_DELEGATION_STARTED_EVENT, "prompt-template:subagent:started");
		assert.equal(SUBAGENT_DELEGATION_UPDATE_EVENT, "prompt-template:subagent:update");
		assert.equal(SUBAGENT_DELEGATION_RESPONSE_EVENT, "prompt-template:subagent:response");
		assert.equal(SUBAGENT_DELEGATION_CANCEL_EVENT, "prompt-template:subagent:cancel");
	});

	it("strictly parses the complete request and enforces its allowlists and bounds", () => {
		assert.equal(SUBAGENT_DELEGATION_PROTOCOL_VERSION, 2);
		assert.deepEqual(parseSubagentDelegationRequest(request), { ok: true, request: request });
		const malformed = [
			[{ ...request, ownerRunId: "bad\nowner" }, /ownerRunId.*256 characters without newlines/],
			[{ ...request, nodeId: "x".repeat(257) }, /nodeId.*256 characters without newlines/],
			[{ ...request, thinking: "extreme" }, /thinking must be one of/],
			[{ ...request, output: false }, /Unsupported delegation field: output/],
			[{ ...request, outputMode: "inline" }, /Unsupported delegation field: outputMode/],
			[{ ...request, agentContract: { version: 1 } }, /Unsupported delegation field: agentContract/],
			[{ ...request, acceptance: false }, /Unsupported delegation field: acceptance/],
			[{ ...request, result: { kind: "text", schema: {} } }, /result.schema is not supported/],
			[{ ...request, result: { kind: "structured" } }, /result.schema must be a JSON Schema object/],
			[{ ...request, task: "é".repeat(524_289) }, /task exceeds 1 MiB/],
			[{ ...request, cwd: "é".repeat(16_385) }, /cwd exceeds 32 KiB/],
			[{ ...request, agent: "é".repeat(513) }, /agent exceeds 1 KiB/],
			[{ ...request, model: "é".repeat(513) }, /model exceeds 1 KiB/],
			[{ ...request, skill: "é".repeat(513) }, /skill entry exceeds 1 KiB/],
			[{ ...request, skill: Array.from({ length: 257 }, () => "x") }, /skill supports at most 256 entries/],
			[{ ...request, skill: Array.from({ length: 256 }, () => "x".repeat(257)) }, /skill entries exceed 64 KiB in aggregate/],
			[{ ...request, result: { kind: "structured", schema: { value: "x".repeat(65_536) } } }, /result.schema exceeds 64 KiB/],
			[{ ...request, timeoutMs: 2_147_483_648 }, /timeoutMs must be <= 2147483647 for delegation/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("accepts an exact zero tool budget", () => {
		const zeroBudget = { hard: 0, block: "*" as const };
		const parsed = parseSubagentDelegationRequest({ ...request, toolBudget: zeroBudget });
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.deepEqual(parsed.request.toolBudget, zeroBudget);

		for (const soft of [0, 1]) {
			assert.equal(parseSubagentDelegationRequest({ ...request, toolBudget: { ...zeroBudget, soft } }).ok, false);
		}
	});

	it("rejects non-JSON schemas without executing toJSON hooks", () => {
		let calls = 0;
		const parsed = parseSubagentDelegationRequest({
			...request,
			result: {
				kind: "structured",
				schema: { toJSON: () => { calls++; return {}; } },
			},
		});
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /result.schema must be plain JSON data/);
		assert.equal(calls, 0);
	});

	it("rejects unsupported versions, unknown fields, aliases, and malformed controls", () => {
		const malformed = [
			[{ ...request, version: 1 }, /Unsupported delegation protocol version/],
			[{ ...request, tools: ["write"] }, /Unsupported delegation field: tools/],
			[{ ...request, maxRuntimeMs: 1_000 }, /Unsupported delegation field: maxRuntimeMs/],
			[{ ...request, timeoutMs: 0 }, /timeoutMs must be an integer >= 1/],
			[{ ...request, turnBudget: { maxTurns: 0 } }, /turnBudget.maxTurns/],
			[{ ...request, turnBudget: { maxTurns: 1, extra: true } }, /turnBudget.extra is not supported/],
			[{ ...request, toolBudget: { hard: 1, soft: 2 } }, /toolBudget.soft must be <=/],
			[{ ...request, toolBudget: { hard: 1, extra: true } }, /toolBudget.extra is not supported/],
			[{ ...request, skill: [] }, /skill must/],
			[{ ...request, output: "result.md" }, /Unsupported delegation field: output/],
			[{ ...request, outputSchema: {} }, /Unsupported delegation field: outputSchema/],
			[{ ...request, agentContract: { version: 1 } }, /Unsupported delegation field: agentContract/],
			[{ ...request, acceptance: "checked" }, /Unsupported delegation field: acceptance/],
			[{ ...request, artifacts: "yes" }, /artifacts must be a boolean/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("runs through the versioned executor and preserves literal text with full effective metadata", async () => {
		const events = new FakeEvents();
		let ordinaryCalls = 0;
		let observedParams: Record<string, unknown> | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				ordinaryCalls++;
				return { details: { mode: "single", results: [] } };
			},
			executeVersioned: async (_id, params, _signal, _ctx, onUpdate) => {
				observedParams = params as unknown as Record<string, unknown>;
				onUpdate({ details: { mode: "single", runId: "run-v2", results: [{ agent: "reviewer", model: "openai/gpt-5", thinking: "high" }], progress: [{ currentTool: "read" }] } });
				return {
					details: {
						mode: "single",
						runId: "run-v2",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							model: "openai/gpt-5",
							thinking: "high",
							launchContractDigest: "launch-contract-digest",
							finalOutput: '{"looks":"json"}',
							usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 6, tokens: 5, durationMs: 7 },
						}],
					},
				};
			},
		});
		const textRequest = { ...request, result: { kind: "text" as const } };
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const updatePromise = once(events, SUBAGENT_DELEGATION_UPDATE_EVENT);
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, textRequest);
		assert.deepEqual(await startedPromise, { version: 2, requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1" });
		assert.deepEqual(await updatePromise, { version: 2, requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1", runId: "run-v2", currentTool: "read", model: "openai/gpt-5" });
		assert.deepEqual(await responsePromise, {
			version: 2,
			requestId: "attempt-1",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			status: "completed",
			runId: "run-v2",
			agent: "reviewer",
			model: "openai/gpt-5",
			thinking: "high",
			exitCode: 0,
			launchContractDigest: "launch-contract-digest",
			result: { kind: "text", text: '{"looks":"json"}' },
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2, toolCalls: 6, durationMs: 7 },
		} satisfies SubagentDelegationResponse);
		assert.equal(ordinaryCalls, 0);
		assert.deepEqual(observedParams, {
			agent: "reviewer",
			task: "Review evidence",
			context: "fresh",
			cwd: "/repo",
			model: "openai/gpt-5",
			timeoutMs: 1_000,
			turnBudget: { maxTurns: 4, graceTurns: 1 },
			enforceHardTurnLimit: true,
			toolBudget: { soft: 3, hard: 5, block: "*" },
			skill: ["review"],
			output: false,
			acceptance: false,
			artifacts: true,
			delegatedThinkingOverride: "high",
			delegatedAllowZeroToolBudget: true,
			async: false,
			foregroundOnly: true,
			clarify: false,
		});
		bridge.dispose();
	});

	it("projects structured values and fails missing or oversized captures", async () => {
		const cases = [
			[{ ok: true }, "completed", { kind: "structured", value: { ok: true } }],
			[undefined, "failed", undefined],
			[{ value: "x".repeat(1024 * 1024) }, "failed", undefined],
		] as const;
		for (const [structuredOutput, expectedStatus, expectedResult] of cases) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => { throw new Error("ordinary executor must remain separate"); },
				executeVersioned: async () => ({
					details: {
						mode: "single",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							...(structuredOutput === undefined ? {} : { structuredOutput }),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `structured-${expectedStatus}-${Math.random()}` });
			const response = await responsePromise as SubagentDelegationResponse;
			assert.equal(response.status, expectedStatus);
			assert.deepEqual(response.result, expectedResult);
			if (expectedStatus === "failed") assert.match(response.error ?? "", /structured result/);
			bridge.dispose();
		}
	});

	it("projects a foreground detach as a correlated non-terminal handoff", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => ({
				details: {
					mode: "single",
					runId: "child-detached-1",
					results: [{
						agent: "reviewer",
						exitCode: -2,
						execution: { status: "detached", success: false, exitCode: -2, detached: true },
						model: "openai/gpt-5",
						launchContractDigest: "digest-detached",
						usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						progressSummary: { toolCount: 1, tokens: 3, durationMs: 10 },
					}],
				},
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);

		assert.deepEqual(await responsePromise, {
			version: 2,
			requestId: "attempt-1",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			status: "detached",
			runId: "child-detached-1",
			agent: "reviewer",
			model: "openai/gpt-5",
			exitCode: -2,
			launchContractDigest: "digest-detached",
			usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 10 },
		} satisfies SubagentDelegationResponse);
		bridge.dispose();
	});

	it("rejects non-JSON structured results without executing toJSON hooks", async () => {
		let calls = 0;
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => ({
				details: {
					mode: "single",
					results: [{
						agent: "reviewer",
						exitCode: 0,
						structuredOutput: { toJSON: () => { calls++; return {}; } },
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					}],
				},
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "unsafe-structured" });
		const response = await responsePromise as SubagentDelegationResponse;
		assert.equal(response.status, "failed");
		assert.match(response.error ?? "", /structured result is not plain JSON data/);
		assert.equal(calls, 0);
		bridge.dispose();
	});

	it("rejects text results exceeding 1 MiB when UTF-8 encoded", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => ({
				details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, finalOutput: "é".repeat(524_289) }] },
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "oversized-text", result: { kind: "text" } });
		const response = await responsePromise as SubagentDelegationResponse;
		assert.equal(response.status, "failed");
		assert.match(response.error ?? "", /text result exceeds 1 MiB/);
		assert.equal("result" in response, false);
		bridge.dispose();
	});

	it("isolates logical-node ownership, exact cancellation, pre-cancellation, and reuse", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const responses: SubagentDelegationResponse[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (id, params, signal) => await new Promise((resolve, reject) => {
				releases.set(id, () => resolve({ details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] } }));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		});
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-a", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "other-node", nodeId: "node-2", result: { kind: "text" } });
		while (!releases.has("owner-a") || !releases.has("other-node")) await tick();
		await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-b")?.status, "duplicate_node");
		assert.equal(responses.filter((entry) => entry.requestId === "owner-b").length, 1);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "wrong", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "owner-1", nodeId: "wrong" });
		await tick();
		assert.equal(responses.some((entry) => entry.requestId === "owner-a"), false);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "owner-1", nodeId: "node-1" });
		while (!responses.some((entry) => entry.requestId === "owner-a")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-a")?.status, "cancelled");
		releases.get("other-node")?.();
		while (!responses.some((entry) => entry.requestId === "other-node")) await tick();

		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "pre", ownerRunId: "owner-1", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "pre", result: { kind: "text" } });
		while (!responses.some((entry) => entry.requestId === "pre")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "pre")?.status, "cancelled");

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "reuse", result: { kind: "text" } });
		while (!releases.has("reuse")) await tick();
		releases.get("reuse")?.();
		while (!responses.some((entry) => entry.requestId === "reuse")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "reuse")?.status, "completed");
		bridge.dispose();
	});

	it("keys concurrent attempts and retransmissions by the full identity tuple", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const responses: SubagentDelegationResponse[] = [];
		let executeCalls = 0;
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (_id, params) => {
				executeCalls++;
				if (typeof params.task !== "string") throw new Error("expected a single delegated task");
				const task = params.task;
				await new Promise<void>((resolve) => releases.set(task, resolve));
				return { details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: task }] } };
			},
		});
		const first = { ...request, requestId: "shared-attempt", task: "first", result: { kind: "text" as const } };
		const second = { ...first, ownerRunId: "owner-2", nodeId: "node-2", task: "second" };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, second);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		for (let index = 0; index < 5 && releases.size < 2; index++) await tick();
		assert.equal(releases.size, 2);
		assert.equal(executeCalls, 2);
		releases.get("first")?.();
		releases.get("second")?.();
		while (responses.length < 2) await tick();
		assert.deepEqual(responses.map(({ ownerRunId, nodeId, status }) => ({ ownerRunId, nodeId, status })).sort((a, b) => (a.ownerRunId ?? "").localeCompare(b.ownerRunId ?? "")), [
			{ ownerRunId: "owner-1", nodeId: "node-1", status: "completed" },
			{ ownerRunId: "owner-2", nodeId: "node-2", status: "completed" },
		]);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		await tick();
		assert.equal(executeCalls, 2);
		assert.equal(responses.length, 2);
		bridge.dispose();
	});

	it("applies exact pre-cancellation despite logical-node and bare-id conflicts", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const activeSignals = new Map<string, AbortSignal>();
		const responses: SubagentDelegationResponse[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (_id, params, signal) => {
				if (typeof params.task !== "string") throw new Error("expected a single delegated task");
				const task = params.task;
				activeSignals.set(task, signal);
				await new Promise<void>((resolve) => releases.set(task, resolve));
				return { details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: task }] } };
			},
		});

		const logicalOwner = { ...request, requestId: "logical-owner", task: "logical-owner", result: { kind: "text" as const } };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, logicalOwner);
		while (!releases.has("logical-owner")) await tick();
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "logical-pre", ownerRunId: "owner-1", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...logicalOwner, requestId: "logical-pre", task: "must-not-run" });
		await tick();
		assert.equal(responses.find((entry) => entry.requestId === "logical-pre")?.status, "cancelled");
		assert.equal(activeSignals.get("logical-owner")?.aborted, false);
		assert.equal(releases.has("must-not-run"), false);

		const bareOwner = { ...request, requestId: "shared-bare", ownerRunId: "owner-2", nodeId: "node-2", task: "bare-owner", result: { kind: "text" as const } };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, bareOwner);
		while (!releases.has("bare-owner")) await tick();
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "shared-bare", ownerRunId: "owner-3", nodeId: "node-3" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...bareOwner, ownerRunId: "owner-3", nodeId: "node-3", task: "also-must-not-run" });
		await tick();
		assert.equal(responses.find((entry) => entry.ownerRunId === "owner-3")?.status, "cancelled");
		assert.equal(activeSignals.get("bare-owner")?.aborted, false);
		assert.equal(releases.has("also-must-not-run"), false);

		releases.get("logical-owner")?.();
		releases.get("bare-owner")?.();
		bridge.dispose();
	});

	it("suppresses terminal events after disposal", async () => {
		const events = new FakeEvents();
		const responses: unknown[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload));
		let rejectExecution: ((error: Error) => void) | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => await new Promise((_resolve, reject) => { rejectExecution = reject; }),
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "dispose-v2", result: { kind: "text" } });
		await startedPromise;
		bridge.dispose();
		rejectExecution?.(new Error("aborted"));
		await tick();
		assert.deepEqual(responses, []);
	});

	it("fails closed instead of evicting exact cancellation identity", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } };
			},
		});
		for (let index = 0; index < 8_192; index++) {
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
				version: 2,
				requestId: `attempt-${index}`,
				ownerRunId: "saturated-owner",
				nodeId: `node-${index}`,
			});
		}

		const retainedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...request,
			requestId: "attempt-0",
			ownerRunId: "saturated-owner",
			nodeId: "node-0",
		});
		assert.equal((await retainedPromise as SubagentDelegationResponse).status, "cancelled");

		const overflowPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...request,
			requestId: "overflow-attempt",
			ownerRunId: "saturated-owner",
			nodeId: "overflow-node",
		});
		const overflow = await overflowPromise as SubagentDelegationResponse;
		assert.equal(overflow.status, "unavailable_context");
		assert.match(overflow.error ?? "", /identity capacity/i);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("fails closed when settled identity history reaches capacity", async () => {
		const events = new FakeEvents();
		const responses: SubagentDelegationResponse[] = [];
		let executeCalls = 0;
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (requestId) => {
				executeCalls++;
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, finalOutput: requestId }] } };
			},
		});
		for (let index = 0; index < 8_192; index++) {
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
				...request,
				requestId: `settled-${index}`,
				ownerRunId: "settled-owner",
				nodeId: `settled-node-${index}`,
				result: { kind: "text" },
			});
		}
		for (let attempt = 0; responses.length < 8_192 && attempt < 100; attempt++) await tick();
		assert.equal(responses.length, 8_192);
		assert.equal(executeCalls, 8_192);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...request,
			requestId: "settled-overflow",
			ownerRunId: "settled-owner",
			nodeId: "settled-overflow-node",
			result: { kind: "text" },
		});
		await tick();
		assert.equal(responses.at(-1)?.status, "unavailable_context");
		assert.equal(executeCalls, 8_192);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...request,
			requestId: "settled-0",
			ownerRunId: "settled-owner",
			nodeId: "settled-node-0",
			result: { kind: "text" },
		});
		await tick();
		assert.equal(responses.length, 8_193);
		assert.equal(executeCalls, 8_192);
		bridge.dispose();
	});
});
