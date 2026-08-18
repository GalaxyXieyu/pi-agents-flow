import { MAX_WORKFLOW_EXTENSION_BYTES, MAX_WORKFLOW_SUMMARY_BYTES, jsonBytes } from "./data-contract.ts";
import type { WorkflowDataContract, WorkflowFinding, WorkflowJsonValue, WorkflowResult, WorkflowSearchTrace } from "./types.ts";

export const WORKFLOW_RESULT_SUBMISSION_GUIDE = [
	"Return the complete WorkflowResult through the tool-level structured_output envelope: {value:{version:1,summary:{...},outputs:{...},diagnostics:{...},recommendations:[...],evidence:{...}}}.",
	"The outer tool `value` contains the COMPLETE WorkflowResult. Do not place version, summary, outputs, diagnostics, recommendations, evidence, review, or extensions beside that outer `value`.",
	"Prefer that outer INLINE `value` whenever the whole WorkflowResult is only a few KB. Do not invent a tool-level `path` for a small result.",
	"Inside WorkflowResult.outputs, submit each declared port using {kind:'value', value:...} or {kind:'file', path:'...', sha256:'...'}; these inner port fields are different from the outer tool transport.",
	"summary.text is a bounded semantic summary, never the complete document or dataset.",
	"Two different paths exist and must not be mixed: (1) tool-level structured_output.path is only for an already-written complete-result JSON file in the child submission directory; (2) inner outputs[port].kind=file path is a preallocated output slot listed under Output slots.",
	"Large text, documents, logs, and datasets: FIRST write the content exactly to that port's preallocated output slot path, THEN submit a compact WorkflowResult whose outputs[port] is {kind:'file', path:'<that slot>', sha256:'...'}. Never submit kind:file for a path you did not actually write. Never use an output-slot path as the outer tool `path`.",
	"Use diagnostics for gaps, conflicts, and warnings. Research profiles also return evidence.findings and evidence.search.",
].join("\n");

function portSubmissionSchema(port: WorkflowDataContract["outputs"][string]): Record<string, unknown> {
	const valueSchema = port.schema ?? {};
	return {
		type: "object",
		additionalProperties: false,
		required: ["kind"],
		properties: {
			kind: { type: "string", enum: ["value", "file"] },
			value: valueSchema,
			path: { type: "string", minLength: 1 },
			sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
		},
		oneOf: [
			{ properties: { kind: { const: "value" } }, required: ["kind", "value"], not: { anyOf: [{ required: ["path"] }, { required: ["sha256"] }] } },
			{ properties: { kind: { const: "file" } }, required: ["kind", "path"], not: { required: ["value"] } },
		],
	};
}

function findingSchema(): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["claim", "evidence", "confidence"],
		properties: {
			claim: { type: "string" },
			evidence: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: { type: "string" }, url: { type: "string" }, artifactPath: { type: "string" }, quote: { type: "string" },
						kind: { type: "string", enum: ["primary", "secondary", "community"] }, publishedAt: { type: "string" }, retrievedAt: { type: "string" },
					},
				},
			},
			confidence: { type: "string", enum: ["high", "medium", "low"] },
		},
	};
}

