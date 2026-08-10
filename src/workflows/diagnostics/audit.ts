/**
 * Deterministic run-audit.v1 projection (T6 Phase 1).
 *
 * Consumes the durable workflow domain events plus the sidecar diagnostic event
 * stream and emits a single, deterministic, metadata-only audit JSON per run.
 *
 * The projection is:
 *   - **Deterministic**: stable input ordering, stable key iteration, and
 *     canonical SHA-256 digests (with a local installation salt) produce
 *     byte-identical output for identical inputs, so replays are reproducible.
 *   - **Metadata-only**: it never carries prompts, tasks, instructions, outputs,
 *     stdout/stderr, tool arguments, environment values, tokens, secrets, or raw
 *     filesystem paths. It projects only typed safe fields (counts, durations,
 *     usage, status, stable codes, hashed identifiers, bounded redacted error
 *     fingerprints).
 *   - **Non-authoritative sidecar**: this projection never participates in
 *     workflow state transitions and never becomes a second state machine.
 *
 * Dependency discipline: this module is pure (no I/O, no reducer/store) and
 * imports only the three versioned diagnostic modules (`types.ts`, `schema.ts`,
 * `redaction.ts`) plus type-only workflow surface from `../types.ts`.
 */
import { createHash } from "node:crypto";

import {
	type WorkflowAttempt,
	type WorkflowEvent,
	type WorkflowMode,
	type WorkflowNodeStatus,
	type WorkflowRun,
	type WorkflowRunStatus,
} from "../types.ts";
import {
	DiagnosticCode,
	type DiagnosticCode as DiagnosticCodeType,
	type WorkflowDiagnosticEventV1,
	type WorkflowFailureClass,
} from "./types.ts";
import { DiagnosticCodeCatalog, WorkflowDiagnosticEventV1Schema } from "./schema.ts";
import { assertAllowlistSafety, canonicalRecordHash } from "./redaction.ts";
import { Value } from "typebox/value";

/** Audit schema identifier and version for the run-audit.v1 projection. */
export const RUN_AUDIT_SCHEMA_ID = "pi-agents-flow.run-audit";
export const RUN_AUDIT_SCHEMA_VERSION = 1;

/** Outcome categories the audit derives deterministically from run state + events. */
export type RunAuditOutcomeCategory =
	| "success"
	| "success_with_recovery"
	| "gate_blocked"
	| "user_stopped"
	| "failed";

/** Workflow overview projection (never the goal/cwd/session text). */
export interface RunAuditWorkflow {
	workflowId: string;
	mode: WorkflowMode;
	status: WorkflowRunStatus;
	revision: number;
	/** Canonical digest of the ordered node topology (kind/status/id edges only). */
	topologyDigest: string;
	/** Canonical digest of the resolved policy (safe numeric/boolean thresholds). */
	policyDigest: string;
}

/** A single gate evaluation projected from the workflow policy + adjudication. */
export interface RunAuditGateEvaluation {
	gateId: string;
	passed: boolean;
	/** Stable machine code for a failed gate, absent when passed. */
	code?: DiagnosticCodeType;
}

export interface RunAuditNodeUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	usageCostUsd: number;
	turns: number;
	toolCalls: number;
}

export interface RunAuditNodeSummary {
	nodeId: string;
	kind: string;
	status: WorkflowNodeStatus;
	attempts: number;
	/** Resolved provider for the last attempt (normalized dimension). */
	provider?: string;
	/** Model id for the last attempt (normalized dimension). */
	model?: string;
	durationsMs?: number[];
	usage?: RunAuditNodeUsage;
	/** Stable failure codes across all attempts (never raw error text). */
	failureCodes: string[];
	/** Count of attempts that ended in a terminal failure/cancellation. */
	failedAttempts: number;
}

export interface RunAuditIncident {
	incidentId: string;
	nodeId?: string;
	stage: string;
	code: DiagnosticCodeType;
	failureClass?: WorkflowFailureClass;
	/** Hash of the bounded, redacted error summary; never the error text. */
	errorFingerprint?: string;
	observedAt: number;
}

export interface RunAuditRecovery {
	recoveryId: string;
	nodeId?: string;
	/** Stable recovery/control code emitted by the diagnostic stream. */
	code: DiagnosticCodeType;
	observedAt: number;
}

