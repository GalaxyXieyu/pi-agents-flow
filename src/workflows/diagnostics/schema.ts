/**
 * JSON Schema definitions for the versioned workflow diagnostic contract
 * (T6 Phase 0).
 *
 * Built with TypeBox. The exported schema is the strict envelope the sink and
 * audit projector validate against. `schema.ts` imports only from `types.ts`
 * (catalog values); neither module imports the reducer/store, so there is no
 * runtime import cycle with workflow state.
 */
import { Type, type Static } from "typebox";

import {
	DiagnosticCode,
	type WorkflowDiagnosticEventType,
	type WorkflowDiagnosticStage,
	type WorkflowDiagnosticDomain,
	type WorkflowDisposition,
	type WorkflowOutcome,
	type WorkflowSeverity,
	type WorkflowRetryability,
	type MetricUnit,
	type LinkKind,
} from "./types.ts";

/** Catalog arrays derived from the type-level unions in `types.ts`. */
export const DiagnosticEventTypeCatalog = [
	"workflow.lifecycle.observed",
	"scheduler.queue.evaluated",
	"scheduler.attempt.dispatched",
	"delegation.preflight.evaluated",
	"delegation.response.observed",
	"structured_output.validation.evaluated",
	"structured_output.format_steer.completed",
	"artifact.operation.completed",
	"acceptance.gate.evaluated",
	"workflow.gate.evaluated",
	"workflow.quality.evaluated",
	"workflow.failure.classified",
	"workflow.recovery.attempted",
	"workflow.recovery.completed",
	"completion.delivery.observed",
	"telemetry.redaction.applied",
	"telemetry.write.failed",
	"audit.generated",
] as const satisfies readonly WorkflowDiagnosticEventType[];

export const DiagnosticStageCatalog = [
	"queue",
	"preflight",
	"dispatch",
	"delegation",
	"response_validation",
	"structured_output",
	"output_registration",
	"artifact_store",
	"acceptance",
	"gate",
	"quality",
	"failure",
	"recovery",
	"delivery",
	"telemetry",
	"audit",
	"lifecycle",
] as const satisfies readonly WorkflowDiagnosticStage[];

export const DiagnosticDomainCatalog = [
	"gate",
	"infrastructure",
	"product",
	"agent",
	"control",
	"recovery",
	"telemetry",
] as const satisfies readonly WorkflowDiagnosticDomain[];

export const DispositionCatalog = [
	"expected",
	"degraded",
	"unexpected",
] as const satisfies readonly WorkflowDisposition[];

export const OutcomeCatalog = [
	"started",
	"passed",
	"blocked",
	"failed",
	"cancelled",
	"recovered",
	"suppressed",
	"unknown",
] as const satisfies readonly WorkflowOutcome[];

export const SeverityCatalog = [
	"debug",
	"info",
	"warn",
	"error",
	"critical",
] as const satisfies readonly WorkflowSeverity[];

export const RetryabilityCatalog = [
	"not_applicable",
	"retryable",
	"non_retryable",
	"unknown",
] as const satisfies readonly WorkflowRetryability[];

export const MetricUnitCatalog = [
	"ms",
	"bytes",
	"count",
	"tokens",
	"usd",
	"ratio",
	"score_0_100",
	"ratio_per_1000_minutes",
] as const satisfies readonly MetricUnit[];

export const LinkKindCatalog = [
	"artifact",
	"quality_report",
	"transcript",
	"metadata",
] as const satisfies readonly LinkKind[];

export const WorkflowFailureClassCatalog = [
	"provider_quota_exhausted",
	"provider_auth_failed",
	"provider_rate_limited",
	"provider_unavailable",
	"provider_stream_failed",
	"provider_transport_failed",
	"process_terminated",
	"turn_budget_exhausted",
	"tool_budget_exhausted",
	"timeout",
	"invalid_result",
	"output_registration_failed",
	"preflight_failed",
	"cancelled",
	"task_failed",
] as const;

/** Complete catalog of stable machine diagnostic codes. */
export const DiagnosticCodeCatalog = Object.values(DiagnosticCode);

