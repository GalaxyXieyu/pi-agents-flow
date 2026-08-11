import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkflowResult } from "../../src/workflows/result-contract.ts";
import type { WorkflowDataContract } from "../../src/workflows/types.ts";

const contract: WorkflowDataContract = {
	version: 1,
	profile: "research",
	inputs: [],
	outputs: {
		result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" },
	},
};

function validResult(): Record<string, unknown> {
	return {
		version: 1,
		summary: { text: "done", covers: [], omissions: [], confidence: "high" },
		outputs: { result: { kind: "value", value: { ok: true } } },
		diagnostics: { gaps: [], conflicts: [], warnings: [] },
		recommendations: [],
		evidence: {
			findings: [{ claim: "claim", evidence: [{ title: "source", url: "https://example.test", kind: "primary" }], confidence: "high" }],
			search: { queries: ["query"], fetchedUrls: ["https://example.test"], droppedSources: [{ url: "https://drop.test", reason: "duplicate" }] },
		},
	};
}

describe("workflow result runtime contract", () => {
	it("accepts the same nested result shape advertised by the schema", () => {
		assert.equal(parseWorkflowResult(validResult(), contract).summary.confidence, "high");
	});

	for (const [name, mutate, pattern] of [
		["summary confidence", (value: any) => { value.summary.confidence = "certain"; }, /summary\.confidence/],
		["finding confidence", (value: any) => { value.evidence.findings[0].confidence = "certain"; }, /findings\[0\]\.confidence/],
		["finding evidence kind", (value: any) => { value.evidence.findings[0].evidence[0].kind = "blog"; }, /evidence\[0\]\.kind/],
		["gap shape", (value: any) => { value.diagnostics.gaps = [{ question: "what" }]; }, /diagnostics\.gaps\[0\]/],
		["conflict shape", (value: any) => { value.diagnostics.conflicts = [{ statement: "x", alternatives: "y", evidence: [] }]; }, /alternatives/],
		["dropped source shape", (value: any) => { value.evidence.search.droppedSources = [{ url: "https://drop.test" }]; }, /droppedSources\[0\]/],
		["undeclared nested field", (value: any) => { value.evidence.findings[0].extra = true; }, /undeclared field/],
	] as const) {
		it(`rejects invalid ${name}`, () => {
			const value = validResult();
			mutate(value);
			assert.throws(() => parseWorkflowResult(value, contract), pattern);
		});
	}

	it("rejects a malformed optional file digest", () => {
		const value = validResult() as any;
		value.outputs.result = { kind: "file", path: "/tmp/result.json", sha256: "abc" };
		assert.throws(() => parseWorkflowResult(value, contract), /64 hexadecimal/);
	});

	it("requires an envelope-level pass verdict and release for reviewer results", () => {
		const reviewerContract: WorkflowDataContract = { ...contract, profile: "reviewer", outputs: { review: { mediaType: "text/plain", description: "review", storage: "inline", required: true, classification: "internal" } } };
		const reviewerResult = { ...validResult(), outputs: { review: { kind: "value", value: "approved" } }, review: { verdict: "pass" }, extensions: { release: { release: true, rationale: "All release criteria are met." } } };
		assert.equal(parseWorkflowResult(reviewerResult, reviewerContract).review?.verdict, "pass");
		const missingRelease = structuredClone(reviewerResult);
		delete (missingRelease as { extensions?: unknown }).extensions;
		assert.throws(() => parseWorkflowResult(missingRelease, reviewerContract), /extensions\.release must be an object/);
		const failedWithRelease = structuredClone(reviewerResult);
		(failedWithRelease as { review: { verdict: string } }).review.verdict = "fail";
		assert.throws(() => parseWorkflowResult(failedWithRelease, reviewerContract), /must be omitted/);
		const whitespaceRationale = structuredClone(reviewerResult);
		((whitespaceRationale as { extensions: { release: { rationale: string } } }).extensions.release.rationale) = "   ";
		assert.throws(() => parseWorkflowResult(whitespaceRationale, reviewerContract), /rationale must be a non-empty/);
		const unknownReleaseField = structuredClone(reviewerResult);
		(unknownReleaseField as { extensions: { release: Record<string, unknown> } }).extensions.release.extra = true;
		assert.throws(() => parseWorkflowResult(unknownReleaseField, reviewerContract), /extensions\.release contains undeclared field/);
	});
});