export interface RunAuditUsage {
	attempts: number;
	completed: number;
	failed: number;
	cancelled: number;
	recovered: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	usageCostUsd: number;
	turns: number;
	toolCalls: number;
}

export interface RunAuditLatency {
	/** Total wall-clock latency from the first event `at` to the last event `at`. */
	totalMs?: number;
	/** Sum of per-node recorded durations (ms). */
	nodeDurationMs?: number;
	nodeCount: number;
}

export interface RunAuditDiagnosticCompleteness {
	/** Events in the sidecar stream that pass the strict envelope schema. */
	validEventCount: number;
	/** Events dropped by the sink/redaction allowlist guard before persistence. */
	droppedCount: number;
	/** True when the integrity hash chain has a gap or a mismatch. */
	chainBroken: boolean;
	/** True when no diagnostic events were captured for this run. */
	missing: boolean;
}

export interface RunAuditIntegrity {
	workflowEventCount: number;
	/** Canonical digest over the ordered domain events (stable fields only). */
	workflowEventsDigest: string;
	diagnosticEventCount: number;
	/** Hash of the last diagnostic event in the sidecar chain. */
	diagnosticHeadHash: string;
	droppedDiagnosticCount: number;
}

export interface RunAuditOutcome {
	category: RunAuditOutcomeCategory;
	primaryCode: DiagnosticCodeType;
	diagnosticCompleteness: RunAuditDiagnosticCompleteness;
}

export interface RunAuditV1 {
	schema: typeof RUN_AUDIT_SCHEMA_ID;
	schemaVersion: 1;
	workflow: RunAuditWorkflow;
	outcome: RunAuditOutcome;
	nodes: RunAuditNodeSummary[];
	gateEvaluations: RunAuditGateEvaluation[];
	incidents: RunAuditIncident[];
	recoveries: RunAuditRecovery[];
	usage: RunAuditUsage;
	latency: RunAuditLatency;
	integrity: RunAuditIntegrity;
}

export interface RunAuditInput {
	run: WorkflowRun;
	/** Durable workflow domain events in log order. */
	events: WorkflowEvent[];
	/** Sidecar diagnostic events (already allowlist-projected). */
	diagnostics: WorkflowDiagnosticEventV1[];
	/** Local installation salt for hashing identifiers; never exported. */
	salt: string;
	/** Count of diagnostic events dropped by the sink/redaction guard. */
	droppedDiagnosticCount?: number;
}

/** Stable codes that classify a run as intentionally stopped by the user. */
const USER_STOPPED_CODES: ReadonlySet<string> = new Set([
	"gate.user.approval_declined",
	"control.budget_protection.auto_stop",
]);

/** Provider segment of a model id; normalized dimension only. */
function providerFromModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash).toLowerCase() : undefined;
}

function isRecoveryType(eventType: string): boolean {
	return eventType === "workflow.recovery.attempted" || eventType === "workflow.recovery.completed";
}

/**
 * Canonical digest over an ordered array of stable strings. Deterministic per
 * the local installation salt. Empty input still yields a stable digest.
 */
export function canonicalDigest(parts: string[], salt: string): string {
	return createHash("sha256").update(`${salt}::${parts.join("\u0000")}`).digest("hex");
}

/** A conservative, deterministic adjudication reconstruction (metadata only). */
function isAdjudicated(status: WorkflowNodeStatus): boolean {
	return status === "accepted" || status === "superseded" || status === "rejected" || status === "failed" || status === "cancelled";
}

/**
 * Derive the run outcome category and primary code deterministically from the
 * run status, node adjudication, and the diagnostic stream. Priority order:
 * user_stopped > failed > gate_blocked > success(_with_recovery).
 */
