import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assertAuditMetadataOnly,
	assertPrimaryCodeInCatalog,
	canonicalDigest,
	projectRunAudit,
	RUN_AUDIT_SCHEMA_ID,
	RUN_AUDIT_SCHEMA_VERSION,
	type RunAuditInput,
} from "../../src/workflows/diagnostics/audit.ts";
import {
	DIAGNOSTIC_PAYLOAD_VERSION,
	DIAGNOSTIC_SCHEMA_ID,
	DIAGNOSTIC_SCHEMA_VERSION,
	DiagnosticCode,
	type WorkflowDiagnosticEventV1,
} from "../../src/workflows/diagnostics/types.ts";
import type { WorkflowRun } from "../../src/workflows/types.ts";

const SALT = "test-salt";

/** A minimal completed run with one accepted writer node and a usage sample. */
function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	const base = {
		version: 1,
		id: "wf-1",
		mode: "general",
		goal: "SECRET GOAL — must never appear",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "completed",
		revision: 3,
		createdAt: 0,
		updatedAt: 10,
		tasks: {},
		nodes: {
			n1: {
				id: "n1",
				workUnitId: "w1",
				taskId: "t1",
				kind: "writer",
				label: "writer",
				role: "writer",
				objective: "o",
				instructions: "i",
				context: "fresh",
				agentSpec: { id: "a", baseAgent: "b", role: "writer", objective: "o", instructions: "i", context: "fresh" },
				status: "accepted",
				order: 0,
				dependsOn: [],
				attempts: [
					{
						attemptId: "a1",
						requestId: "r1",
						number: 0,
						startedAt: 100,
						completedAt: 200,
						status: "completed",
						model: "openai/gpt-4",
						usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.1, turns: 2, toolCalls: 3, durationMs: 100 },
					},
				],
			},
		},
		decisions: [],
		appliedEventIds: [],
	} as unknown as WorkflowRun;
	return { ...base, ...overrides } as WorkflowRun;
}

const DOMAIN_EVENTS = [
	{ id: "e1", at: 100, type: "workflow.started" },
	{ id: "e2", at: 200, type: "node.completed", nodeId: "n1" },
] as const;

/** A minimal valid diagnostic event fixture. */
function makeDiagnostic(overrides: Partial<WorkflowDiagnosticEventV1> = {}): WorkflowDiagnosticEventV1 {
	return {
		schema: DIAGNOSTIC_SCHEMA_ID,
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
		eventId: "diag-1",
		eventType: "workflow.lifecycle.observed",
		sequence: 0,
		observedAt: 100,
		severity: "info",
		disposition: "expected",
		outcome: "passed",
		scope: { workflowId: "wf-1" },
		correlation: { traceId: "t", spanId: "s", sourceEventId: "e1" },
		classification: {
			domain: "telemetry",
			stage: "lifecycle",
			code: "gate.workflow.plan_required",
			retryability: "not_applicable",
		},
		attributes: { sourceType: "workflow.started" },
		integrity: { hash: "a".repeat(64) },
		...overrides,
	};
}

function buildInput(overrides: Partial<RunAuditInput> = {}): RunAuditInput {
	return {
		run: makeRun(),
		events: [...DOMAIN_EVENTS] as unknown as RunAuditInput["events"],
		diagnostics: [],
		salt: SALT,
		...overrides,
	};
}

describe("run-audit projection — deterministic schema and digest", () => {
	it("exposes the versioned run-audit schema id and version", () => {
		assert.equal(RUN_AUDIT_SCHEMA_ID, "pi-agents-flow.run-audit");
		assert.equal(RUN_AUDIT_SCHEMA_VERSION, 1);
	});

	it("produces byte-identical output for identical inputs", () => {
		const a = projectRunAudit(buildInput());
		const b = projectRunAudit(buildInput());
		assert.equal(JSON.stringify(a), JSON.stringify(b));
	});

	it("computes a deterministic canonical digest per salt", () => {
		assert.equal(canonicalDigest(["a", "b"], SALT), canonicalDigest(["a", "b"], SALT));
		assert.notEqual(canonicalDigest(["a", "b"], SALT), canonicalDigest(["a", "b"], "other"));
		assert.notEqual(canonicalDigest(["a", "b"], SALT), canonicalDigest(["b", "a"], SALT));
	});
});

