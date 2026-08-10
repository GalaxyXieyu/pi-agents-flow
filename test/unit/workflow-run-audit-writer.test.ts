import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import { writeRunAuditSidecar } from "../../src/workflows/diagnostics/run-audit-writer.ts";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createCompletedRun(rootDir: string): { store: ReturnType<typeof createWorkflowStore>; runId: string } {
	const store = createWorkflowStore({ rootDir });
	const runId = "workflow-audit-test";
	store.create({ id: runId, mode: "general", goal: "Audit probe", cwd: rootDir, sessionId: "session-1", branch: "main", at: 1 });
	store.append(runId, { id: "planned", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [] });
	store.append(runId, { id: "completed", type: "workflow.status_changed", at: 3, status: "completed" });
	return { store, runId };
}

describe("run-audit sidecar writer", () => {
	it("writes a RunAuditV1 sidecar to delivery/run-audit.json on completion", () => {
		const rootDir = makeTmpDir("pi-run-audit-");
		const { store, runId } = createCompletedRun(rootDir);

		const result = writeRunAuditSidecar(store, runId);

		assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
		assert.ok(result.path, "expected a sidecar path");
		assert.equal(fs.existsSync(result.path as string), true, "sidecar file should exist");

		const audit = JSON.parse(fs.readFileSync(result.path as string, "utf-8"));
		assert.equal(audit.schema, "pi-agents-flow.run-audit");
		assert.equal(audit.schemaVersion, 1);
		assert.equal(audit.workflow.workflowId, runId);
		assert.ok(audit.integrity.workflowEventCount >= 1, "should count events");
		assert.equal(audit.outcome.category, "success");
	});

	it("is best-effort and never throws when the event log is missing", () => {
		const rootDir = makeTmpDir("pi-run-audit-missing-");
		const store = createWorkflowStore({ rootDir });
		const runId = "never-created";

		const result = writeRunAuditSidecar(store, runId);

		assert.equal(result.ok, false, "should report failure, not throw");
		assert.ok(result.error, "should carry an error message");
	});

	it("tolerates a corrupt trailing line in the event log", () => {
		const rootDir = makeTmpDir("pi-run-audit-corrupt-");
		const { store, runId } = createCompletedRun(rootDir);

		// Append a non-JSON trailing line to simulate a partial/corrupt write.
		fs.appendFileSync(store.paths(runId).events, "this is not json\n", "utf-8");

		const result = writeRunAuditSidecar(store, runId);

		assert.equal(result.ok, true, `expected ok despite corrupt tail, got ${JSON.stringify(result)}`);
		const audit = JSON.parse(fs.readFileSync(result.path as string, "utf-8"));
		assert.equal(audit.integrity.workflowEventCount, 3, "corrupt line should be skipped, valid events counted");
	});

	it("never writes diagnostic events into the authoritative events.jsonl", () => {
		const rootDir = makeTmpDir("pi-run-audit-events-");
		const { store, runId } = createCompletedRun(rootDir);
		const before = fs.readFileSync(store.paths(runId).events, "utf-8");

		writeRunAuditSidecar(store, runId);

		const after = fs.readFileSync(store.paths(runId).events, "utf-8");
		assert.equal(after, before, "events.jsonl must be unchanged by the sidecar writer");
	});
});