function deriveOutcome(
	run: WorkflowRun,
	diagnostics: WorkflowDiagnosticEventV1[],
): { category: RunAuditOutcomeCategory; primaryCode: DiagnosticCodeType } {
	const hadRecovery = diagnostics.some((event) => isRecoveryType(event.eventType));
	const firstOrdered = [...diagnostics].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1));
	const hasUnexpected = diagnostics.some((event) => event.disposition === "unexpected");
	const cancelledOrStopped = diagnostics.some((event) =>
		event.outcome === "cancelled" || USER_STOPPED_CODES.has(event.classification.code),
	);

	// user_stopped
	if (run.status === "stopped" || cancelledOrStopped) {
		const code = firstOrdered.find((event) => event.classification.code === "gate.user.approval_declined")?.classification.code
			?? (diagnostics.some((event) => event.classification.code === "control.budget_protection.auto_stop") ? "control.budget_protection.auto_stop" : "gate.user.approval_declined");
		return { category: "user_stopped", primaryCode: code };
	}

	// failed
	const terminalNode = Object.values(run.nodes).find((node) => node.status === "failed" || node.status === "cancelled");
	if (run.status === "failed" || hasUnexpected || (terminalNode && !hadRecovery)) {
		const firstFailure = firstOrdered.find((event) =>
			event.classification.domain === "infrastructure" || event.classification.domain === "agent" || event.classification.domain === "product",
		);
		return { category: "failed", primaryCode: firstFailure?.classification.code ?? (terminalNode ? "agent.task.failed" : "infra.process.terminated") };
	}

	// gate_blocked
	const blocked = run.status === "paused" || (run.status === "active" && !allAdjudicated(run));
	if (blocked) {
		return { category: "gate_blocked", primaryCode: "gate.workflow.nodes_unadjudicated" };
	}

	// success / success_with_recovery
	if (run.status === "completed" || run.status === "active") {
		const code = hadRecovery
			? (firstOrdered.find((event) => isRecoveryType(event.eventType))?.classification.code ?? "gate.workflow.plan_required")
			: "gate.workflow.plan_required";
		return { category: hadRecovery ? "success_with_recovery" : "success", primaryCode: code };
	}

	return { category: "failed", primaryCode: "agent.task.failed" };
}

function allAdjudicated(run: WorkflowRun): boolean {
	const nodes = Object.values(run.nodes);
	return nodes.length === 0 || nodes.every((node) => isAdjudicated(node.status));
}

/** Project the workflow overview, topology digest, and policy digest. */
function projectWorkflow(run: WorkflowRun, events: WorkflowEvent[], salt: string): RunAuditWorkflow {
	const topology = Object.values(run.nodes)
		.map((node) => `${node.id}|${node.kind}|${node.status}|${[...node.dependsOn].sort().join(",")}`)
		.sort();
	const policy = run.policy;
	const policyParts = policy
		? [
			"gates.minAcceptedResearchLanes",
			String(policy.gates.minAcceptedResearchLanes),
			"gates.minAcceptedSectionWriters",
			String(policy.gates.minAcceptedSectionWriters),
			"gates.requireBrief",
			String(policy.gates.requireBrief),
			"gates.requireOutline",
			String(policy.gates.requireOutline),
			"gates.requireWriter",
			String(policy.gates.requireWriter),
			"gates.requireEditor",
			String(policy.gates.requireEditor),
			"gates.requireReviewer",
			String(policy.gates.requireReviewer),
			"qualityEnforcement",
			policy.qualityEnforcement,
			"evidenceMode",
			policy.evidenceMode,
		]
		: events.map((event) => `${event.id}|${event.type}|${event.at}`);
	return {
		workflowId: run.id,
		mode: run.mode,
		status: run.status,
		revision: run.revision,
		topologyDigest: canonicalDigest(topology, salt),
		policyDigest: canonicalDigest(policyParts.length > 0 ? policyParts : events.map((event) => event.type), salt),
	};
}

/** Aggregate safe usage metrics across attempts. */
function aggregateAttemptUsage(attempts: WorkflowAttempt[]): RunAuditNodeUsage | undefined {
	let hasAny = false;
	const usage: RunAuditNodeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usageCostUsd: 0, turns: 0, toolCalls: 0 };
	for (const attempt of attempts) {
		const u = attempt.usage;
		if (!u) continue;
		hasAny = true;
		usage.inputTokens += u.input ?? 0;
		usage.outputTokens += u.output ?? 0;
		usage.cacheReadTokens += u.cacheRead ?? 0;
		usage.cacheWriteTokens += u.cacheWrite ?? 0;
		usage.usageCostUsd += u.cost ?? 0;
		usage.turns += u.turns ?? 0;
		usage.toolCalls += u.toolCalls ?? 0;
	}
	return hasAny ? usage : undefined;
}

