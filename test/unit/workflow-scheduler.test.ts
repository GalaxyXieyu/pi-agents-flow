import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { SubagentDelegationResponse } from "../../src/api/delegation.ts";
import type { WorkflowDelegationAdapter } from "../../src/workflows/delegation-adapter.ts";
import { createWorkflowScheduler } from "../../src/workflows/scheduler.ts";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowDataContract, WorkflowResult, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function contract(profile: WorkflowDataContract["profile"]): WorkflowDataContract {
	return {
		version: 1,
		profile,
		inputs: [],
		outputs: {
			result: { mediaType: "application/json", description: "full result", storage: "artifact", required: true, classification: "internal" },
			summary: { mediaType: "text/plain", description: "bounded summary", storage: "inline", required: false, classification: "internal" },
		},
	};
}

function result(summary: string): WorkflowResult {
	return {
		version: 1,
		summary: { text: summary, covers: [], omissions: [], confidence: "high" },
		outputs: { result: { kind: "value", value: summary } },
		diagnostics: { gaps: [], conflicts: [], warnings: [] },
		recommendations: [],
		evidence: { findings: [] },
	};
}

function documentResult(markdown: string): WorkflowResult {
	return {
		version: 1,
		summary: { text: markdown.slice(0, 200), covers: ["document"], omissions: [], confidence: "high" },
		outputs: { document: { kind: "value", value: markdown } },
		diagnostics: { gaps: [], conflicts: [], warnings: [] },
		recommendations: [],
		evidence: { findings: [] },
	};
}

function node(id: string, dependsOn: string[] = []): WorkflowWorkUnitPlan {
	const kind = id === "writer" ? "writer" : id.startsWith("editor") ? "editor" : id.startsWith("reviewer") ? "reviewer" : "research";
	const profile: WorkflowDataContract["profile"] = kind === "editor" || kind === "writer" ? "writer" : kind === "reviewer" ? "reviewer" : "research";
	const inputs: WorkflowDataContract["inputs"] = dependsOn.length > 0
		? [{
			name: kind === "reviewer" ? "final-draft" : "direct-dependencies",
			purpose: kind === "reviewer" ? "final report draft under review" : "accepted direct-dependency material",
			from: dependsOn.map((dep) => ({ nodeId: dep, port: kind === "writer" ? "summary" : "document" })),
			delivery: "reference",
			merge: dependsOn.length > 1 ? "list" : "first",
			required: true,
			maxInlineBytes: 0,
		}]
		: [];
	return {
		id,
		taskId: "task-main",
		kind,
		label: id,
		order: 0,
		dependsOn,
		agentSpec: {
			id: `agent-${id}`,
			baseAgent: kind === "editor" ? "research-editor" : kind === "reviewer" ? "research-reviewer" : kind === "writer" ? "research-writer" : "researcher",
			role: id,
			objective: `Complete ${id}`,
			instructions: "Return structured evidence.",
			context: "fresh",
		},
		dataContract: {
			version: 1,
			profile,
			inputs,
			outputs: kind === "writer" || kind === "editor"
				? { document: { mediaType: "text/markdown", description: "document output", storage: "artifact", required: true, classification: "internal" } }
				: { result: { mediaType: "application/json", description: "full result", storage: "artifact", required: true, classification: "internal" }, summary: { mediaType: "text/plain", description: "bounded summary", storage: "inline", required: false, classification: "internal" } },
		},
	};
}

function completedResponse(requestId: string, ownerRunId: string, nodeId: string, res: WorkflowResult = result(`completed ${nodeId}`)): SubagentDelegationResponse {
	return {
		version: 2,
		requestId,
		ownerRunId,
		nodeId,
		status: "completed",
		result: { kind: "structured", value: res },
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 1 },
	};
}