describe("run-audit projection — completeness and aggregation", () => {
	it("projects a success outcome with primary code in the catalog", () => {
		const audit = projectRunAudit(buildInput());
		assert.equal(audit.schema, RUN_AUDIT_SCHEMA_ID);
		assert.equal(audit.schemaVersion, 1);
		assert.equal(audit.workflow.workflowId, "wf-1");
		assert.equal(audit.workflow.status, "completed");
		assert.equal(audit.outcome.category, "success");
		assert.equal(audit.outcome.primaryCode, "gate.workflow.plan_required");
		assert.equal(audit.outcome.primaryCode, DiagnosticCode["gate.workflow.plan_required"]);
	});

	it("aggregates safe usage across attempts", () => {
		const audit = projectRunAudit(buildInput());
		assert.equal(audit.usage.attempts, 1);
		assert.equal(audit.usage.completed, 1);
		assert.equal(audit.usage.failed, 0);
		assert.equal(audit.usage.cancelled, 0);
		assert.equal(audit.usage.inputTokens, 10);
		assert.equal(audit.usage.outputTokens, 5);
		assert.equal(audit.usage.cacheReadTokens, 1);
		assert.equal(audit.usage.cacheWriteTokens, 0);
		assert.equal(audit.usage.usageCostUsd, 0.1);
		assert.equal(audit.usage.turns, 2);
		assert.equal(audit.usage.toolCalls, 3);

		const node = audit.nodes[0]!;
		assert.equal(node.nodeId, "n1");
		assert.equal(node.attempts, 1);
		assert.equal(node.status, "accepted");
		assert.equal(node.provider, "openai");
		assert.equal(node.model, "openai/gpt-4");
		assert.deepEqual(node.durationsMs, [100]);
	});

	it("projects integrity counts and digests", () => {
		const audit = projectRunAudit(buildInput());
		assert.equal(audit.integrity.workflowEventCount, 2);
		assert.match(audit.integrity.workflowEventsDigest, /^[0-9a-f]{64}$/);
		assert.equal(audit.integrity.diagnosticEventCount, 0);
		assert.equal(audit.integrity.diagnosticHeadHash, "");
		assert.equal(audit.integrity.droppedDiagnosticCount, 0);
		assert.equal(audit.outcome.diagnosticCompleteness.missing, true);
	});

	it("distinguishes expected gates from failure incidents", () => {
		const diag = [
			makeDiagnostic({ eventId: "diag-ok", eventType: "workflow.gate.evaluated", disposition: "expected", sequence: 0 }),
			makeDiagnostic({
				eventId: "diag-fail",
				eventType: "workflow.failure.classified",
				disposition: "unexpected",
				outcome: "failed",
				sequence: 1,
				scope: { workflowId: "wf-1", nodeId: "n2" },
				classification: { domain: "agent", stage: "failure", code: "agent.task.failed", retryability: "retryable" },
				error: { code: "error.unknown", fingerprint: "b".repeat(64), redactionCount: 1 },
			}),
		];
		const audit = projectRunAudit(buildInput({ diagnostics: diag }));
		// Expected gate is not an incident.
		assert.equal(audit.incidents.length, 1);
		assert.equal(audit.incidents[0]!.code, "agent.task.failed");
		assert.equal(audit.incidents[0]!.nodeId, "n2");
		assert.equal(audit.incidents[0]!.errorFingerprint, "b".repeat(64));
		// A failure diagnostic flips the outcome to failed.
		assert.equal(audit.outcome.category, "failed");
	});

	it("projects recovery records only for recovery-scoped diagnostics", () => {
		const diag = [
			makeDiagnostic({ eventId: "rec-1", eventType: "workflow.recovery.attempted", disposition: "degraded", outcome: "recovered", sequence: 0, classification: { domain: "recovery", stage: "recovery", code: "agent.task.failed", retryability: "retryable" } }),
			makeDiagnostic({ eventId: "plain-1", eventType: "workflow.lifecycle.observed", sequence: 1 }),
		];
		const audit = projectRunAudit(buildInput({ diagnostics: diag }));
		assert.equal(audit.recoveries.length, 1);
		assert.equal(audit.recoveries[0]!.code, "agent.task.failed");
		// Recovery present flips outcome to success_with_recovery when run completes.
		assert.equal(audit.outcome.category, "success_with_recovery");
	});

	it("derives gate_blocked for an un-adjudicated active run", () => {
		const run = makeRun({ status: "active", nodes: { n1: { ...(makeRun().nodes["n1"] as object), status: "ready" } as never } });
		const audit = projectRunAudit(buildInput({ run }));
		assert.equal(audit.outcome.category, "gate_blocked");
		assert.equal(audit.outcome.primaryCode, "gate.workflow.nodes_unadjudicated");
	});

	it("derives user_stopped for a stopped run", () => {
		const run = makeRun({ status: "stopped" });
		const audit = projectRunAudit(buildInput({ run }));
		assert.equal(audit.outcome.category, "user_stopped");
	});
});

describe("run-audit projection — metadata-only privacy invariant", () => {
	it("never carries raw content (goal/cwd/session/instructions/output)", () => {
		const audit = projectRunAudit(buildInput());
		const json = JSON.stringify(audit);
		assert.ok(!json.includes("SECRET GOAL"));
		assert.ok(!json.includes("/repo"));
		assert.ok(!json.includes("session-1"));
		assert.ok(!json.includes("instructions"));
	});

	it("asserts the audit document is metadata-only", () => {
		const audit = projectRunAudit(buildInput());
		assert.deepEqual(assertAuditMetadataOnly(audit), { ok: true });
	});

	it("rejects a document that carries a forbidden raw-content field", () => {
		const doc = { schema: RUN_AUDIT_SCHEMA_ID, schemaVersion: 1, prompt: "top secret" };
		const result = assertAuditMetadataOnly(doc as never);
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /forbidden field 'prompt'/);
	});

	it("asserts the projected primary code is in the 49-code catalog", () => {
		assert.equal(assertPrimaryCodeInCatalog("gate.workflow.plan_required"), true);
		assert.equal(assertPrimaryCodeInCatalog("agent.task.failed"), true);
		assert.equal(assertPrimaryCodeInCatalog("made.up.code" as never), false);
		assert.equal(Object.keys(DiagnosticCode).length, 49);
	});

	it("aborts projection when a supplied diagnostic violates allowlist safety", () => {
		const badDiag = makeDiagnostic({ attributes: { prompt: "x" } });
		assert.throws(() => projectRunAudit(buildInput({ diagnostics: [badDiag] })), /audit projection aborted/);
	});
});
