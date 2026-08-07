import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowEvent } from "../../src/workflows/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workflow store", () => {
	it("persists an append-only event stream and repairs a stale manifest on load", () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-store-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		const initial = store.create({
			id: "workflow-1",
			mode: "deep-research",
			goal: "Research workflow systems",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			at: 1,
		});
		const plan: WorkflowEvent = {
			id: "event-plan",
			type: "workflow.plan_applied",
			at: 2,
			tasks: [{ id: "task-main", label: "Research", order: 0 }],
			workUnits: [{
				id: "research",
				taskId: "task-main",
				kind: "research",
				label: "Research",
				order: 0,
				dependsOn: [],
				agentSpec: {
					id: "agent-research",
					baseAgent: "researcher",
					role: "researcher",
					objective: "Collect evidence",
					instructions: "Collect evidence and return the schema.",
					context: "fresh",
				},
				dataContract: {
					version: 1,
					profile: "research",
					inputs: [],
					outputs: { result: { mediaType: "application/json", description: "full result", storage: "artifact", required: true, classification: "internal" } },
				},
			}],
		};
		const planned = store.append("workflow-1", plan);

		assert.equal(initial.revision, 1);
		assert.equal(initial.maxNodeAttempts, 3);
		const startedEvent = JSON.parse(fs.readFileSync(store.paths("workflow-1").events, "utf-8").split("\n")[0]!) as { maxNodeAttempts?: number };
		assert.equal(startedEvent.maxNodeAttempts, 3);
		assert.equal(planned.revision, 2);
		assert.equal(planned.nodes.research?.status, "ready");
		const paths = store.paths("workflow-1");
		const eventLines = fs.readFileSync(paths.events, "utf-8").trim().split("\n");
		assert.equal(eventLines.length, 2);
		assert.equal(JSON.parse(eventLines[0] ?? "{}").type, "workflow.started");
		assert.equal(JSON.parse(eventLines[1] ?? "{}").type, "workflow.plan_applied");

		fs.writeFileSync(paths.manifest, JSON.stringify(initial, null, 2), "utf-8");
		const recovered = store.load("workflow-1");
		assert.equal(recovered.revision, 2);
		assert.equal(recovered.nodes.research?.status, "ready");
		assert.equal(JSON.parse(fs.readFileSync(paths.manifest, "utf-8")).revision, 2);

		const replayed = store.append("workflow-1", plan);
		assert.equal(replayed.revision, 2);
		assert.equal(fs.readFileSync(paths.events, "utf-8").trim().split("\n").length, 2);
	});

	it("fails closed when an event log is missing its workflow.started event", () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-store-invalid-"));
		tempDirs.push(rootDir);
		const store = createWorkflowStore({ rootDir });
		const paths = store.paths("workflow-invalid");
		fs.mkdirSync(path.dirname(paths.events), { recursive: true });
		fs.writeFileSync(paths.events, `${JSON.stringify({ id: "event-plan", type: "workflow.plan_applied", at: 1, tasks: [], workUnits: [] })}\n`, "utf-8");

		assert.throws(() => store.load("workflow-invalid"), /first workflow event must be workflow.started/i);
	});
});
