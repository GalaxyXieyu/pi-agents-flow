import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowScheduler } from "../../src/workflows/scheduler.ts";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

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

/**
 * Runs `nodeCount` ready nodes and reports the highest number that were ever
 * in flight at the same moment.
 */
async function peakInFlight(nodeCount: number, options: { requested?: number; maxConcurrency?: number }): Promise<number> {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-concurrency-"));
	try {
		const store = createWorkflowStore({ rootDir });
		const run = store.create({ id: "run-1", mode: "general", goal: "Goal", cwd: rootDir, sessionId: "s", branch: "main" });
		store.append(run.id, {
			id: "plan",
			type: "workflow.plan_applied",
			at: 1,
			tasks: [{ id: "task-main", label: "Research", order: 0 }],
			workUnits: Array.from({ length: nodeCount }, (_, index) => plan(`node-${index}`)),
		});

		let inFlight = 0;
		let peak = 0;
		const scheduler = createWorkflowScheduler({
			store,
			...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
			adapter: {
				async run(_run, _node, attempt) {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 5));
					inFlight--;
					return {
						ok: true,
						response: {
							version: 2,
							requestId: attempt.requestId,
							ownerRunId: "run-1",
							nodeId: _node.id,
							status: "completed",
							result: {
								kind: "structured",
								value: {
									summary: "done",
									findings: [],
									gaps: [],
									conflicts: [],
									recommendations: [],
									artifactPaths: [],
								},
							},
						},
					};
				},
			},
		});
		await scheduler.runReady(run.id, options.requested === undefined ? {} : { concurrency: options.requested });
		return peak;
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
}

describe("workflow concurrency ceiling", () => {
	it("defaults to the configured ceiling instead of a hardcoded value", async () => {
		assert.equal(await peakInFlight(8, { maxConcurrency: 2 }), 2);
	});

	it("clamps a Supervisor asking for more than the ceiling", async () => {
		// The tool schema allows up to 32, so without a clamp one plan could burst
		// every ready node at once and fail most of them.
		assert.equal(await peakInFlight(8, { requested: 32, maxConcurrency: 3 }), 3);
	});

	it("honors a smaller request than the ceiling", async () => {
		assert.equal(await peakInFlight(8, { requested: 1, maxConcurrency: 4 }), 1);
	});

	it("never exceeds the number of ready nodes", async () => {
		assert.equal(await peakInFlight(2, { requested: 16, maxConcurrency: 16 }), 2);
	});

	it("rejects a malformed request", async () => {
		await assert.rejects(peakInFlight(2, { requested: 0 }), /integer >= 1/);
	});
});
