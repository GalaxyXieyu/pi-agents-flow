/**
 * Replayable lifecycle diagnostic projector (T6 Phase 1).
 *
 * Projects the **authoritative** workflow event log (`events.jsonl`) into a
 * sidecar stream of `WorkflowDiagnosticEventV1` records of type
 * `workflow.lifecycle.observed`. Projection is purely functional and
 * deterministic: the same authoritative input always yields the same
 * diagnostic stream (sequence, eventId, integrity hash chain, and
 * classification are all derived from the source events, never from wall-clock
 * or random state), so the audit can be replayed byte-for-byte.
 *
 * Privacy invariant (metadata-only by default): only allowlist-safe scalar
 * attributes are projected. The raw `goal`, `instructions`, `error` text, tool
 * arguments, output, and filesystem paths from the authoritative events are
 * never copied into diagnostics. Error text is projected only through
 * `redactErrorMessage` (bounded, redacted `safeSummary`) and failures are
 * mapped to stable codes.
 *
 * These projected diagnostics are **non-authoritative sidecars**; they never
 * feed back into workflow state and never become a second state machine.
 */
import * as fs from "node:fs";

import {
	DIAGNOSTIC_PAYLOAD_VERSION,
	DIAGNOSTIC_SCHEMA_ID,
	DIAGNOSTIC_SCHEMA_VERSION,
	type DiagnosticCode,
	type WorkflowDiagnosticClassification,
	type WorkflowDiagnosticEventV1,
	type WorkflowDiagnosticEventType,
	type WorkflowDisposition,
	type WorkflowDiagnosticStage,
	type WorkflowDiagnosticDomain,
	type WorkflowOutcome,
	type WorkflowSeverity,
} from "./types.ts";
import { canonicalRecordHash, deterministicEventId, redactErrorMessage, saltedFingerprint } from "./redaction.ts";
import type { WorkflowEvent } from "../types.ts";

export interface LifecycleProjectorOptions {
	/** Per-install salt for hashing cross-run identifiers and the hash chain. */
	salt: string;
	/** The workflow id whose authoritative log is being projected. */
	workflowId: string;
	/** Optional override of the diagnostic event type emitted for each record. */
	eventType?: WorkflowDiagnosticEventType;
	/** Optional clock for non-replayable fields; default `Date.now`. Only used when a source event lacks `at`. */
	now?: () => number;
}

export interface LifecycleProjectionResult {
	/** The projected, fully-validated diagnostic stream (deterministic). */
	events: WorkflowDiagnosticEventV1[];
	/** Number of authoritative source events consumed. */
	sourceEventCount: number;
	/** Number of source events that could not be projected (skipped, counted). */
	rejected: number;
	/** Hash of the last projected record, when any. */
	lastHash?: string;
	/** Highest projected sequence (or -1 when empty). */
	lastSequence: number;
}

interface LifecycleClassification {
	domain: WorkflowDiagnosticDomain;
	stage: WorkflowDiagnosticStage;
	code: DiagnosticCode;
	disposition: WorkflowDisposition;
	outcome: WorkflowOutcome;
	severity: WorkflowSeverity;
}

/**
 * Maps an authoritative workflow event to a semantically-appropriate
 * lifecycle classification. Only stable catalog codes are used; unknown or
 * neutral transitions map to a single documented "expected lifecycle
 * observation" token (`gate.workflow.plan_required`), because the strict
 * envelope requires a code while the contract forbids inventing new ones or
 * coercing unknowns to a generic failure.
 */
function classifyLifecycleEvent(event: WorkflowEvent): LifecycleClassification {
	const base = {
		domain: "telemetry" as WorkflowDiagnosticDomain,
		stage: "lifecycle" as WorkflowDiagnosticStage,
		code: "gate.workflow.plan_required" as DiagnosticCode,
		disposition: "expected" as WorkflowDisposition,
		outcome: "passed" as WorkflowOutcome,
		severity: "info" as WorkflowSeverity,
	};
	switch (event.type) {
		case "workflow.started":
			return { ...base, outcome: "started", stage: "dispatch" };
		case "workflow.status_changed":
			return {
				...base,
				domain: "control",
				stage: "acceptance",
				outcome: event.status === "completed" ? "passed" : event.status === "failed" ? "failed" : "blocked",
				disposition: event.status === "failed" ? "unexpected" : "expected",
			};
		case "workflow.plan_applied":
			return { ...base, stage: "gate" };
		case "workflow.decision_recorded":
			return { ...base, stage: "audit" };
		case "workflow.continuation_requested":
			return { ...base, domain: "recovery", stage: "recovery", outcome: "recovered" };
		case "node.started":
			return { ...base, stage: "dispatch", outcome: "started" };
		case "node.waiting":
			return { ...base, stage: "delegation", outcome: "blocked" };
		case "node.completed":
			return { ...base, stage: "delivery", outcome: "passed" };
		case "node.accepted":
			return { ...base, stage: "acceptance", outcome: "passed", code: "gate.acceptance.verify_failed" as DiagnosticCode };
		case "node.superseded":
		case "node.reopened":
		case "node.rejected":
			return { ...base, stage: "acceptance", outcome: "suppressed", code: "gate.workflow.nodes_unadjudicated" as DiagnosticCode };
		case "node.failed":
			return {
				...base,
				domain: "agent",
				stage: "failure",
				code: "agent.task.failed",
				disposition: "unexpected",
				outcome: "failed",
				severity: "error",
			};
		case "node.cancelled":
			return { ...base, domain: "control", stage: "failure", code: "control.budget_protection.auto_stop", outcome: "cancelled", severity: "warn" };
		case "workflow.clarification_recorded":
		case "workflow.brief_set":
		case "workflow.outline_set":
		case "workflow.node_updated":
		default:
			return base;
	}
}