/** Stable failure code for an attempt, derived from its durable failure class. */
function attemptCode(attempt: WorkflowAttempt): DiagnosticCodeType | undefined {
	if (attempt.status === "cancelled") return "agent.task.failed";
	if (attempt.status !== "failed") return undefined;
	const cls = attempt.failure?.failureClass;
	if (cls === "process_terminated") return "infra.process.terminated";
	if (cls === "timeout") return "infra.timeout.child_response";
	if (cls === "output_registration_failed") return "product.output.registration_failed";
	if (cls === "invalid_result") return "product.structured_output.result_invalid";
	if (cls === "preflight_failed") return "product.preflight.agent_missing";
	if (cls === "turn_budget_exhausted") return "agent.turn_budget_exhausted";
	if (cls === "tool_budget_exhausted") return "agent.tool_budget_exhausted";
	if (attempt.error) {
		if (/\bquota|rate.?limit|unauthori[sz]ed|auth/i.test(attempt.error)) return "infra.process.terminated";
		if (/\btimeout|timed out|deadline/i.test(attempt.error)) return "infra.timeout.child_response";
		if (/process terminated|killed|sig/i.test(attempt.error)) return "infra.process.terminated";
		if (/budget|exhausted|max turns|max tools/i.test(attempt.error)) return "agent.turn_budget_exhausted";
		if (/output.*registration|artifact.*store/i.test(attempt.error)) return "product.output.registration_failed";
	}
	return "agent.task.failed";
}

/** Project per-node summaries (counts, durations, usage, failure codes). */
function projectNodes(run: WorkflowRun, salt: string): RunAuditNodeSummary[] {
	return Object.values(run.nodes)
		.map((node) => {
			const attempts = [...node.attempts].sort((a, b) => a.number - b.number);
			const last = attempts[attempts.length - 1];
			const durationsMs = attempts
				.map((attempt) => (attempt.completedAt !== undefined ? attempt.completedAt - attempt.startedAt : undefined))
				.filter((value): value is number => typeof value === "number");
			const usage = aggregateAttemptUsage(attempts);
			const failureCodes = new Set<string>();
			let failedAttempts = 0;
			for (const attempt of attempts) {
				if (attempt.status === "failed" || attempt.status === "cancelled") failedAttempts += 1;
				const code = attemptCode(attempt);
				if (code) failureCodes.add(code);
			}
			return {
				nodeId: node.id,
				kind: node.kind,
				status: node.status,
				attempts: attempts.length,
				...(last?.model ? { provider: providerFromModel(last.model), model: last.model } : {}),
				...(durationsMs.length > 0 ? { durationsMs } : {}),
				...(usage ? { usage } : {}),
				failureCodes: [...failureCodes].sort(),
				failedAttempts,
			};
		})
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/** Project gate evaluations from policy thresholds + adjudication (deterministic). */
function projectGateEvaluations(run: WorkflowRun): RunAuditGateEvaluation[] {
	const policy = run.policy;
	if (!policy) return [];
	const acceptedKinds = new Set(
		Object.values(run.nodes)
			.filter((node) => node.status === "accepted")
			.map((node) => node.kind),
	);
	const g = policy.gates;
	const gate = (gateId: string, passed: boolean, code?: DiagnosticCodeType): RunAuditGateEvaluation => ({
		gateId,
		passed,
		...(passed ? {} : { code: code ?? "gate.workflow.plan_required" }),
	});
	const gates: RunAuditGateEvaluation[] = [
		gate("policy.brief_required", !g.requireBrief || Boolean(run.researchBrief), "gate.workflow.brief_required"),
		gate("policy.outline_required", !g.requireOutline || Boolean(run.documentOutline), "gate.workflow.outline_required"),
		gate("policy.writer_required", !g.requireWriter || acceptedKinds.has("writer"), "gate.workflow.editor_lineage_missing"),
		gate("policy.editor_required", !g.requireEditor || acceptedKinds.has("editor"), "gate.workflow.editor_lineage_missing"),
		gate("policy.reviewer_required", !g.requireReviewer || acceptedKinds.has("reviewer"), "gate.workflow.reviewer_release_missing"),
	];
	return gates;
}

/** Project incidents from failed/unexpected diagnostics. Metadata only. */
function projectIncidents(diagnostics: WorkflowDiagnosticEventV1[], salt: string): RunAuditIncident[] {
	const incidents: RunAuditIncident[] = [];
	for (const event of [...diagnostics].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1))) {
		const isExpectedGate = event.disposition === "expected" && (event.eventType === "acceptance.gate.evaluated" || event.eventType === "workflow.gate.evaluated");
		if (isExpectedGate) continue;
		if (event.disposition !== "unexpected" && event.disposition !== "degraded") continue;
		incidents.push({
			incidentId: event.eventId,
			...(event.scope.nodeId ? { nodeId: event.scope.nodeId } : {}),
			stage: event.classification.stage,
			code: event.classification.code,
			...(event.classification.failureClass ? { failureClass: event.classification.failureClass } : {}),
			...(event.error?.fingerprint ? { errorFingerprint: event.error.fingerprint } : {}),
			observedAt: event.observedAt,
		});
	}
	return incidents.sort((a, b) => (a.incidentId < b.incidentId ? -1 : a.incidentId > b.incidentId ? 1 : 0));
}

