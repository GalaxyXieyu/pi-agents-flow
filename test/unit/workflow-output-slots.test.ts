import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { SubagentDelegationResponse } from "../../src/api/delegation.ts";
import type { WorkflowDelegationAdapter } from "../../src/workflows/delegation-adapter.ts";
import { createWorkflowScheduler } from "../../src/workflows/scheduler.ts";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import { WORKFLOW_RESULT_SUBMISSION_GUIDE } from "../../src/workflows/result-contract.ts";
import type { WorkflowDataContract, WorkflowResult, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function researchNode(id: string): WorkflowWorkUnitPlan {
	return {
		id,
		taskId: "task-main",
		kind: "research",
		label: id,
		order: 0,
		dependsOn: [],
		agentSpec: {
			id: `agent-${id}`,
			baseAgent: "researcher",
			role: id,
			objective: `Complete ${id}`,
			instructions: "Return structured evidence.",
			context: "fresh",
		},
		dataContract: {
			version: 1,
			profile: "research",
			inputs: [],
			outputs: {
				findings: { mediaType: "text/markdown", description: "research findings", storage: "artifact", required: true, classification: "public" },
			},
		} satisfies WorkflowDataContract,
	};
}

function fileResult(filePath: string): WorkflowResult {
	return {
		version: 1,
		summary: { text: "findings ready", covers: ["slot"], omissions: [], confidence: "high" },
		outputs: { findings: { kind: "file", path: filePath } },
		diagnostics: { gaps: [], conflicts: [], warnings: [] },
		recommendations: [],
		evidence: { findings: [] },
	};
}

function completedResponse(requestId: string, ownerRunId: string, nodeId: string, res: WorkflowResult, structuredOutputPath?: string): SubagentDelegationResponse {
	return {
		version: 2,
		requestId,
		ownerRunId,
		nodeId,
		status: "completed",
		result: { kind: "structured", value: res },
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 1 },
		...(structuredOutputPath ? { structuredOutputPath } : {}),
	};
}

function createRun(store: ReturnType<typeof createWorkflowStore>, runId: string): void {
	store.create({ id: runId, mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", at: 1 });
	store.append(runId, {
		id: "event-plan",
		type: "workflow.plan_applied",
		at: 2,
		tasks: [{ id: "task-main", label: "Research", order: 0 }],
		workUnits: [researchNode("research-a")],
	});
}

describe("workflow output slots", () => {
	it("launch instructions and context pack name the preallocated output slots", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-slots-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		createRun(store, "workflow-slots");
		let launchedInstructions = "";
		let manifestPath = "";
		const adapter: WorkflowDelegationAdapter = {
			async run(_run, node, attempt) {
				launchedInstructions = node.agentSpec.instructions;
				const match = /Workflow input manifest: (\S+)/.exec(node.agentSpec.instructions);
				manifestPath = match?.[1] ?? "";
				return { ok: true, response: completedResponse(attempt.requestId, _run.id, node.id, fileResult("/definitely/not/trusted.md")) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		await scheduler.runReady("workflow-slots");
		assert.match(launchedInstructions, /Preallocated output slots/);
		assert.match(launchedInstructions, /- findings: /);
		const slotLine = /- findings: (\S+)/.exec(launchedInstructions)?.[1];
		assert.ok(slotLine?.includes(path.join("staging", "workflow-slots", "research-a", "research-a_1", "findings")));
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { outputSlots?: Record<string, string> };
		assert.equal(manifest.outputSlots?.findings, slotLine);
		const contextText = fs.readFileSync(path.join(path.dirname(manifestPath), "context.md"), "utf-8");
		assert.match(contextText, /## Output slots/);
	});

	it("accepts a file submission written exactly to the preallocated slot", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-slots-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		createRun(store, "workflow-slot-write");
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				const slot = path.join(store.paths(run.id).artifacts, "staging", run.id, node.id, attempt.attemptId.replace(/:/g, "_"), "findings");
				fs.mkdirSync(path.dirname(slot), { recursive: true });
				fs.writeFileSync(slot, "# findings from the slot");
				return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id, fileResult(slot)) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		const done = await scheduler.runReady("workflow-slot-write");
		assert.equal(done.nodes["research-a"]?.status, "completed");
		assert.equal(done.nodes["research-a"]?.outputs?.findings?.kind, "artifact");
	});

	it("accepts a file submission from the child's trusted submission directory", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-slots-"));
		tempDirs.push(rootDir);
		const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-child-"));
		tempDirs.push(childDir);
		const submissionDir = path.join(childDir, "submissions");
		fs.mkdirSync(submissionDir, { recursive: true });
		const filePath = path.join(submissionDir, "findings.md");
		fs.writeFileSync(filePath, "# findings written the old way");
		const structuredOutputPath = path.join(childDir, "output.json");
		fs.writeFileSync(structuredOutputPath, "{}");
		const store = createWorkflowStore({ rootDir });
		createRun(store, "workflow-trusted");
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id, fileResult(filePath), structuredOutputPath) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		const done = await scheduler.runReady("workflow-trusted");
		assert.equal(done.nodes["research-a"]?.status, "completed");
		const output = done.nodes["research-a"]?.outputs?.findings;
		assert.equal(output?.kind, "artifact");
		if (output?.kind === "artifact") {
			assert.match(fs.readFileSync(output.artifact.storage.materializedPath, "utf-8"), /written the old way/);
		}
	});

	it("tells the child to write the slot before reporting a missing file path", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-slots-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		createRun(store, "workflow-missing-slot");
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				const slot = path.join(store.paths(run.id).artifacts, "staging", run.id, node.id, attempt.attemptId.replace(/:/g, "_"), "findings");
				return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id, fileResult(slot)) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		const done = await scheduler.runReady("workflow-missing-slot");
		assert.equal(done.nodes["research-a"]?.status, "failed");
		const error = done.nodes["research-a"]?.attempts.at(-1)?.error ?? "";
		assert.match(error, /file does not exist/);
		assert.match(error, /Write the content to this preallocated slot first/);
		assert.match(error, /do not use the slot as the outer structured_output.path/);
	});

	it("rejects file submissions outside the slot and trusted directories, naming the slot", async () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-slots-"));
		tempDirs.push(rootDir);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-outside-"));
		tempDirs.push(outside);
		const filePath = path.join(outside, "findings.md");
		fs.writeFileSync(filePath, "# not trusted");
		const store = createWorkflowStore({ rootDir });
		createRun(store, "workflow-reject");
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id, fileResult(filePath)) };
			},
		};
		const scheduler = createWorkflowScheduler({ store, adapter, now: () => 10 });
		const done = await scheduler.runReady("workflow-reject");
		assert.equal(done.nodes["research-a"]?.status, "failed");
		const error = done.nodes["research-a"]?.attempts.at(-1)?.error ?? "";
		assert.match(error, /preallocated output slot/);
		assert.match(error, /staging/);
	});

	it("submission guide points at preallocated slots, not the submissions directory", () => {
		assert.match(WORKFLOW_RESULT_SUBMISSION_GUIDE, /preallocated output slot/);
		assert.doesNotMatch(WORKFLOW_RESULT_SUBMISSION_GUIDE, /submissions directory/);
	});
});