/**
 * Projects allowlist-safe scalar attributes from an authoritative event.
 * Only neutral identifiers and bounded measures are projected; raw content
 * (goal, instructions, output, error text, paths) is never copied.
 */
function projectLifecycleAttributes(event: WorkflowEvent): Record<string, string | number | boolean | null> {
	const attrs: Record<string, string | number | boolean | null> = {
		sourceType: event.type,
	};
	const nodeEvent = event as Partial<{ nodeId: string; attemptId: string; status: string; model: string }>;
	if (typeof nodeEvent.nodeId === "string") attrs.nodeId = nodeEvent.nodeId;
	if (typeof nodeEvent.attemptId === "string") attrs.attemptId = nodeEvent.attemptId;
	if (typeof nodeEvent.status === "string") attrs.status = nodeEvent.status;
	if (typeof nodeEvent.model === "string") attrs.model = nodeEvent.model;
	const failure = (event as { failure?: { failureClass?: string; retryable?: boolean } }).failure;
	if (failure?.failureClass) attrs.failureClass = failure.failureClass;
	if (typeof failure?.retryable === "boolean") attrs.retryable = failure.retryable;
	return attrs;
}

/**
 * Deterministically projects a stream of authoritative events into replayable
 * lifecycle diagnostics. Callers obtain authoritative events either from
 * `projectFromEventLog` (reads `events.jsonl`) or by passing an in-memory
 * array. The returned stream is self-contained: every record carries a
 * deterministic eventId and a chained integrity hash, so it can be replayed or
 * verified without the source log.
 */
export function projectLifecycleDiagnostics(
	events: WorkflowEvent[],
	options: LifecycleProjectorOptions,
): LifecycleProjectionResult {
	const now = options.now ?? Date.now;
	const stream: WorkflowDiagnosticEventV1[] = [];
	let lastHash: string | undefined;
	let rejected = 0;
	let sequence = -1;

	const traceId = saltedFingerprint(`workflow:${options.workflowId}`, options.salt);

	for (const event of events) {
		const cls = classifyLifecycleEvent(event);
		sequence += 1;
		const observedAt = typeof event.at === "number" ? event.at : now();
		const eventType = options.eventType ?? "workflow.lifecycle.observed";
		const eventId = deterministicEventId({
			schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
			workflowId: options.workflowId,
			sourceEventId: event.id,
			eventType,
			payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
		});
		const attributes = projectLifecycleAttributes(event);
		const classification: WorkflowDiagnosticClassification = {
			domain: cls.domain,
			stage: cls.stage,
			code: cls.code,
			retryability: cls.disposition === "unexpected" ? "retryable" : "not_applicable",
		};

		const record: WorkflowDiagnosticEventV1 = {
			schema: DIAGNOSTIC_SCHEMA_ID,
			schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
			payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
			eventId,
			eventType,
			sequence,
			observedAt,
			severity: cls.severity,
			disposition: cls.disposition,
			outcome: cls.outcome,
			scope: { workflowId: options.workflowId, ...(typeof (event as { nodeId?: string }).nodeId === "string" ? { nodeId: (event as { nodeId: string }).nodeId } : {}) },
			correlation: {
				traceId,
				spanId: saltedFingerprint(`span:${event.id}`, options.salt),
				sourceEventId: event.id,
			},
			classification,
			attributes,
			integrity: { previousHash: lastHash, hash: "" },
		};
		if ("node.failed" === event.type || "node.cancelled" === event.type) {
			const raw = (event as { error: string }).error ?? "";
			const redacted = redactErrorMessage(raw, { source: "node", salt: options.salt });
			record.error = {
				code: redacted.code,
				fingerprint: redacted.fingerprint,
				...(redacted.safeSummary ? { safeSummary: redacted.safeSummary } : {}),
				redactionCount: redacted.redactionCount,
			};
			record.outcome = "failed";
			record.classification.failureClass = undefined;
		}
		record.integrity.hash = canonicalRecordHash(record, options.salt);
		lastHash = record.integrity.hash;
		stream.push(record);
	}

	return { events: stream, sourceEventCount: events.length, rejected, lastHash, lastSequence: sequence };
}

/**
 * Reads the authoritative `events.jsonl` log and projects it into a replayable
 * lifecycle diagnostic stream. A corrupt line aborts the projection (the
 * authoritative log is authoritative; corruption is surfaced, not silently
 * skipped), mirroring the read behavior of `WorkflowStore.load`.
 */
export function projectFromEventLog(
	eventsFilePath: string,
	options: LifecycleProjectorOptions,
): LifecycleProjectionResult {
	const raw = fs.readFileSync(eventsFilePath, "utf-8");
	const events: WorkflowEvent[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid workflow event JSON at line ${index + 1}: ${String(error)}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Invalid workflow event at line ${index + 1}: expected an object.`);
		}
		events.push(parsed as WorkflowEvent);
	}
	return projectLifecycleDiagnostics(events, options);
}