const DiagnosticCodeEnum = Type.Union(
	DiagnosticCodeCatalog.map((code) => Type.Literal(code)) as [
		ReturnType<typeof Type.Literal>,
		ReturnType<typeof Type.Literal>,
		...ReturnType<typeof Type.Literal>[],
	],
);

const DiagnosticScopeSchema = Type.Object(
	{
		workflowId: Type.String({ minLength: 1 }),
		workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		nodeId: Type.Optional(Type.String({ minLength: 1 })),
		attemptId: Type.Optional(Type.String({ minLength: 1 })),
		schedulerInvocationId: Type.Optional(Type.String({ minLength: 1 })),
		childRunIdHash: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const CorrelationSchema = Type.Object(
	{
		traceId: Type.String({ minLength: 1 }),
		spanId: Type.String({ minLength: 1 }),
		parentSpanId: Type.Optional(Type.String({ minLength: 1 })),
		requestIdHash: Type.Optional(Type.String({ minLength: 1 })),
		sourceEventId: Type.Optional(Type.String({ minLength: 1 })),
		causationEventId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const ClassificationSchema = Type.Object(
	{
		domain: Type.String({ enum: DiagnosticDomainCatalog }),
		stage: Type.String({ enum: DiagnosticStageCatalog }),
		code: DiagnosticCodeEnum,
		retryability: Type.String({ enum: RetryabilityCatalog }),
		failureClass: Type.Optional(Type.String({ enum: WorkflowFailureClassCatalog })),
	},
	{ additionalProperties: false },
);

const MeasurementSchema = Type.Object(
	{
		value: Type.Number(),
		unit: Type.String({ enum: MetricUnitCatalog }),
	},
	{ additionalProperties: false },
);

const LinkSchema = Type.Object(
	{
		kind: Type.String({ enum: LinkKindCatalog }),
		id: Type.Optional(Type.String({ minLength: 1 })),
		sha256: Type.Optional(Type.String({ pattern: "^[A-Fa-f0-9]{64}$" })),
		classification: Type.Optional(Type.String({ enum: ["public", "internal", "sensitive", "secret"] })),
		available: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ErrorSchema = Type.Object(
	{
		code: Type.String({ minLength: 1 }),
		fingerprint: Type.String({ minLength: 1 }),
		safeSummary: Type.Optional(Type.String({ maxLength: 256 })),
		redactionCount: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const IntegritySchema = Type.Object(
	{
		previousHash: Type.Optional(Type.String({ minLength: 1 })),
		hash: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

/**
 * The canonical versioned diagnostic event envelope (V1). Validating a
 * submitted diagnostic against this schema proves it satisfies the metadata-only
 * contract: attributes are typed scalars, links carry only logical ids/digests,
 * and error summaries are bounded and redaction-counted.
 */
export const WorkflowDiagnosticEventV1Schema = Type.Object(
	{
		schema: Type.Literal("pi-agents-flow.workflow-diagnostic"),
		schemaVersion: Type.Literal(1),
		payloadVersion: Type.Literal(1),
		eventId: Type.String({ minLength: 1 }),
		eventType: Type.String({ enum: DiagnosticEventTypeCatalog }),
		sequence: Type.Integer({ minimum: 0 }),
		observedAt: Type.Integer({ minimum: 0 }),
		occurredAt: Type.Optional(Type.Integer({ minimum: 0 })),
		severity: Type.String({ enum: SeverityCatalog }),
		disposition: Type.String({ enum: DispositionCatalog }),
		outcome: Type.String({ enum: OutcomeCatalog }),
		scope: DiagnosticScopeSchema,
		correlation: CorrelationSchema,
		classification: ClassificationSchema,
		attributes: Type.Record(
			Type.String(),
			Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
			{ additionalProperties: false },
		),
		measurements: Type.Optional(
			Type.Record(Type.String(), MeasurementSchema, { additionalProperties: false }),
		),
		links: Type.Optional(Type.Array(LinkSchema)),
		error: Type.Optional(ErrorSchema),
		integrity: Type.Optional(IntegritySchema),
	},
	{ additionalProperties: false },
);

export type WorkflowDiagnosticEventV1Static = Static<typeof WorkflowDiagnosticEventV1Schema>;