export function workflowResultSchema(contract: WorkflowDataContract): Record<string, unknown> {
	const requiredOutputs = Object.entries(contract.outputs).filter(([, port]) => port.required).map(([name]) => name);
	const evidenceRequired = contract.profile === "research" || contract.profile === "writer";
	const reviewerProfile = contract.profile === "reviewer";
	return {
		type: "object",
		additionalProperties: false,
		required: ["version", "summary", "outputs", "diagnostics", "recommendations", ...(evidenceRequired ? ["evidence"] : []), ...(reviewerProfile ? ["review"] : [])],
		properties: {
			version: { const: 1 },
			summary: {
				type: "object", additionalProperties: false, required: ["text", "covers", "omissions", "confidence"],
				properties: { text: { type: "string", maxLength: MAX_WORKFLOW_SUMMARY_BYTES }, covers: { type: "array", items: { type: "string" } }, omissions: { type: "array", items: { type: "string" } }, confidence: { type: "string", enum: ["high", "medium", "low"] } },
			},
			outputs: { type: "object", additionalProperties: false, required: requiredOutputs, properties: Object.fromEntries(Object.entries(contract.outputs).map(([name, port]) => [name, portSubmissionSchema(port)])) },
			diagnostics: {
				type: "object", additionalProperties: false, required: ["gaps", "conflicts", "warnings"],
				properties: {
					gaps: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "reason"], properties: { question: { type: "string" }, reason: { type: "string" } } } },
					conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["statement", "alternatives", "evidence"], properties: { statement: { type: "string" }, alternatives: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "string" } } } } },
					warnings: { type: "array", items: { type: "string" } },
				},
			},
			recommendations: { type: "array", items: { type: "string" } },
			evidence: {
				type: "object", additionalProperties: false, required: ["findings"],
				properties: {
					findings: { type: "array", items: findingSchema() },
					search: { type: "object", additionalProperties: false, required: ["queries", "fetchedUrls", "droppedSources"], properties: { queries: { type: "array", items: { type: "string" } }, fetchedUrls: { type: "array", items: { type: "string" } }, droppedSources: { type: "array", items: { type: "object", additionalProperties: false, required: ["url", "reason"], properties: { url: { type: "string" }, reason: { type: "string" } } } } } },
				},
			},
			...(reviewerProfile ? { review: { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "string", enum: ["pass", "fail"] } } } } : {}),
			extensions: { type: "object", additionalProperties: true },
		},
		...(reviewerProfile ? {
			allOf: [{
				if: { properties: { review: { properties: { verdict: { const: "pass" } }, required: ["verdict"] } }, required: ["review"] },
				then: {
					required: ["extensions"],
					properties: {
						extensions: {
							type: "object",
							required: ["release"],
							properties: {
								release: {
									type: "object",
									additionalProperties: false,
									required: ["release", "rationale"],
									properties: {
										release: { const: true }, rationale: { type: "string", pattern: ".*\\S.*" },
										gapsAccepted: { type: "boolean" }, conflictsAccepted: { type: "boolean" },
										citationShortfallAccepted: { type: "boolean" }, lengthShortfallAccepted: { type: "boolean" },
									},
								},
							},
						},
					},
				},
				else: { properties: { extensions: { not: { required: ["release"] } } } },
			}],
		} : {}),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be a string array.`);
	return [...value];
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new Error(`${field} contains undeclared field '${unknown}'.`);
}

function confidence(value: unknown, field: string): WorkflowResult["summary"]["confidence"] {
	if (value !== "high" && value !== "medium" && value !== "low") throw new Error(`${field} must be high, medium, or low.`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string.`);
	return value;
}

function parseFindings(value: unknown): WorkflowFinding[] {
	if (!Array.isArray(value)) throw new Error("evidence.findings must be an array.");
	return value.map((finding, findingIndex) => {
		const field = `evidence.findings[${findingIndex}]`;
		if (!record(finding)) throw new Error(`${field} must be an object.`);
		assertAllowedKeys(finding, ["claim", "evidence", "confidence"], field);
		if (typeof finding.claim !== "string") throw new Error(`${field}.claim must be a string.`);
		if (!Array.isArray(finding.evidence)) throw new Error(`${field}.evidence must be an array.`);
		const evidence = finding.evidence.map((entry, evidenceIndex) => {
			const evidenceField = `${field}.evidence[${evidenceIndex}]`;
			if (!record(entry)) throw new Error(`${evidenceField} must be an object.`);
			assertAllowedKeys(entry, ["title", "url", "artifactPath", "quote", "kind", "publishedAt", "retrievedAt"], evidenceField);
			const kind = entry.kind === undefined ? undefined : confidenceEvidenceKind(entry.kind, `${evidenceField}.kind`);
			return {
				...(optionalString(entry.title, `${evidenceField}.title`) !== undefined ? { title: entry.title as string } : {}),
				...(optionalString(entry.url, `${evidenceField}.url`) !== undefined ? { url: entry.url as string } : {}),
				...(optionalString(entry.artifactPath, `${evidenceField}.artifactPath`) !== undefined ? { artifactPath: entry.artifactPath as string } : {}),
				...(optionalString(entry.quote, `${evidenceField}.quote`) !== undefined ? { quote: entry.quote as string } : {}),
				...(kind ? { kind } : {}),
				...(optionalString(entry.publishedAt, `${evidenceField}.publishedAt`) !== undefined ? { publishedAt: entry.publishedAt as string } : {}),
				...(optionalString(entry.retrievedAt, `${evidenceField}.retrievedAt`) !== undefined ? { retrievedAt: entry.retrievedAt as string } : {}),
			};
		});
		return { claim: finding.claim, evidence, confidence: confidence(finding.confidence, `${field}.confidence`) };
	});
}

