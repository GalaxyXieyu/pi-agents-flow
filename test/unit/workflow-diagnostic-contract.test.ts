import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Value } from "typebox/value";

import {
	DiagnosticCode,
	DIAGNOSTIC_PAYLOAD_VERSION,
	DIAGNOSTIC_SCHEMA_ID,
	DIAGNOSTIC_SCHEMA_VERSION,
	type WorkflowDiagnosticEventV1,
} from "../../src/workflows/diagnostics/types.ts";
import {
	DiagnosticCodeCatalog,
	DiagnosticDomainCatalog,
	DiagnosticEventTypeCatalog,
	DiagnosticStageCatalog,
	LinkKindCatalog,
	MetricUnitCatalog,
	OutcomeCatalog,
	RetryabilityCatalog,
	SeverityCatalog,
	WorkflowDiagnosticEventV1Schema,
} from "../../src/workflows/diagnostics/schema.ts";

/** A minimal, schema-valid V1 envelope fixture. */
function makeEvent(overrides: Partial<WorkflowDiagnosticEventV1> = {}): WorkflowDiagnosticEventV1 {
	return {
		schema: DIAGNOSTIC_SCHEMA_ID,
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
		eventId: "event-id-1",
		eventType: "workflow.lifecycle.observed",
		sequence: 0,
		observedAt: 1000,
		severity: "info",
		disposition: "expected",
		outcome: "passed",
		scope: { workflowId: "wf-1" },
		correlation: { traceId: "trace-1", spanId: "span-1", sourceEventId: "source-1" },
		classification: {
			domain: "gate",
			stage: "gate",
			code: "gate.workflow.plan_required",
			retryability: "not_applicable",
		},
		attributes: { sourceType: "workflow.started" },
		...overrides,
	};
}

describe("diagnostic contract — schema versioning", () => {
	it("exposes the versioned schema identifiers and a V1-typed envelope", () => {
		assert.equal(DIAGNOSTIC_SCHEMA_ID, "pi-agents-flow.workflow-diagnostic");
		assert.equal(DIAGNOSTIC_SCHEMA_VERSION, 1);
		assert.equal(DIAGNOSTIC_PAYLOAD_VERSION, 1);
		assert.equal(WorkflowDiagnosticEventV1Schema.type, "object");
	});

	it("accepts a canonical V1 envelope", () => {
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, makeEvent()), true);
	});

	it("rejects a higher envelope schemaVersion", () => {
		const event = makeEvent({ schemaVersion: 2 } as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), false);
	});

	it("rejects a higher payloadVersion", () => {
		const event = makeEvent({ payloadVersion: 2 } as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), false);
	});

	it("rejects an unknown schema id", () => {
		const event = makeEvent({ schema: "other.contract" } as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), false);
	});
});

describe("diagnostic contract — unknown field/type tolerance", () => {
	it("tolerates unknown attribute keys (forward-compatible payload additions)", () => {
		const event = makeEvent({ attributes: { sourceType: "workflow.started", futureField: "x", otherCount: 3 } });
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), true);
	});

	it("tolerates absent optional blocks (measurements/links/error/integrity/occurredAt)", () => {
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, makeEvent()), true);
	});

	it("accepts typed-scalar attribute values only", () => {
		const ok = makeEvent({ attributes: { s: "x", n: 3, b: true, nil: null } });
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, ok), true);
		const bad = makeEvent({ attributes: { nested: { a: 1 } } } as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, bad), false);
	});

	it("rejects unknown top-level fields (strict envelope is additionalProperties:false)", () => {
		const event = makeEvent({ extra: "nope" } as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), false);
	});

	it("rejects an unknown classification code without coercing it to a generic failure", () => {
		const event = makeEvent({
			classification: { domain: "gate", stage: "gate", code: "gate.not_in_catalog", retryability: "not_applicable" },
		} as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, event), false);
	});
});

describe("diagnostic contract — code/unit catalogs", () => {
	it("exposes exactly 49 stable diagnostic codes in the catalog", () => {
		assert.equal(Object.keys(DiagnosticCode).length, 49);
		assert.equal(DiagnosticCodeCatalog.length, 49);
		// Every catalog entry equals its own literal (stable, non-coerced).
		for (const code of DiagnosticCodeCatalog) {
			assert.equal(DiagnosticCode[code as keyof typeof DiagnosticCode], code);
		}
	});

	it("groups codes into expected gates, control, infra, product, and agent namespaces", () => {
		const codes = DiagnosticCodeCatalog;
		assert.ok(codes.some((code) => code.startsWith("gate.")));
		assert.ok(codes.some((code) => code.startsWith("control.")));
		assert.ok(codes.some((code) => code.startsWith("infra.")));
		assert.ok(codes.some((code) => code.startsWith("product.")));
		assert.ok(codes.some((code) => code.startsWith("agent.")));
	});

	it("exposes the full event-type/stage/domain/disposition/outcome/severity/retryability/unit/link-kind catalogs", () => {
		assert.equal(DiagnosticEventTypeCatalog.length, 18);
		assert.equal(DiagnosticStageCatalog.length, 17);
		assert.equal(DiagnosticDomainCatalog.length, 7);
		assert.equal(RetryabilityCatalog.length, 4);
		assert.equal(MetricUnitCatalog.length, 8);
		assert.equal(LinkKindCatalog.length, 4);
		// Outcome has 8 states and severity 5 states per the contract.
		assert.equal(OutcomeCatalog.length, 8);
		assert.equal(SeverityCatalog.length, 5);
	});

	it("validates a measurement with a catalog unit and rejects an unknown unit", () => {
		const withUnit = makeEvent({
			measurements: { latency: { value: 12.5, unit: "ms" } },
		});
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, withUnit), true);

		const badUnit = makeEvent({
			measurements: { latency: { value: 12.5, unit: "parsecs" } },
		} as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, badUnit), false);
	});

	it("validates a link sha256 as a 64-char hex digest", () => {
		const good = makeEvent({
			links: [{ kind: "artifact", sha256: "a".repeat(64), available: true }],
		});
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, good), true);

		const bad = makeEvent({
			links: [{ kind: "artifact", sha256: "not-hex", available: true }],
		} as unknown as Partial<WorkflowDiagnosticEventV1>);
		assert.equal(Value.Check(WorkflowDiagnosticEventV1Schema, bad), false);
	});
});