/** Project recovery records from recovery-scoped diagnostics. */
function projectRecoveries(diagnostics: WorkflowDiagnosticEventV1[]): RunAuditRecovery[] {
	const recoveries: RunAuditRecovery[] = [];
	for (const event of [...diagnostics].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1))) {
		if (!isRecoveryType(event.eventType)) continue;
		recoveries.push({
			recoveryId: event.eventId,
			...(event.scope.nodeId ? { nodeId: event.scope.nodeId } : {}),
			code: event.classification.code,
			observedAt: event.observedAt,
		});
	}
	return recoveries.sort((a, b) => (a.recoveryId < b.recoveryId ? -1 : a.recoveryId > b.recoveryId ? 1 : 0));
}

/** Aggregate run-wide usage from node attempts. */
function projectUsage(run: WorkflowRun): RunAuditUsage {
	const usage: RunAuditUsage = {
		attempts: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		recovered: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		usageCostUsd: 0,
		turns: 0,
		toolCalls: 0,
	};
	for (const node of Object.values(run.nodes)) {
		for (const attempt of node.attempts) {
			usage.attempts += 1;
			if (attempt.status === "completed") usage.completed += 1;
			if (attempt.status === "failed") usage.failed += 1;
			if (attempt.status === "cancelled") usage.cancelled += 1;
			if (attempt.recoveredFromError) usage.recovered += 1;
			const u = attempt.usage;
			if (!u) continue;
			usage.inputTokens += u.input ?? 0;
			usage.outputTokens += u.output ?? 0;
			usage.cacheReadTokens += u.cacheRead ?? 0;
			usage.cacheWriteTokens += u.cacheWrite ?? 0;
			usage.usageCostUsd += u.cost ?? 0;
			usage.turns += u.turns ?? 0;
			usage.toolCalls += u.toolCalls ?? 0;
		}
	}
	return usage;
}

/** Project latency from domain event timestamps and per-node durations. */
function projectLatency(run: WorkflowRun, events: WorkflowEvent[]): RunAuditLatency {
	const times = events.map((event) => event.at).filter((value): value is number => typeof value === "number");
	const durations = Object.values(run.nodes)
		.flatMap((node) => node.attempts.map((attempt) => (attempt.completedAt !== undefined ? attempt.completedAt - attempt.startedAt : undefined)))
		.filter((value): value is number => typeof value === "number");
	const nodeDurationMs = durations.reduce((sum, value) => sum + value, 0);
	return {
		...(times.length > 1 ? { totalMs: Math.max(0, Math.max(...times) - Math.min(...times)) } : {}),
		...(nodeDurationMs > 0 ? { nodeDurationMs } : {}),
		nodeCount: Object.values(run.nodes).length,
	};
}