function confidenceEvidenceKind(value: unknown, field: string): "primary" | "secondary" | "community" {
	if (value !== "primary" && value !== "secondary" && value !== "community") throw new Error(`${field} must be primary, secondary, or community.`);
	return value;
}

function parseSearch(value: unknown): WorkflowSearchTrace | undefined {
	if (value === undefined) return undefined;
	if (!record(value)) throw new Error("evidence.search must be an object.");
	assertAllowedKeys(value, ["queries", "fetchedUrls", "droppedSources"], "evidence.search");
	if (!Array.isArray(value.droppedSources)) throw new Error("evidence.search.droppedSources must be an array.");
	const droppedSources = value.droppedSources.map((source, index) => {
		const field = `evidence.search.droppedSources[${index}]`;
		if (!record(source)) throw new Error(`${field} must be an object.`);
		assertAllowedKeys(source, ["url", "reason"], field);
		if (typeof source.url !== "string" || typeof source.reason !== "string") throw new Error(`${field} requires string url and reason.`);
		return { url: source.url, reason: source.reason };
	});
	return { queries: strings(value.queries, "evidence.search.queries"), fetchedUrls: strings(value.fetchedUrls, "evidence.search.fetchedUrls"), droppedSources };
}

function parseGaps(value: unknown): WorkflowResult["diagnostics"]["gaps"] {
	if (!Array.isArray(value)) throw new Error("diagnostics.gaps must be an array.");
	return value.map((gap, index) => {
		const field = `diagnostics.gaps[${index}]`;
		if (!record(gap)) throw new Error(`${field} must be an object.`);
		assertAllowedKeys(gap, ["question", "reason"], field);
		if (typeof gap.question !== "string" || typeof gap.reason !== "string") throw new Error(`${field} requires string question and reason.`);
		return { question: gap.question, reason: gap.reason };
	});
}

