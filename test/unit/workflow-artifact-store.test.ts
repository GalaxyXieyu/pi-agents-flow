import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createLocalWorkflowArtifactStore } from "../../src/workflows/artifact-store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("local workflow artifact store", () => {
	it("stores immutable content-addressed objects and deduplicates equal bytes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-artifacts-"));
		dirs.push(root);
		const store = createLocalWorkflowArtifactStore(root);
		const first = store.put({ workflowId: "workflow", nodeId: "producer", attemptId: "producer:1", port: "document", mediaType: "text/markdown", content: "# Result" });
		const second = store.put({ workflowId: "workflow", nodeId: "producer", attemptId: "producer:2", port: "document", mediaType: "text/markdown", content: "# Result" });

		assert.equal(first.sha256, second.sha256);
		assert.equal(first.storage.materializedPath, second.storage.materializedPath);
		assert.equal(store.read(first).toString("utf8"), "# Result");
		assert.match(first.artifactId, /^artifact:\/\/workflow\/producer\//);
	});

	it("detects tampering, missing objects, and descriptors that escape the store", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-artifacts-"));
		dirs.push(root);
		const store = createLocalWorkflowArtifactStore(root);
		const descriptor = store.put({ workflowId: "workflow", nodeId: "producer", attemptId: "producer:1", port: "data", mediaType: "text/plain", content: "trusted" });
		fs.writeFileSync(descriptor.storage.materializedPath, "tampered");
		assert.throws(() => store.verify(descriptor), /integrity verification/);
		fs.rmSync(descriptor.storage.materializedPath);
		assert.throws(() => store.read(descriptor), /missing/);
		assert.throws(() => store.verify({ ...descriptor, storage: { ...descriptor.storage, materializedPath: "/tmp/outside" } }), /escapes/);
	});

	it("rejects unsafe workflow, node, and port identifiers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-artifacts-"));
		dirs.push(root);
		const store = createLocalWorkflowArtifactStore(root);
		assert.throws(() => store.put({ workflowId: "../workflow", nodeId: "producer", attemptId: "1", port: "data", mediaType: "text/plain", content: "x" }), /workflowId/);
		assert.throws(() => store.put({ workflowId: "workflow", nodeId: "producer", attemptId: "1", port: "../data", mediaType: "text/plain", content: "x" }), /port/);
	});
});
