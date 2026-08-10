/**
 * Versioned workflow diagnostic event contract (T6 Phase 0).
 *
 * This module is intentionally **type-pure**: it carries no runtime behavior,
 * no I/O, and no import cycle with the workflow reducer or store. Diagnostic
 * observations are non-authoritative sidecar events; they never participate in
 * workflow state transitions and must never become a second state machine.
 *
 * Privacy invariant (metadata-only by default): every diagnostic event is an
 * allowlist of typed safe fields. Prompt, task, instructions, output, stdout,
 * stderr, tool arguments, environment values, tokens, secrets, and raw
 * filesystem paths are never part of the contract.
 */
import type { WorkflowArtifactClassification, WorkflowFailureClass } from "../types.ts";
import type { WorkflowJsonValue } from "../types.ts";

export const DIAGNOSTIC_SCHEMA_ID = "pi-agents-flow.workflow-diagnostic";
export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_PAYLOAD_VERSION = 1;

export type WorkflowSeverity = "debug" | "info" | "warn" | "error" | "critical";

export type WorkflowDisposition = "expected" | "degraded" | "unexpected";

export type WorkflowOutcome =
	| "started"
	| "passed"
	| "blocked"
	| "failed"
	| "cancelled"
	| "recovered"
	| "suppressed"
	| "unknown";

export type WorkflowDiagnosticDomain =
	| "gate"
	| "infrastructure"
	| "product"
	| "agent"
	| "control"
	| "recovery"
	| "telemetry";

export type WorkflowRetryability = "not_applicable" | "retryable" | "non_retryable" | "unknown";

export type MetricUnit =
	| "ms"
	| "bytes"
	| "count"
	| "tokens"
	| "usd"
	| "ratio"
	| "score_0_100"
	| "ratio_per_1000_minutes";

export type LinkKind = "artifact" | "quality_report" | "transcript" | "metadata";

export type WorkflowDiagnosticStage =
	| "queue"
	| "preflight"
	| "dispatch"
	| "delegation"
	| "response_validation"
	| "structured_output"
	| "output_registration"
	| "artifact_store"
	| "acceptance"
	| "gate"
	| "quality"
	| "failure"
	| "recovery"
	| "delivery"
	| "telemetry"
	| "audit"
	| "lifecycle";

export type WorkflowDiagnosticEventType =
	| "workflow.lifecycle.observed"
	| "scheduler.queue.evaluated"
	| "scheduler.attempt.dispatched"
	| "delegation.preflight.evaluated"
	| "delegation.response.observed"
	| "structured_output.validation.evaluated"
	| "structured_output.format_steer.completed"
	| "artifact.operation.completed"
	| "acceptance.gate.evaluated"
	| "workflow.gate.evaluated"
	| "workflow.quality.evaluated"
	| "workflow.failure.classified"
	| "workflow.recovery.attempted"
	| "workflow.recovery.completed"
	| "completion.delivery.observed"
	| "telemetry.redaction.applied"
	| "telemetry.write.failed"
	| "audit.generated";

/** Catalog object of stable machine diagnostic codes. */
export const DiagnosticCode = {
	// Expected gates (disposition=expected, domain=gate) — never failures.
	"gate.workflow.plan_required": "gate.workflow.plan_required",
	"gate.workflow.brief_required": "gate.workflow.brief_required",
	"gate.workflow.outline_required": "gate.workflow.outline_required",
	"gate.workflow.nodes_unadjudicated": "gate.workflow.nodes_unadjudicated",
	"gate.workflow.research_lane_shortfall": "gate.workflow.research_lane_shortfall",
	"gate.workflow.editor_lineage_missing": "gate.workflow.editor_lineage_missing",
	"gate.workflow.reviewer_release_missing": "gate.workflow.reviewer_release_missing",
	"gate.workflow.unresolved_gaps": "gate.workflow.unresolved_gaps",
	"gate.workflow.unresolved_conflicts": "gate.workflow.unresolved_conflicts",
	"gate.quality.threshold_not_met": "gate.quality.threshold_not_met",
	"gate.quality.release_exception_accepted": "gate.quality.release_exception_accepted",
	"gate.acceptance.evidence_missing": "gate.acceptance.evidence_missing",
	"gate.acceptance.verify_failed": "gate.acceptance.verify_failed",
	"gate.acceptance.review_blocked": "gate.acceptance.review_blocked",
	"gate.user.approval_declined": "gate.user.approval_declined",
	"gate.budget.attempt_ceiling_reached": "gate.budget.attempt_ceiling_reached",
	"gate.budget.node_cap_reached": "gate.budget.node_cap_reached",
	// Control outcomes.
	"control.budget_protection.auto_stop": "control.budget_protection.auto_stop",
	// Infrastructure failures (disposition=unexpected, domain=infrastructure).
	"infra.process.terminated": "infra.process.terminated",
	"infra.process.parent_restarted": "infra.process.parent_restarted",
	"infra.timeout.child_response": "infra.timeout.child_response",
	"infra.timeout.detached_wait": "infra.timeout.detached_wait",
	"infra.event_store.read_failed": "infra.event_store.read_failed",
	"infra.event_store.write_failed": "infra.event_store.write_failed",
	"infra.event_store.corrupt": "infra.event_store.corrupt",
	"infra.manifest.write_failed": "infra.manifest.write_failed",
	"infra.artifact_store.io_failed": "infra.artifact_store.io_failed",
	"infra.artifact_store.integrity_failed": "infra.artifact_store.integrity_failed",
	"infra.result_watcher.watch_failed": "infra.result_watcher.watch_failed",
	"infra.result_watcher.delivery_failed": "infra.result_watcher.delivery_failed",
	// Product/configuration/contract failures (domain=product).
	"product.preflight.agent_missing": "product.preflight.agent_missing",
	"product.preflight.model_invalid": "product.preflight.model_invalid",
	"product.preflight.capability_violation": "product.preflight.capability_violation",
	"product.plan.invalid_dag": "product.plan.invalid_dag",
	"product.plan.data_contract_invalid": "product.plan.data_contract_invalid",
	"product.structured_output.schema_invalid": "product.structured_output.schema_invalid",
	"product.structured_output.result_invalid": "product.structured_output.result_invalid",
	"product.output.registration_failed": "product.output.registration_failed",
	"product.artifact.path_policy_violation": "product.artifact.path_policy_violation",
	"product.delegation.protocol_invalid": "product.delegation.protocol_invalid",
	"product.recovery.metadata_invalid": "product.recovery.metadata_invalid",
	// Agent/task failures (domain=agent).
	"agent.task.failed": "agent.task.failed",
	"agent.tool.failed": "agent.tool.failed",
	"agent.output_contract_violation": "agent.output_contract_violation",
	"agent.output.missing": "agent.output.missing",
	"agent.turn_budget_exhausted": "agent.turn_budget_exhausted",
	"agent.tool_budget_exhausted": "agent.tool_budget_exhausted",
	"agent.empty_response": "agent.empty_response",
	"agent.completion_guard_failed": "agent.completion_guard_failed",
} as const;

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export interface WorkflowDiagnosticScope {
	workflowId: string;
	workflowRevision?: number;
	nodeId?: string;
	attemptId?: string;
	schedulerInvocationId?: string;
	/** Salted hash of a child run id; never the raw child run id in rollups. */
	childRunIdHash?: string;
}