/** Compute diagnostic stream integrity: head hash + chain health. */
function projectDiagnosticIntegrity(diagnostics: WorkflowDiagnosticEventV1[], salt: string): { headHash: string; chainBroken: boolean } {
	const sorted = [...diagnostics].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1));
	let headHash = "";
	for (const event of sorted) {
		headHash = event.integrity?.hash ?? canonicalRecordHash(event, salt);
	}
	let chainBroken = false;
	for (let index = 1; index < sorted.length; index++) {
		const event = sorted[index]!;
		const previous = sorted[index - 1]!;
		const previousHash = previous.integrity?.hash ?? canonicalRecordHash(previous, salt);
		if (event.integrity?.previousHash && event.integrity.previousHash !== previousHash) {
			chainBroken = true;
			break;
		}
	}
	return { headHash, chainBroken };
}

/**
 * Project the deterministic run-audit.v1 document.
 *
 * Determinism guarantees:
 *   - Node, incident, recovery, and gate arrays are emitted in stable sorted
 *     order; per-node attempt arrays are sorted by attempt number.
 *   - Topology/policy/event digests use the local installation salt, so identical
 *     inputs yield identical digests.
 *   - Only typed safe fields are projected; raw content and materialized paths
 *     are structurally absent (the allowlist guard is asserted at the boundary).
 */
export function projectRunAudit(input: RunAuditInput): RunAuditV1 {
	// Boundary assertion: the supplied diagnostic stream must already be safe.
	for (const event of input.diagnostics) {
		const safety = assertAllowlistSafety(event);
		if (!safety.ok) throw new Error(`audit projection aborted: ${safety.reason}`);
	}
	const events = [...input.events];
	const diagnostics = [...input.diagnostics].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1));

	// Validate each diagnostic against the strict envelope schema.
	let validEventCount = 0;
	for (const event of diagnostics) {
		if (Value.Check(WorkflowDiagnosticEventV1Schema, event)) validEventCount += 1;
	}

	const workflow = projectWorkflow(input.run, events, input.salt);
	const { category, primaryCode } = deriveOutcome(input.run, diagnostics);
	const nodes = projectNodes(input.run, input.salt);
	const gateEvaluations = projectGateEvaluations(input.run);
	const incidents = projectIncidents(diagnostics, input.salt);
	const recoveries = projectRecoveries(diagnostics);
	const usage = projectUsage(input.run);
	const latency = projectLatency(input.run, events);
	const { headHash, chainBroken } = projectDiagnosticIntegrity(diagnostics, input.salt);
	const workflowEventsDigest = canonicalDigest(events.map((event) => `${event.id}|${event.type}|${event.at}`), input.salt);
	const dropped = input.droppedDiagnosticCount ?? 0;

	return {
		schema: RUN_AUDIT_SCHEMA_ID,
		schemaVersion: RUN_AUDIT_SCHEMA_VERSION,
		workflow,
		outcome: {
			category,
			primaryCode,
			diagnosticCompleteness: {
				validEventCount,
				droppedCount: dropped,
				chainBroken,
				missing: diagnostics.length === 0,
			},
		},
		nodes,
		gateEvaluations,
		incidents,
		recoveries,
		usage,
		latency,
		integrity: {
			workflowEventCount: events.length,
			workflowEventsDigest,
			diagnosticEventCount: diagnostics.length,
			diagnosticHeadHash: headHash,
			droppedDiagnosticCount: dropped,
		},
	};
}

/**
 * Convenience re-export for consumers that must assert an audit is metadata-safe
 * before persisting it. Always true for audits produced by {@link projectRunAudit}
 * because the projection structurally omits raw-content carriers.
 */
export function assertAuditMetadataOnly(audit: RunAuditV1): { ok: true } | { ok: false; reason: string } {
	const json = JSON.stringify(audit);
	for (const key of ["prompt", "task", "instructions", "stdout", "stderr", "credential", "secret"]) {
		if (json.includes(`"${key}"`) || json.includes(`"${key.replace(/[^a-z]/g, "")}"`)) {
			return { ok: false, reason: `audit carries forbidden field '${key}'` };
		}
	}
	return { ok: true };
}

/** Compile-time guard: every primary code projected must exist in the catalog. */
export function assertPrimaryCodeInCatalog(code: DiagnosticCodeType): boolean {
	return DiagnosticCodeCatalog.includes(code);
}

// Re-export the catalog constants so the audit and its tests share one truth.
export { DiagnosticCode };
