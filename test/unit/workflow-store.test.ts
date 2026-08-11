import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWorkflowStore } from "../../src/workflows/store.ts";
import { outputRegistrationDiagnostic, registerWorkflowOutputs } from "../../src/workflows/output-ports.ts";
import { createLocalWorkflowArtifactStore } from "../../src/workflows/artifact-store.ts";
import type { WorkflowEvent, WorkflowResult } from "../../src/workflows/types.ts";

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

	it("names a missing required output as the failed port and registration stage", () => {
		const result: WorkflowResult = {
			version: 1, summary: { text: "partial", covers: [], omissions: [], confidence: "high" }, outputs: {},
			diagnostics: { gaps: [], conflicts: [], warnings: [] }, recommendations: [],
		};
		const node = {
			id: "w-aliyun",
			dataContract: { version: 1, profile: "writer", inputs: [], outputs: { sections: { mediaType: "text/markdown", description: "sections", storage: "artifact", required: true, classification: "internal" } } },
		} as never;
		const diagnostic = outputRegistrationDiagnostic(node, result, new Error("Required output port 'sections' is missing."));
		assert.deepEqual(diagnostic, {
			nodeId: "w-aliyun", port: "sections", stage: "missing_submission", reason: "Required output port 'sections' is missing.",
			expected: { mediaType: "text/markdown", storage: "artifact", required: true },
			actual: { present: false, reason: "Required output port 'sections' is missing." },
		});
	});

	it("keeps reviewer release extensions in the compact event result", () => {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-output-release-"));
		tempDirs.push(rootDir);
		const result: WorkflowResult = {
			version: 1,
			summary: { text: "approved", covers: [], omissions: [], confidence: "high" },
			outputs: { review: { kind: "value", value: "approved" } },
			diagnostics: { gaps: [], conflicts: [], warnings: [] },
			recommendations: [],
			extensions: { release: { release: true, gapsAccepted: true, rationale: "Quick report gaps are acceptable." } },
		};
		const registered = registerWorkflowOutputs({
			run: { id: "workflow-release" } as never,
			node: { id: "reviewer" } as never,
			attemptId: "reviewer:1",
			result,
			contract: { version: 1, profile: "reviewer", inputs: [], outputs: { review: { mediaType: "text/plain", description: "review", storage: "inline", required: true, classification: "internal" } } },
			artifactStore: createLocalWorkflowArtifactStore(rootDir),
		});
		assert.deepEqual(registered.eventResult.extensions, result.extensions);
	});

	it("remaps legacy runtime paths when hydrating immutable result artifacts", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-store-remap-"));
		tempDirs.push(cwd);
		const rootDir = path.join(cwd, ".pi", "agents-flow", "workflows");
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-remap", mode: "general", goal: "Remap", cwd, sessionId: "session-1", branch: "main", at: 1 });
		const workUnit = {
			id: "worker", taskId: "task-main", kind: "custom" as const, label: "worker", order: 0, dependsOn: [],
			agentSpec: { id: "agent-worker", baseAgent: "worker", role: "worker", objective: "work", instructions: "work", context: "fresh" as const },
			dataContract: { version: 1 as const, profile: "generic" as const, inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact" as const, required: true, classification: "internal" as const } } },
		};
		store.append("workflow-remap", { id: "plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [workUnit] });
		store.append("workflow-remap", { id: "started", type: "node.started", at: 3, nodeId: "worker", attempt: { attemptId: "worker:1", requestId: "request-worker", number: 1, startedAt: 3 } });
		const legacyRoot = path.join(cwd, ".pi-agents-flow");
		const result: WorkflowResult = {
			version: 1,
			summary: { text: `${legacyRoot}-backup must not be rewritten`, covers: [], omissions: [], confidence: "high" },
			outputs: { result: { kind: "file", path: path.join(legacyRoot, "workflows", "workflow-remap", "artifacts", "staging", "result") } },
			diagnostics: { gaps: [], conflicts: [], warnings: [] },
			recommendations: [],
		};
		const artifactStore = createLocalWorkflowArtifactStore(store.paths("workflow-remap").artifacts);
		const resultArtifact = artifactStore.put({ workflowId: "workflow-remap", nodeId: "worker", attemptId: "worker:1", port: "workflow-result", mediaType: "application/json", content: JSON.stringify(result) });
		const originalBytes = fs.readFileSync(resultArtifact.storage.materializedPath);
		store.append("workflow-remap", { id: "completed", type: "node.completed", at: 4, nodeId: "worker", attemptId: "worker:1", result: { ...result, outputs: {} }, resultArtifact, outputs: {} });
		const loaded = store.load("workflow-remap");
		assert.match(loaded.nodes.worker?.result?.outputs.result?.path ?? "", /\.pi\/agents-flow/);
		assert.doesNotMatch(loaded.nodes.worker?.result?.outputs.result?.path ?? "", /\.pi-agents-flow/);
		assert.match(loaded.nodes.worker?.result?.summary.text ?? "", /\.pi-agents-flow-backup/);
		assert.deepEqual(fs.readFileSync(resultArtifact.storage.materializedPath), originalBytes);
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