function parseReviewerRelease(value: unknown): void {
	if (!record(value)) throw new Error("extensions.release must be an object for a passing reviewer.");
	assertAllowedKeys(value, ["release", "gapsAccepted", "conflictsAccepted", "citationShortfallAccepted", "lengthShortfallAccepted", "rationale"], "extensions.release");
	if (value.release !== true) throw new Error("extensions.release.release must be true for a passing reviewer.");
	if (typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error("extensions.release.rationale must be a non-empty string for a passing reviewer.");
	for (const name of ["gapsAccepted", "conflictsAccepted", "citationShortfallAccepted", "lengthShortfallAccepted"]) {
		if (value[name] !== undefined && typeof value[name] !== "boolean") throw new Error(`extensions.release.${name} must be a boolean.`);
	}
}

function parseReview(value: unknown): WorkflowResult["review"] {
	if (!record(value)) throw new Error("review must be an object for reviewer profiles.");
	assertAllowedKeys(value, ["verdict"], "review");
	if (value.verdict !== "pass" && value.verdict !== "fail") throw new Error("review.verdict must be pass or fail.");
	return { verdict: value.verdict };
}

function parseConflicts(value: unknown): WorkflowResult["diagnostics"]["conflicts"] {
	if (!Array.isArray(value)) throw new Error("diagnostics.conflicts must be an array.");
	return value.map((conflict, index) => {
		const field = `diagnostics.conflicts[${index}]`;
		if (!record(conflict)) throw new Error(`${field} must be an object.`);
		assertAllowedKeys(conflict, ["statement", "alternatives", "evidence"], field);
		if (typeof conflict.statement !== "string") throw new Error(`${field}.statement must be a string.`);
		return { statement: conflict.statement, alternatives: strings(conflict.alternatives, `${field}.alternatives`), evidence: strings(conflict.evidence, `${field}.evidence`) };
	});
}

export function parseWorkflowResult(value: unknown, contract: WorkflowDataContract): WorkflowResult {
	if (!record(value) || value.version !== 1) throw new Error("Workflow result version must be 1.");
	assertAllowedKeys(value, ["version", "summary", "outputs", "diagnostics", "recommendations", "evidence", "review", "extensions"], "Workflow result");
	if (!record(value.summary) || typeof value.summary.text !== "string" || !value.summary.text.trim()) throw new Error("Workflow result summary.text must be non-empty.");
	assertAllowedKeys(value.summary, ["text", "covers", "omissions", "confidence"], "summary");
	if (Buffer.byteLength(value.summary.text, "utf8") > MAX_WORKFLOW_SUMMARY_BYTES) throw new Error(`Workflow result summary exceeds ${MAX_WORKFLOW_SUMMARY_BYTES} bytes.`);
	if (!record(value.outputs)) throw new Error("Workflow result outputs must be an object.");
	const outputs: WorkflowResult["outputs"] = {};
	for (const [name, port] of Object.entries(contract.outputs)) {
		const submission = value.outputs[name];
		if (submission === undefined) {
			if (port.required) throw new Error(`Required output port '${name}' is missing.`);
			continue;
		}
		if (!record(submission) || (submission.kind !== "value" && submission.kind !== "file")) throw new Error(`Output port '${name}' submission is invalid.`);
		assertAllowedKeys(submission, ["kind", "value", "path", "sha256"], `Output port '${name}'`);
		if (submission.kind === "value") {
			if (!("value" in submission) || "path" in submission || "sha256" in submission) throw new Error(`Output port '${name}' value submission is invalid.`);
			if (port.mediaType.toLowerCase().startsWith("text/") && typeof submission.value !== "string") {
				throw new Error(`Output port '${name}' declares ${port.mediaType} but its value submission is not text.`);
			}
			outputs[name] = { kind: "value", value: structuredClone(submission.value) as WorkflowJsonValue };
		} else {
			if (typeof submission.path !== "string" || !submission.path.trim() || "value" in submission) throw new Error(`Output port '${name}' file submission is invalid.`);
			if (submission.sha256 !== undefined && (typeof submission.sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(submission.sha256))) {
				throw new Error(`Output port '${name}' sha256 must be 64 hexadecimal characters.`);
			}
			outputs[name] = { kind: "file", path: submission.path, ...(typeof submission.sha256 === "string" ? { sha256: submission.sha256.toLowerCase() } : {}) };
		}
	}
	const unknownPort = Object.keys(value.outputs).find((name) => !contract.outputs[name]);
	if (unknownPort) throw new Error(`Undeclared output port '${unknownPort}'.`);
	if (!record(value.diagnostics)) throw new Error("Workflow result diagnostics must be an object.");
	assertAllowedKeys(value.diagnostics, ["gaps", "conflicts", "warnings"], "diagnostics");
	const diagnostics = {
		gaps: parseGaps(value.diagnostics.gaps),
		conflicts: parseConflicts(value.diagnostics.conflicts),
		warnings: strings(value.diagnostics.warnings, "diagnostics.warnings"),
	};
	let evidence: WorkflowResult["evidence"];
	if (value.evidence !== undefined) {
		if (!record(value.evidence)) throw new Error("Workflow result evidence must be an object.");
		assertAllowedKeys(value.evidence, ["findings", "search"], "evidence");
		const search = parseSearch(value.evidence.search);
		evidence = { findings: parseFindings(value.evidence.findings), ...(search ? { search } : {}) };
	}
	if ((contract.profile === "research" || contract.profile === "writer") && !evidence) throw new Error(`Workflow profile '${contract.profile}' requires evidence.`);
	let extensions: Record<string, WorkflowJsonValue> | undefined;
	if (value.extensions !== undefined) {
		if (!record(value.extensions) || jsonBytes(value.extensions) > MAX_WORKFLOW_EXTENSION_BYTES) throw new Error(`Workflow result extensions must be a JSON object <= ${MAX_WORKFLOW_EXTENSION_BYTES} bytes.`);
		extensions = structuredClone(value.extensions) as Record<string, WorkflowJsonValue>;
	}
	const review = contract.profile === "reviewer" ? parseReview(value.review) : undefined;
	if (contract.profile !== "reviewer" && value.review !== undefined) throw new Error("review is only allowed for reviewer profiles.");
	if (review?.verdict === "pass") parseReviewerRelease(extensions?.release);
	if (review?.verdict === "fail" && extensions?.release !== undefined) throw new Error("extensions.release must be omitted when review.verdict is fail.");
	return {
		version: 1,
		summary: { text: value.summary.text, covers: strings(value.summary.covers, "summary.covers"), omissions: strings(value.summary.omissions, "summary.omissions"), confidence: confidence(value.summary.confidence, "summary.confidence") },
		outputs,
		diagnostics,
		recommendations: strings(value.recommendations, "recommendations"),
		...(evidence ? { evidence } : {}),
		...(review ? { review } : {}),
		...(extensions ? { extensions } : {}),
	};
}
