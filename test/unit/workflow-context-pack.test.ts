import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createLocalWorkflowArtifactStore } from "../../src/workflows/artifact-store.ts";
import { materializeWorkflowContextPack } from "../../src/workflows/context-pack.ts";
import type { WorkflowNode, WorkflowResolvedOutput, WorkflowRun } from "../../src/workflows/types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function output(value: string): WorkflowResolvedOutput {
	return { kind: "inline", mediaType: "text/plain", bytes: Buffer.byteLength(value), classification: "internal", value };
}

function node(id: string, status: WorkflowNode["status"], outputs: Record<string, WorkflowResolvedOutput> = {}): WorkflowNode {
	return {
		id,
		taskId: "task",
		kind: "custom",
		label: id,
		order: 0,
		dependsOn: [],
		status,
		attempts: [],
		outputs,
		agentSpec: { id: `${id}-agent`, baseAgent: "worker", role: id, objective: id, instructions: id, context: "fresh", },
	};
}

function run(nodes: WorkflowNode[]): WorkflowRun {
	return {
		version: 1,
		id: "workflow",
		mode: "general",
		goal: "Run",
		cwd: "/repo",
		sessionId: "session",
		branch: "main",
		status: "active",
		revision: 10,
		createdAt: 1,
		updatedAt: 10,
		tasks: {},
		nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
		decisions: [],
		appliedEventIds: [],
	};
}

describe("Workflow Context Pack V1", () => {
	it("resolves only accepted direct dependencies and records bounded inline fan-in", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-context-pack-"));
		dirs.push(root);
		const first = node("first", "accepted", { summary: output("one") });
		const second = node("second", "accepted", { summary: output("two") });
		const ignored = node("ignored", "accepted", { summary: output("secret") });
		const consumer = node("consumer", "ready");
		consumer.dependsOn = ["first", "second"];
		const workflow = run([first, second, ignored, consumer]);
		const pack = materializeWorkflowContextPack({
			run: workflow,
			node: consumer,
			contract: {
				version: 1,
				inputs: [{ name: "summaries", purpose: "compare", from: [{ nodeId: "first", port: "summary" }, { nodeId: "second", port: "summary" }], delivery: "inline", merge: "map-by-node", required: true }],
			},
			outputDir: path.join(root, "pack"),
			artifactStore: createLocalWorkflowArtifactStore(path.join(root, "objects")),
			taskContext: "Task",
		});

		assert.deepEqual(pack.manifest.inputs[0]?.inlineValue, { first: "one", second: "two" });
		assert.doesNotMatch(fs.readFileSync(pack.instructionsPath, "utf8"), /secret/);
		assert.equal(pack.manifest.inputs[0]?.delivery, "inline");
	});

	it("follows an accepted supersession while preserving source and effective node identities", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-context-pack-"));
		dirs.push(root);
		const original = node("original", "superseded");
		original.supersededBy = "replacement";
		const replacement = node("replacement", "accepted", { summary: output("replacement value") });
		const consumer = node("consumer", "ready");
		consumer.dependsOn = ["original"];
		const pack = materializeWorkflowContextPack({
			run: run([original, replacement, consumer]),
			node: consumer,
			contract: { version: 1, inputs: [{ name: "source", purpose: "consume replacement", from: [{ nodeId: "original", port: "summary" }], delivery: "inline", merge: "first", required: true }] },
			outputDir: path.join(root, "pack"),
			artifactStore: createLocalWorkflowArtifactStore(path.join(root, "objects")),
			taskContext: "Task",
		});
		assert.equal(pack.manifest.inputs[0]?.sourceNodeId, "original");
		assert.equal(pack.manifest.inputs[0]?.effectiveNodeId, "replacement");
		assert.equal(pack.manifest.inputs[0]?.inlineValue, "replacement value");
	});

	it("falls back from auto inline to a reference and fails explicit inline overflow", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-context-pack-"));
		dirs.push(root);
		const store = createLocalWorkflowArtifactStore(path.join(root, "objects"));
		const descriptor = store.put({ workflowId: "workflow", nodeId: "producer", attemptId: "producer:1", port: "document", mediaType: "text/plain", content: "x".repeat(10_000) });
		const producer = node("producer", "accepted", { document: { kind: "artifact", artifact: descriptor } });
		const consumer = node("consumer", "ready");
		consumer.dependsOn = ["producer"];
		const workflow = run([producer, consumer]);
		const auto = materializeWorkflowContextPack({
			run: workflow,
			node: consumer,
			contract: { version: 1, context: { maxInlineBytes: 100 }, inputs: [{ name: "document", purpose: "read", from: [{ nodeId: "producer", port: "document" }], delivery: "auto", merge: "first", required: true }] },
			outputDir: path.join(root, "auto"),
			artifactStore: store,
			taskContext: "Task",
		});
		assert.equal(auto.manifest.inputs[0]?.delivery, "reference");
		assert.equal(auto.manifest.inputs[0]?.sha256, descriptor.sha256);
		assert.throws(() => materializeWorkflowContextPack({
			run: workflow,
			node: consumer,
			contract: { version: 1, context: { maxInlineBytes: 100 }, inputs: [{ name: "document", purpose: "inline", from: [{ nodeId: "producer", port: "document" }], delivery: "inline", merge: "first", required: true }] },
			outputDir: path.join(root, "inline"),
			artifactStore: store,
			taskContext: "Task",
		}), /exceeds its 100-byte budget/);
	});
});
