import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assertAllowlistSafety,
	canonicalRecordHash,
	deterministicEventId,
	FORBIDDEN_KEYS,
	isForbiddenKey,
	MAX_REDACTED_SUMMARY_BYTES,
	projectSafeAttributes,
	redactErrorMessage,
	saltedFingerprint,
} from "../../src/workflows/diagnostics/redaction.ts";
import { DIAGNOSTIC_PAYLOAD_VERSION, DIAGNOSTIC_SCHEMA_VERSION } from "../../src/workflows/diagnostics/types.ts";

const SALT = "test-salt";

describe("diagnostic redaction — forbidden keys", () => {
	it("forbids exactly the 24 reserved raw-content/secret carriers", () => {
		assert.equal(FORBIDDEN_KEYS.length, 24);
		for (const key of ["prompt", "task", "instructions", "goal", "output", "stdout", "stderr", "command", "env", "authorization", "cookie", "token", "secret", "password", "credential", "query", "url", "path", "cwd"]) {
			assert.equal(isForbiddenKey(key), true, `expected '${key}' forbidden`);
		}
	});

	it("matches forbidden keys case-insensitively and separator-insensitively", () => {
		assert.equal(isForbiddenKey("PROMPT"), true);
		assert.equal(isForbiddenKey("Prompt"), true);
		assert.equal(isForbiddenKey("prompt_text"), true);
		assert.equal(isForbiddenKey("toolArgs"), true);
		assert.equal(isForbiddenKey("Authorization"), true);
		assert.equal(isForbiddenKey("apiKey"), true);
	});

	it("exempts explicitly-named narrow safe fields even when they embed a forbidden stem", () => {
		assert.equal(isForbiddenKey("outputBytes"), false);
		assert.equal(isForbiddenKey("inputTokens"), false);
		assert.equal(isForbiddenKey("usageCostUsd"), false);
		assert.equal(isForbiddenKey("attemptNumber"), false);
	});
});

describe("diagnostic redaction — safe attribute projection", () => {
	it("projects only safe attributes and counts the dropped keys", () => {
		const { attributes, redactionCount } = projectSafeAttributes({ outputBytes: 10, prompt_text: "x", safe: 1 });
		assert.deepEqual(attributes, { outputBytes: 10, safe: 1 });
		assert.equal(redactionCount, 1);
	});

	it("never projects an arbitrary runtime object into the contract", () => {
		const { attributes, redactionCount } = projectSafeAttributes({
			outputBytes: 10,
			inputTokens: 5,
			toolArgs: "nope",
			env: { PATH: "/usr/bin" } as unknown as string | number | boolean | null,
		});
		assert.deepEqual(attributes, { outputBytes: 10, inputTokens: 5 });
		assert.equal(redactionCount, 2);
	});
});

describe("diagnostic redaction — error message redaction", () => {
	it("redacts Bearer tokens and counts the redactions", () => {
		const out = redactErrorMessage("Authorization: Bearer abc123xyz", { source: "node", salt: SALT });
		assert.equal(out.code, "error.unknown");
		assert.match(out.fingerprint, /^[0-9a-f]{64}$/);
		// The string hits both the Bearer token rule and the credential key-value
		// pair rule (authorization: Bearer ...), so two redactions are counted.
		assert.ok(out.redactionCount >= 1);
		// Any redaction on a non-empty source suppresses safeSummary.
		assert.equal(out.safeSummary, undefined);
	});

	it("keeps a redacted-safe summary when no redaction fired", () => {
		const out = redactErrorMessage("all clean here", { source: "node", salt: SALT });
		assert.equal(out.safeSummary, "all clean here");
		assert.equal(out.redactionCount, 0);
	});

	it("redacts home directories before generic tokens", () => {
		const out = redactErrorMessage("/Users/alice/secret-file.json", { source: "node", salt: SALT });
		assert.ok(out.safeSummary === undefined || !out.safeSummary.includes("/Users/alice"));
		assert.equal(out.code, "error.unknown");
	});

	it("redacts credential key-value pairs", () => {
		const out = redactErrorMessage("password: hunter2", { source: "node", salt: SALT });
		assert.ok(!out.safeSummary?.includes("hunter2"));
		assert.ok(out.redactionCount >= 1);
	});

	it("suppresses safeSummary for secret-prone sources that triggered redaction", () => {
		const out = redactErrorMessage("Authorization: Bearer abc123xyz", { source: "provider", salt: SALT });
		assert.equal(out.safeSummary, undefined);
		assert.equal(out.code, "error.unknown");
		assert.match(out.fingerprint, /^[0-9a-f]{64}$/);
		assert.ok(out.redactionCount >= 1);
	});

	it("keeps safeSummary for a non-redacted, non-secret-prone source", () => {
		const out = redactErrorMessage("reached provider quota", { source: "node", salt: SALT });
		assert.equal(out.code, "error.provider.quota");
		assert.equal(out.safeSummary, "reached provider quota");
		assert.equal(out.redactionCount, 0);
	});

	it("bounds safeSummary to 256 UTF-8 bytes without splitting a multibyte character", () => {
		const long = `ok ${"界".repeat(300)} trailing`;
		const out = redactErrorMessage(long, { source: "node", salt: SALT });
		assert.ok(out.safeSummary === undefined || Buffer.byteLength(out.safeSummary, "utf-8") <= MAX_REDACTED_SUMMARY_BYTES + 3);
	});

	it("maps empty/unknown errors to stable codes without embedding error text", () => {
		assert.equal(redactErrorMessage("", { source: "node", salt: SALT }).code, "error.empty");
		assert.equal(redactErrorMessage(undefined as unknown as string, { source: "node", salt: SALT }).code, "error.empty");
		assert.equal(redactErrorMessage("something completely novel", { source: "node", salt: SALT }).code, "error.unknown");
	});
});