describe("workflow scheduler", () => {
	it("runs only ready nodes up to the concurrency limit and leaves acceptance to the supervisor", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-1", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-1", {
			id: "event-plan",
			type: "workflow.plan_applied",
			at: 2,
			tasks: [{ id: "task-main", label: "Research", order: 0 }],
			workUnits: [node("research-a"), node("research-b"), node("research-c"), node("writer", ["research-a", "research-b", "research-c"])],
		});

		let active = 0;
		let maxActive = 0;
		const transitionStatuses: string[] = [];
		const releases: Array<() => void> = [];
		const delegatedInstructions: string[] = [];
		const adapter: WorkflowDelegationAdapter = {
			async run(run, workflowNode, attempt) {
				delegatedInstructions.push(workflowNode.agentSpec.instructions);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => releases.push(resolve));
				active--;
				return { ok: true, response: completedResponse(attempt.requestId, run.id, workflowNode.id) };
			},
		};
		const scheduler = createWorkflowScheduler({
			store,
			adapter,
			now: (() => { let value = 10; return () => value++; })(),
			onTransition: (run) => transitionStatuses.push(Object.values(run.nodes).map((item) => item.status).sort().join(",")),
		});
		const runPromise = scheduler.runReady("workflow-1", { concurrency: 2 });

		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(active, 2);
		assert.equal(maxActive, 2);
		assert.equal(releases.length, 2);
		releases.shift()?.();
		releases.shift()?.();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(active, 1);
		assert.equal(releases.length, 1);
		releases.shift()?.();

		const run = await runPromise;
		assert.equal(maxActive, 2);
		assert.equal(run.nodes["research-a"]?.status, "completed");
		assert.equal(run.nodes["research-b"]?.status, "completed");
		assert.equal(run.nodes["research-c"]?.status, "completed");
		assert.equal(run.nodes.writer?.status, "pending");
		assert.equal(run.nodes.writer?.attempts.length, 0);
		assert.ok(transitionStatuses.some((statuses) => statuses.includes("running")));
		assert.ok(transitionStatuses.some((statuses) => statuses.includes("completed")));
		for (const instructions of delegatedInstructions) {
			const contextPath = instructions.match(/Workflow Context Pack V1: (.+\.md)/)?.[1];
			assert.ok(contextPath, `instructions missing context pack path: ${instructions.slice(0, 100)}`);
			const context = fs.readFileSync(contextPath, "utf8");
			assert.match(context, /Runtime research query plan/);
		}
	});

	it("reports port-level diagnostics when output artifact registration fails", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-output-diagnostic-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-output-diagnostic", mode: "general", goal: "Diagnose", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-output-diagnostic", {
			id: "plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [node("research-a")],
		});
		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(run, workflowNode, attempt) {
					return { ok: true, response: completedResponse(attempt.requestId, run.id, workflowNode.id, {
						...result("finished"), outputs: { result: { kind: "file", path: "/outside-trusted-output.json" } },
					}) };
				},
			},
		});
		const run = await scheduler.runReady("workflow-output-diagnostic");
		const error = run.nodes["research-a"]?.attempts[0]?.error ?? "";
		assert.equal(run.nodes["research-a"]?.attempts[0]?.failure?.failureClass, "output_registration_failed");
		assert.match(error, /"nodeId":"research-a"/);
		assert.match(error, /"port":"result"/);
		assert.match(error, /"stage":"file_capture"/);
		assert.match(error, /"mediaType":"application\/json"/);
		assert.match(error, /"path":"\/outside-trusted-output\.json"/);
		assert.match(error, /"actual":\{[^}]*"reason":"Output port 'result' file must use/);
	});

	it("keeps a one-megabyte result out of workflow history while hydrating it from a verified artifact", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-large-result-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-large", mode: "general", goal: "Large", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-large", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Large", order: 0 }], workUnits: [node("research-a")] });
		const marker = "LARGE_RESULT_MARKER";
		const largeResult = { ...result("large"), outputs: { result: { kind: "value", value: "x".repeat(1024 * 1024) + marker } } };
		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(currentRun, workflowNode, attempt) {
					return { ok: true, response: { ...completedResponse(attempt.requestId, currentRun.id, workflowNode.id, largeResult) } };
				},
			},
			now: () => 10,
		});

		const completed = await scheduler.runReady("workflow-large");
		assert.equal(completed.nodes["research-a"]?.result?.summary.text, "large");
		assert.ok(completed.nodes["research-a"]?.resultArtifact?.bytes > 1024 * 1024);
		const events = fs.readFileSync(store.paths("workflow-large").events, "utf8");
		assert.doesNotMatch(events, new RegExp(marker));
		assert.ok(Buffer.byteLength(events, "utf8") < 50_000);
		const reloaded = store.load("workflow-large");
		assert.equal(reloaded.nodes["research-a"]?.result?.summary.text, "large");
	});

	it("records transient transport failures as explicitly retryable failed attempts", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-fail-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-fail", mode: "general", goal: "Run", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-fail", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [node("research-a")] });
		let calls = 0;
		const adapter: WorkflowDelegationAdapter = {
			async run(currentRun, workflowNode, attempt) {
				calls++;
				if (calls === 1) return { ok: false, stage: "transport", error: "Connection error." };
				return { ok: true, response: completedResponse(attempt.requestId, currentRun.id, workflowNode.id), launchContractDigest: "digest-2" };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });

		const run = await scheduler.runReady("workflow-fail");
		assert.equal(run.nodes["research-a"]?.status, "failed");
		assert.equal(run.nodes["research-a"]?.attempts[0]?.status, "failed");
		assert.equal(run.nodes["research-a"]?.attempts[0]?.error, "Connection error.");
		assert.equal(run.nodes["research-a"]?.attempts[0]?.failure?.failureClass, "provider_transport_failed");
		assert.equal(run.nodes["research-a"]?.attempts[0]?.failure?.retryable, true);

		const unchanged = await scheduler.runReady("workflow-fail");
		assert.equal(unchanged.nodes["research-a"]?.attempts.length, 1);

		const retried = await scheduler.runReady("workflow-fail", { nodeIds: ["research-a"], retryNodeIds: ["research-a"] });
		assert.equal(retried.nodes["research-a"]?.status, "completed");
		assert.equal(retried.nodes["research-a"]?.attempts.length, 2);
		assert.equal(retried.nodes["research-a"]?.attempts[0]?.status, "failed");
		assert.equal(retried.nodes["research-a"]?.attempts[1]?.status, "completed");
	});

	it("pauses the workflow on exhausted provider balance and refuses an in-place retry", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-quota-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-quota", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-quota", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [node("research-a"), node("research-b")] });
		let calls = 0;
		const scheduler = createWorkflowScheduler({
			store,
			adapter: { async run() { calls++; return { ok: false, stage: "transport", error: '402: {"message":"Insufficient Balance"}' }; } },
			now: (() => { let value = 10; return () => value++; })(),
		});

		const failed = await scheduler.runReady("workflow-quota", { concurrency: 1 });
		assert.equal(failed.status, "paused");
		assert.equal(failed.nodes["research-a"]?.attempts[0]?.failure?.failureClass, "provider_quota_exhausted");
		assert.equal(failed.nodes["research-a"]?.attempts[0]?.failure?.retryable, false);
		assert.match(failed.pauseReason ?? "", /provider_quota_exhausted/);
		assert.equal(failed.nodes["research-b"]?.attempts.length, 0);
		await assert.rejects(() => scheduler.runReady("workflow-quota", { nodeIds: ["research-a"], retryNodeIds: ["research-a"] }), /only active workflows/);
		assert.equal(calls, 1);
	});

	it("stops scheduling after the persisted node-attempt ceiling", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-attempt-ceiling-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		const created = store.create({ id: "workflow-ceiling", mode: "general", goal: "Run", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1, maxNodeAttempts: 3 });
		store.append(created.id, { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [node("research-a")] });
		let calls = 0;
		const scheduler = createWorkflowScheduler({
			store,
			adapter: { async run() { calls++; return { ok: false, stage: "transport", error: `failure ${calls}` }; } },
			now: (() => { let value = 10; return () => value++; })(),
		});

		await scheduler.runReady(created.id);
		for (let index = 0; index < 4; index++) await scheduler.runReady(created.id, { nodeIds: ["research-a"], retryNodeIds: ["research-a"] });
		const run = store.load(created.id);

		assert.equal(calls, 3);
		assert.equal(run.maxNodeAttempts, 3);
		assert.equal(run.nodes["research-a"]?.status, "failed");
		assert.equal(run.nodes["research-a"]?.attempts.length, 3);
		assert.deepEqual(run.nodes["research-a"]?.attempts.map((attempt) => attempt.error), ["failure 1", "failure 2", "failure 3"]);
	});

	it("honors a one-attempt workflow ceiling", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-one-attempt-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		const created = store.create({ id: "workflow-one", mode: "general", goal: "Run", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1, maxNodeAttempts: 1 });
		store.append(created.id, { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [node("research-a")] });
		let calls = 0;
		const scheduler = createWorkflowScheduler({
			store,
			adapter: { async run() { calls++; return { ok: false, stage: "transport", error: "failed" }; } },
			now: () => 10,
		});

		await scheduler.runReady(created.id);
		await scheduler.runReady(created.id, { nodeIds: ["research-a"], retryNodeIds: ["research-a"] });

		assert.equal(calls, 1);
		assert.equal(store.load(created.id).nodes["research-a"]?.attempts.length, 1);
	});

	it("cancels one running node without cancelling its sibling", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-node-cancel-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-node-cancel", mode: "general", goal: "Cancel one", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-node-cancel", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [node("research-a"), node("research-b")] });
		const releases = new Map<string, () => void>();
		const adapter: WorkflowDelegationAdapter = {
			async run(run, workflowNode, attempt, signal) {
				await new Promise<void>((resolve, reject) => {
					releases.set(workflowNode.id, resolve);
					if (signal?.aborted) reject(signal.reason);
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				return { ok: true, response: completedResponse(attempt.requestId, run.id, workflowNode.id) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		const runPromise = scheduler.runReady("workflow-node-cancel", { concurrency: 2 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(scheduler.cancelNode("research-a"), true);
		releases.get("research-b")?.();
		const run = await runPromise;

		assert.equal(run.nodes["research-a"]?.status, "cancelled");
		assert.equal(run.nodes["research-b"]?.status, "completed");
	});

	it("keeps a detached child waiting on the original attempt without injecting full workflow bundles", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-detached-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-detached", mode: "general", goal: "Write", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-detached", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Write", order: 0 }], workUnits: [node("writer")] });
		let calls = 0;
		let delegatedInstructions = "";
		const structuredOutputPath = path.join(rootDir, "child-output.json");
		const metadataPath = path.join(rootDir, "child-meta.json");
		const adapter: WorkflowDelegationAdapter = {
			async run(run, workflowNode, attempt) {
				calls++;
				delegatedInstructions = workflowNode.agentSpec.instructions;
				return {
					ok: true,
					response: {
						version: 2,
						requestId: attempt.requestId,
						ownerRunId: run.id,
						nodeId: workflowNode.id,
						status: "detached",
						runId: "child-writer-1",
						launchContractDigest: "digest-writer-1",
						structuredOutputPath,
						metadataPath,
					},
				};
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });

		const waiting = await scheduler.runReady("workflow-detached");
		assert.equal(waiting.nodes.writer?.status, "waiting");
		assert.equal(waiting.nodes.writer?.attempts[0]?.status, "waiting");
		assert.equal(waiting.nodes.writer?.attempts[0]?.childRunId, "child-writer-1");
		assert.equal(waiting.nodes.writer?.attempts[0]?.structuredOutputPath, structuredOutputPath);
		assert.equal(waiting.nodes.writer?.attempts[0]?.metadataPath, metadataPath);
		const contextPath = delegatedInstructions.match(/Workflow Context Pack V1: (.+\.md)/)?.[1];
		const manifestPath = delegatedInstructions.match(/Workflow input manifest: (.+\.json)/)?.[1];
		assert.ok(contextPath);
		assert.ok(manifestPath);
		assert.match(fs.readFileSync(contextPath, "utf8"), /Language contract: use English/);
		assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")).inputs, []);
		assert.doesNotMatch(delegatedInstructions, new RegExp(path.join(rootDir, "workflow-detached", "bundles", "writer-context.md")));

		const unchanged = await scheduler.runReady("workflow-detached");
		assert.equal(calls, 1);
		assert.equal(unchanged.nodes.writer?.attempts.length, 1);
	});

	it("does not treat a repair subset filter as retry authorization", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-repair-filter-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-repair-filter", mode: "general", goal: "Repair", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-repair-filter", { id: "event-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Repair", order: 0 }], workUnits: [node("research-a")] });
		let calls = 0;
		const scheduler = createWorkflowScheduler({
			store,
			adapter: { async run() { calls++; return { ok: false, stage: "transport", error: "failed" }; } },
			now: (() => { let value = 10; return () => value++; })(),
		});
		await scheduler.runReady("workflow-repair-filter");
		await scheduler.runReady("workflow-repair-filter", { nodeIds: ["research-a"] });
		assert.equal(calls, 1);
		assert.equal(store.load("workflow-repair-filter").nodes["research-a"]?.attempts.length, 1);
	});

	it("runs new ready repairs without implicitly retrying old failures", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-repair-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-repair", mode: "general", goal: "Repair", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-repair", { id: "event-plan-old", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Repair", order: 0 }], workUnits: [node("research-old")] });
		const calls = new Map<string, number>();
		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(currentRun, workflowNode, attempt) {
					const call = (calls.get(workflowNode.id) ?? 0) + 1;
					calls.set(workflowNode.id, call);
					if (workflowNode.id === "research-old" && call === 1) return { ok: false, stage: "transport", error: "old failure" };
					return { ok: true, response: completedResponse(attempt.requestId, currentRun.id, workflowNode.id) };
				},
			},
			now: (() => { let value = 10; return () => value++; })(),
		});
		await scheduler.runReady("workflow-repair");
		assert.equal(store.load("workflow-repair").nodes["research-old"]?.status, "failed");
		store.append("workflow-repair", { id: "event-plan-new", type: "workflow.plan_applied", at: 20, tasks: [{ id: "task-main", label: "Repair", order: 0 }], workUnits: [node("research-new")] });

		const repaired = await scheduler.runReady("workflow-repair");
		assert.equal(repaired.nodes["research-new"]?.status, "completed");
		assert.equal(repaired.nodes["research-old"]?.status, "failed");
		assert.equal(calls.get("research-old"), 1);
		assert.equal(calls.get("research-new"), 1);

		const retried = await scheduler.runReady("workflow-repair", { nodeIds: ["research-old"], retryNodeIds: ["research-old"] });
		assert.equal(retried.nodes["research-old"]?.status, "completed");
		assert.equal(calls.get("research-old"), 2);
	});

	it("injects exact accepted draft paths into editor instructions", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-editor-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-editor", mode: "deep-research", goal: "Edit", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-editor", { id: "event-writer-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Writing", order: 0 }], workUnits: [node("writer")] });
		store.append("workflow-editor", {
			id: "event-writer-start",
			type: "node.started",
			at: 3,
			nodeId: "writer",
			attempt: { attemptId: "writer:1", requestId: "writer-request", number: 1, startedAt: 3 },
		});
		store.append("workflow-editor", {
			id: "event-writer-complete",
			type: "node.completed",
			at: 4,
			nodeId: "writer",
			attemptId: "writer:1",
			result: documentResult("Accepted draft"),
		});
		store.append("workflow-editor", { id: "event-writer-accept", type: "node.accepted", at: 5, nodeId: "writer", decision: "accepted" });
		store.append("workflow-editor", { id: "event-editor-plan", type: "workflow.plan_applied", at: 6, tasks: [{ id: "task-main", label: "Writing", order: 0 }], workUnits: [node("editor", ["writer"])] });
		let instructions = "";
		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(currentRun, workflowNode, currentAttempt) {
					instructions = workflowNode.agentSpec.instructions;
					return { ok: true, response: completedResponse(currentAttempt.requestId, currentRun.id, workflowNode.id, documentResult("# Final report")) };
				},
			},
			now: () => 10,
		});

		await scheduler.runReady("workflow-editor");

		const editorContextPath = instructions.match(/Workflow Context Pack V1: (.+\.md)/)?.[1];
		const editorManifestPath = instructions.match(/Workflow input manifest: (.+\.json)/)?.[1];
		assert.ok(editorContextPath);
		assert.ok(editorManifestPath);
		const editorContext = fs.readFileSync(editorContextPath, "utf8");
		const editorManifest = JSON.parse(fs.readFileSync(editorManifestPath, "utf8"));
		assert.equal(editorManifest.inputs[0].sourceNodeId, "writer");
		assert.equal(editorManifest.inputs[0].port, "document");
		assert.equal(editorManifest.inputs[0].delivery, "reference");
		assert.match(editorManifest.inputs[0].sha256, /^[a-f0-9]{64}$/);
		assert.match(editorContext, /Final-document quality contract/);
		assert.match(editorContext, /inline Markdown citation/);
	});

	it("hands reviewers only their direct editor result and a bounded review contract", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-scheduler-reviewer-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-reviewer", mode: "deep-research", goal: "Review", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-reviewer", { id: "event-editor-plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Review", order: 0 }], workUnits: [node("editor-final")] });
		store.append("workflow-reviewer", { id: "event-editor-start", type: "node.started", at: 3, nodeId: "editor-final", attempt: { attemptId: "editor-final:1", requestId: "editor-request", number: 1, startedAt: 3 } });
		store.append("workflow-reviewer", {
			id: "event-editor-complete",
			type: "node.completed",
			at: 4,
			nodeId: "editor-final",
			attemptId: "editor-final:1",
			result: documentResult("# Final report\n\nSupported conclusion."),
		});
		store.append("workflow-reviewer", { id: "event-editor-accept", type: "node.accepted", at: 5, nodeId: "editor-final", decision: "accepted" });
		const reviewer = node("reviewer-final", ["editor-final"]);
		reviewer.agentSpec.context = "fork";
		store.append("workflow-reviewer", { id: "event-reviewer-plan", type: "workflow.plan_applied", at: 6, tasks: [{ id: "task-main", label: "Review", order: 0 }], workUnits: [reviewer] });
		let instructions = "";
		let context = "";
		let denyTools: string[] | undefined;
		let timeoutMs: number | undefined;
		let turnBudget: { maxTurns: number; graceTurns?: number } | undefined;
		let toolBudget: { soft?: number; hard: number; block?: string[] | "*" } | undefined;
		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(currentRun, workflowNode, attempt) {
					instructions = workflowNode.agentSpec.instructions;
					context = workflowNode.agentSpec.context;
					timeoutMs = workflowNode.agentSpec.timeoutMs;
					denyTools = workflowNode.agentSpec.denyTools;
					turnBudget = workflowNode.agentSpec.turnBudget;
					toolBudget = workflowNode.agentSpec.toolBudget;
					return { ok: true, response: completedResponse(attempt.requestId, currentRun.id, workflowNode.id, result("approve")) };
				},
			},
			now: () => 10,
		});

		await scheduler.runReady("workflow-reviewer");

		const reviewerContextPath = instructions.match(/Workflow Context Pack V1: (.+\.md)/)?.[1];
		const reviewerManifestPath = instructions.match(/Workflow input manifest: (.+\.json)/)?.[1];
		assert.ok(reviewerContextPath);
		assert.ok(reviewerManifestPath);
		const reviewerContext = fs.readFileSync(reviewerContextPath, "utf8");
		const reviewerManifest = JSON.parse(fs.readFileSync(reviewerManifestPath, "utf8"));
		assert.equal(reviewerManifest.inputs.length, 1);
		assert.equal(reviewerManifest.inputs[0].binding, "final-draft");
		assert.equal(reviewerManifest.inputs[0].sourceNodeId, "editor-final");
		assert.equal(reviewerManifest.inputs[0].port, "document");
		assert.equal(fs.readFileSync(reviewerManifest.inputs[0].materializedPath, "utf8"), "# Final report\n\nSupported conclusion.");
		assert.match(reviewerContext, /final report draft under review/);
		assert.match(reviewerContext, /Do not broaden the research scope/);
		assert.equal(context, "fresh");
		assert.equal(timeoutMs, 600_000);
		assert.deepEqual(denyTools, ["web_search", "source_check", "fetch_content", "get_search_content"]);
		assert.deepEqual(turnBudget, { maxTurns: 8, graceTurns: 2 });
		assert.deepEqual(toolBudget, { soft: 4, hard: 6, block: "*" });
	});
});