export interface WorkflowDiagnosticCorrelation {
	/** Workflow-scoped (salted workflow id hash for exports). */
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	/** Salted hash of a provider/session request id. */
	requestIdHash?: string;
	/** Links a diagnostic to its durable WorkflowEvent.id. */
	sourceEventId?: string;
	/** Links recovery to the incident it recovered from. */
	causationEventId?: string;
}

export interface WorkflowDiagnosticClassification {
	domain: WorkflowDiagnosticDomain;
	stage: WorkflowDiagnosticStage;
	/** Stable machine code; never free-form error text. */
	code: DiagnosticCode;
	retryability: WorkflowRetryability;
	failureClass?: WorkflowFailureClass;
}

/** Safe attribute values; only typed primitives may appear in a diagnostic. */
export type WorkflowDiagnosticAttribute = string | number | boolean | null;

export interface WorkflowDiagnosticMeasurement {
	value: number;
	unit: MetricUnit;
}

export interface WorkflowDiagnosticLink {
	kind: LinkKind;
	/** Logical artifact id or content digest; never a materialized path. */
	id?: string;
	sha256?: string;
	classification?: WorkflowArtifactClassification;
	available: boolean;
}

export interface WorkflowDiagnosticError {
	/** Stable mapped code for known errors, else a normalized fallback code. */
	code: string;
	/** Hash of the normalized, redacted error; safe to share. */
	fingerprint: string;
	/** Bounded, redacted summary. Absent by default for secret-prone sources. */
	safeSummary?: string;
	redactionCount: number;
}

export interface WorkflowDiagnosticIntegrity {
	previousHash?: string;
	hash: string;
}

/**
 * Versioned diagnostic event envelope (V1).
 *
 * `schema`/`schemaVersion` version the envelope shape; `payloadVersion`
 * versions backward-compatible payload additions. Readers accept unknown
 * attributes and unknown event types, but reject higher envelope versions while
 * marking audit completeness. Unknown codes are never coerced to a generic
 * failure silently.
 */
export interface WorkflowDiagnosticEventV1 {
	schema: typeof DIAGNOSTIC_SCHEMA_ID;
	schemaVersion: 1;
	payloadVersion: 1;
	/** Deterministic where replayable: sha256(schemaVersion|workflowId|sourceEventId|eventType|payloadVersion). */
	eventId: string;
	eventType: WorkflowDiagnosticEventType;
	/** Sidecar-local monotonic sequence. */
	sequence: number;
	/** Epoch ms when the observation was recorded. */
	observedAt: number;
	/** Source timestamp, if different from observedAt. */
	occurredAt?: number;
	severity: WorkflowSeverity;
	disposition: WorkflowDisposition;
	outcome: WorkflowOutcome;
	scope: WorkflowDiagnosticScope;
	correlation: WorkflowDiagnosticCorrelation;
	classification: WorkflowDiagnosticClassification;
	/** Allowlist per event type. Arbitrary object serialization is forbidden. */
	attributes: Record<string, WorkflowDiagnosticAttribute>;
	measurements?: Record<string, WorkflowDiagnosticMeasurement>;
	links?: WorkflowDiagnosticLink[];
	error?: WorkflowDiagnosticError;
	integrity?: WorkflowDiagnosticIntegrity;
}

/**
 * Provider/model identifiers are normalized dimensions. Session ids, request
 * ids, and child run ids are hashed with a local installation salt before they
 * leave the run-local audit.
 */
export interface DiagnosticSaltProvider {
	/** Local installation salt used to hash cross-run identifiers. */
	salt: string;
}

/** Re-exported for consumers that need a JSON-compatible scalar type. */
export type DiagnosticJsonScalar = WorkflowDiagnosticAttribute;
export type DiagnosticJsonValue = WorkflowJsonValue;