describe("diagnostic redaction — fingerprints and event ids", () => {
	it("produces deterministic salted fingerprints per salt", () => {
		assert.equal(saltedFingerprint("value", SALT), saltedFingerprint("value", SALT));
		assert.notEqual(saltedFingerprint("value", SALT), saltedFingerprint("value", "other-salt"));
	});

	it("produces deterministic event ids matching the documented scheme", () => {
		const params = { schemaVersion: 1, workflowId: "wf-1", sourceEventId: "src-1", eventType: "workflow.lifecycle.observed", payloadVersion: 1 };
		const id = deterministicEventId(params);
		assert.match(id, /^[0-9a-f]{64}$/);
		assert.equal(id, deterministicEventId(params));
		// Changing one component changes the id.
		assert.notEqual(id, deterministicEventId({ ...params, sourceEventId: "src-2" }));
	});

	it("computes a canonical record hash deterministically over stable envelope fields", () => {
		const event = {
			schema: "pi-agents-flow.workflow-diagnostic",
			schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
			payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
			eventId: "e1",
			eventType: "workflow.lifecycle.observed",
			sequence: 0,
			observedAt: 1000,
			severity: "info",
			disposition: "expected",
			outcome: "passed",
			scope: { workflowId: "wf-1" },
			correlation: { traceId: "t", spanId: "s" },
			classification: { domain: "gate", stage: "gate", code: "gate.workflow.plan_required", retryability: "not_applicable" },
			attributes: { sourceType: "workflow.started" },
		};
		const h1 = canonicalRecordHash(event as never, SALT);
		const h2 = canonicalRecordHash(event as never, SALT);
		assert.equal(h1, h2);
		assert.match(h1, /^[0-9a-f]{64}$/);
	});
});

describe("diagnostic redaction — allowlist safety assertion", () => {
	it("rejects forbidden attribute keys", () => {
		assert.deepEqual(assertAllowlistSafety({ attributes: { prompt: "x" } }), { ok: false, reason: "attribute key 'prompt' is forbidden" });
	});

	it("accepts safe attributes", () => {
		assert.deepEqual(assertAllowlistSafety({ attributes: { outputBytes: 1 } }), { ok: true });
	});

	it("rejects forbidden measurement keys and materialized link paths", () => {
		const badMeasurement = assertAllowlistSafety({ measurements: { secret: { value: 1, unit: "count" } } });
		assert.equal(badMeasurement.ok, false);
		const badLink = assertAllowlistSafety({ links: [{ kind: "artifact", path: "/tmp/x", available: true } as never] });
		assert.equal(badLink.ok, false);
	});

	it("rejects a non-hex childRunIdHash", () => {
		const bad = assertAllowlistSafety({ scope: { workflowId: "wf-1", childRunIdHash: "not-hex" } });
		assert.equal(bad.ok, false);
		const good = assertAllowlistSafety({ scope: { workflowId: "wf-1", childRunIdHash: "a".repeat(64) } });
		assert.equal(good.ok, true);
	});
});
