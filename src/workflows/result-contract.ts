import { MAX_WORKFLOW_EXTENSION_BYTES, MAX_WORKFLOW_SUMMARY_BYTES, jsonBytes } from "./data-contract.ts";
import type { WorkflowDataContract, WorkflowFinding, WorkflowJsonValue, WorkflowResult, WorkflowSearchTrace } from "./types.ts";

export const WORKFLOW_RESULT_SUBMISSION_GUIDE = [
	"Return WorkflowResult through structured_output.",
	"summary.text is a bounded semantic summary, never the complete document or dataset.",
	"Submit every declared output port in outputs using {kind:'value', value:...} or {kind:'file', path:'...', sha256:'...'}.",
	"Large text, documents, logs, and datasets must use a file submission from the structured-output submissions directory.",
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
						title: { type: "string" }, url: { type: "string" }, artifactId: { type: "string" }, quote: { type: "string" },
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
	return {
		type: "object",
		additionalProperties: false,
		required: ["version", "summary", "outputs", "diagnostics", "recommendations", ...(evidenceRequired ? ["evidence"] : [])],
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
			extensions: { type: "object", additionalProperties: true },
		},
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be a string array.`);
	return [...value];
}

function parseFindings(value: unknown): WorkflowFinding[] {
	if (!Array.isArray(value)) throw new Error("evidence.findings must be an array.");
	return structuredClone(value) as WorkflowFinding[];
}

function parseSearch(value: unknown): WorkflowSearchTrace | undefined {
	if (value === undefined) return undefined;
	if (!record(value)) throw new Error("evidence.search must be an object.");
	return { queries: strings(value.queries, "evidence.search.queries"), fetchedUrls: strings(value.fetchedUrls, "evidence.search.fetchedUrls"), droppedSources: structuredClone(value.droppedSources) as WorkflowSearchTrace["droppedSources"] };
}

export function parseWorkflowResult(value: unknown, contract: WorkflowDataContract): WorkflowResult {
	if (!record(value) || value.version !== 1) throw new Error("Workflow result version must be 1.");
	if (!record(value.summary) || typeof value.summary.text !== "string" || !value.summary.text.trim()) throw new Error("Workflow result summary.text must be non-empty.");
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
		if (submission.kind === "value") {
			if (!("value" in submission) || "path" in submission || "sha256" in submission) throw new Error(`Output port '${name}' value submission is invalid.`);
			outputs[name] = { kind: "value", value: structuredClone(submission.value) as WorkflowJsonValue };
		} else {
			if (typeof submission.path !== "string" || !submission.path.trim() || "value" in submission) throw new Error(`Output port '${name}' file submission is invalid.`);
			outputs[name] = { kind: "file", path: submission.path, ...(typeof submission.sha256 === "string" ? { sha256: submission.sha256.toLowerCase() } : {}) };
		}
	}
	const unknownPort = Object.keys(value.outputs).find((name) => !contract.outputs[name]);
	if (unknownPort) throw new Error(`Undeclared output port '${unknownPort}'.`);
	if (!record(value.diagnostics)) throw new Error("Workflow result diagnostics must be an object.");
	const diagnostics = {
		gaps: structuredClone(value.diagnostics.gaps) as WorkflowResult["diagnostics"]["gaps"],
		conflicts: structuredClone(value.diagnostics.conflicts) as WorkflowResult["diagnostics"]["conflicts"],
		warnings: strings(value.diagnostics.warnings, "diagnostics.warnings"),
	};
	if (!Array.isArray(diagnostics.gaps) || !Array.isArray(diagnostics.conflicts)) throw new Error("Workflow result diagnostics gaps/conflicts must be arrays.");
	let evidence: WorkflowResult["evidence"];
	if (value.evidence !== undefined) {
		if (!record(value.evidence)) throw new Error("Workflow result evidence must be an object.");
		evidence = { findings: parseFindings(value.evidence.findings), ...(parseSearch(value.evidence.search) ? { search: parseSearch(value.evidence.search) } : {}) };
	}
	if ((contract.profile === "research" || contract.profile === "writer") && !evidence) throw new Error(`Workflow profile '${contract.profile}' requires evidence.`);
	let extensions: Record<string, WorkflowJsonValue> | undefined;
	if (value.extensions !== undefined) {
		if (!record(value.extensions) || jsonBytes(value.extensions) > MAX_WORKFLOW_EXTENSION_BYTES) throw new Error(`Workflow result extensions must be a JSON object <= ${MAX_WORKFLOW_EXTENSION_BYTES} bytes.`);
		extensions = structuredClone(value.extensions) as Record<string, WorkflowJsonValue>;
	}
	return {
		version: 1,
		summary: { text: value.summary.text, covers: strings(value.summary.covers, "summary.covers"), omissions: strings(value.summary.omissions, "summary.omissions"), confidence: value.summary.confidence as WorkflowResult["summary"]["confidence"] },
		outputs,
		diagnostics,
		recommendations: strings(value.recommendations, "recommendations"),
		...(evidence ? { evidence } : {}),
		...(extensions ? { extensions } : {}),
	};
}
