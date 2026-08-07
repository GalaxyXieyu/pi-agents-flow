import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { createWorkflowScheduler } from "../../src/workflows/scheduler.ts";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowResult, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

function plan(id: string): WorkflowWorkUnitPlan {
	return {
		id,
		taskId: "task-main",
		kind: "research",
		label: id,
		order: 0,
		dependsOn: [],
		agentSpec: {
			id: `${id}-agent`,
			baseAgent: "researcher",
			role: "researcher",
			objective: id,
			instructions: id,
			context: "fresh",
		},
		dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
	};
}

function envelope(): WorkflowResult {
	return { version: 1, summary: { text: "Completed research before the connection dropped", covers: [], omissions: [], confidence: "high" }, outputs: { result: { kind: "value", value: "salvaged result" } }, diagnostics: { gaps: [], conflicts: [], warnings: [] }, recommendations: ["Ship it"], evidence: { findings: [] } };
}

interface Outcome {
	status: string;
	error?: string;
	summary?: string;
	structuredOutputPath?: string;
}

/**
 * Runs one node whose child reports `Connection error.`, having optionally written
 * `outputContent` to its structured output path first.
 */
async function runFailingChild(outputContent: string | undefined): Promise<Outcome> {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-salvage-"));
	try {
		const structuredOutputPath = path.join(rootDir, "output.json");
		if (outputContent !== undefined) fs.writeFileSync(structuredOutputPath, outputContent);
		const store = createWorkflowStore({ rootDir: path.join(rootDir, "runs") });
		const run = store.create({ id: "run-1", mode: "general", goal: "Goal", cwd: rootDir, sessionId: "s", branch: "main" });
		store.append(run.id, { id: "plan", type: "workflow.plan_applied", at: 1, tasks: [{ id: "task-main", label: "Research", order: 0 }], workUnits: [plan("lane1")] });

		const scheduler = createWorkflowScheduler({
			store,
			adapter: {
				async run(_run, node, attempt) {
					return {
						ok: true,
						response: {
							version: 2,
							requestId: attempt.requestId,
							ownerRunId: "run-1",
							nodeId: node.id,
							status: "failed",
							error: "Connection error.",
							...(outputContent !== undefined ? { structuredOutputPath } : {}),
						},
					};
				},
			},
		});

		const next = await scheduler.runReady(run.id);
		const node = next.nodes.lane1!;
		const attempt = node.attempts.at(-1)!;
		return {
			status: node.status,
			...(attempt.error ? { error: attempt.error } : {}),
			...(attempt.result ? { summary: attempt.result.summary?.text } : {}),
			...(attempt.structuredOutputPath ? { structuredOutputPath: attempt.structuredOutputPath } : {}),
		};
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
}

describe("workflow result salvage after a transport failure", () => {
	it("recovers a valid envelope the child already wrote", async () => {
		// The child lost its provider connection, but the work was already finished.
		// Before this, 11 complete research envelopes in one session were discarded.
		const outcome = await runFailingChild(JSON.stringify(envelope()));
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.summary, "Completed research before the connection dropped");
	});

	it("still fails when the child wrote nothing", async () => {
		const outcome = await runFailingChild(undefined);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error, "Connection error.");
	});

	it("still fails when the persisted output is malformed json", async () => {
		const outcome = await runFailingChild("{not json");
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error, "Connection error.");
	});

	it("still fails when the persisted output is not a valid envelope", async () => {
		// A partial write must never be mistaken for a finished result.
		const outcome = await runFailingChild(JSON.stringify({ summary: "missing the rest" }));
		assert.equal(outcome.status, "failed");
	});

	it("records the structured output path on a genuine failure so later recovery stays possible", async () => {
		const outcome = await runFailingChild(JSON.stringify({ summary: "incomplete" }));
		assert.equal(outcome.status, "failed");
		assert.ok(outcome.structuredOutputPath, "node.failed must carry structuredOutputPath");
	});
});
