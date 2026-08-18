import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES, MAX_WORKFLOW_OUTPUT_FILE_BYTES, jsonBytes } from "./data-contract.ts";
import type { WorkflowArtifactStore } from "./artifact-store.ts";
import type {
	WorkflowArtifactDescriptor,
	WorkflowDataContract,
	WorkflowJsonValue,
	WorkflowNode,
	WorkflowOutputSubmission,
	WorkflowResolvedOutput,
	WorkflowResult,
	WorkflowRun,
} from "./types.ts";

export interface RegisteredWorkflowOutputs {
	resultArtifact: WorkflowArtifactDescriptor;
	outputs: Record<string, WorkflowResolvedOutput>;
	eventResult: WorkflowResult;
}

export type WorkflowOutputRegistrationStage = "missing_submission" | "submission_validation" | "file_capture" | "inline_budget" | "artifact_write" | "unknown";

export interface WorkflowOutputRegistrationDiagnostic {
	nodeId: string;
	port?: string;
	stage: WorkflowOutputRegistrationStage;
	expected?: { mediaType: string; storage: WorkflowDataContract["outputs"][string]["storage"]; required: boolean; maxInlineBytes?: number };
	actual?: { present: boolean; kind?: WorkflowOutputSubmission["kind"]; path?: string; valuePresent?: boolean; reason: string };
	reason: string;
}

function portSnapshot(port: WorkflowDataContract["outputs"][string], submission: WorkflowOutputSubmission | undefined, reason: string): Pick<WorkflowOutputRegistrationDiagnostic, "expected" | "actual"> {
	return {
		expected: {
			mediaType: port.mediaType,
			storage: port.storage,
			required: port.required,
			...(port.maxInlineBytes === undefined ? {} : { maxInlineBytes: port.maxInlineBytes }),
		},
		actual: submission
			? {
				present: true,
				kind: submission.kind,
				...(submission.path === undefined ? {} : { path: submission.path }),
				...(submission.value === undefined ? {} : { valuePresent: true }),
				reason,
			}
			: { present: false, reason },
	};
}

/** Converts a registration failure into a single Supervisor-actionable port diagnostic. */
export function outputRegistrationDiagnostic(node: WorkflowNode, result: WorkflowResult, error: unknown): WorkflowOutputRegistrationDiagnostic {
	const reason = error instanceof Error ? error.message : String(error);
	const missing = reason.match(/^Required output port '([^']+)' is missing\.$/);
	const named = reason.match(/^Output port '([^']+)'/);
	const portName = missing?.[1] ?? named?.[1];
	const port = portName ? node.dataContract.outputs[portName] : undefined;
	const submission = portName ? result.outputs[portName] : undefined;
	const stage: WorkflowOutputRegistrationStage = missing ? "missing_submission"
		: /exceeds its \d+-byte inline budget/.test(reason) ? "inline_budget"
		: /file path is missing|requires an inline value/.test(reason) ? "submission_validation"
		: /capture|slot|submission|path|sha256|file/i.test(reason) ? "file_capture"
		: /artifact|write|put/i.test(reason) ? "artifact_write"
		: "unknown";
	return {
		nodeId: node.id,
		...(portName ? { port: portName } : {}),
		stage,
		...(port ? portSnapshot(port, submission, reason) : {}),
		reason,
	};
}

function serialized(value: WorkflowJsonValue, mediaType: string): { content: string; bytes: number } {
	const content = typeof value === "string" && mediaType !== "application/json" ? value : JSON.stringify(value);
	return { content, bytes: Buffer.byteLength(content, "utf8") };
}

function boundedEventResult(result: WorkflowResult): WorkflowResult {
	return {
		version: 1,
		summary: structuredClone(result.summary),
		outputs: {},
		diagnostics: structuredClone(result.diagnostics),
		recommendations: result.recommendations.slice(0, 20),
		...(result.evidence ? { evidence: { findings: [], ...(result.evidence.search ? { search: structuredClone(result.evidence.search) } : {}) } } : {}),
		// The verdict is gate control data; retain it alongside the bounded release declaration.
		...(result.review ? { review: structuredClone(result.review) } : {}),
		// Extensions are bounded by WorkflowResult validation and may contain release
		// decisions used by evaluation. Dropping them makes event/manifest gates disagree
		// with hydrated quality checks until the store is reloaded.
		...(result.extensions ? { extensions: structuredClone(result.extensions) } : {}),
	};
}

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function resolveExistingFile(candidates: Array<string | undefined>): string | undefined {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const resolved = path.resolve(candidate);
		if (fileExists(resolved)) return resolved;
	}
	return undefined;
}

function textFromJsonLike(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["text", "markdown", "document", "content", "body"]) {
		if (typeof record[key] === "string" && record[key].trim()) return record[key];
	}
	return undefined;
}

/**
 * Repair common file-port mistakes before registration:
 * 1. kind:file pointing at a missing slot, while the content already lives in
 *    summary.text / another text field — convert to an inline value.
 * 2. kind:file pointing at a missing slot, while the file actually exists in
 *    the trusted submission directory or at the preallocated slot.
 * Missing files that cannot be repaired stay as-is so callers can format-steer.
 */
export function repairWorkflowOutputSubmissions(input: {
	result: WorkflowResult;
	contract: WorkflowDataContract;
	outputSlots?: Record<string, string>;
	trustedSubmissionDir?: string;
}): { result: WorkflowResult; repairs: string[] } {
	const repairs: string[] = [];
	const outputs: WorkflowResult["outputs"] = { ...input.result.outputs };
	for (const [name, port] of Object.entries(input.contract.outputs)) {
		const submission = outputs[name];
		if (!submission || submission.kind !== "file" || !submission.path) continue;
		const reported = path.resolve(submission.path);
		if (fileExists(reported)) {
			if (reported !== submission.path) {
				outputs[name] = { ...submission, path: reported };
				repairs.push(`normalized outputs.${name}.path to an existing file`);
			}
			continue;
		}
		const slot = input.outputSlots?.[name];
		const basename = path.basename(reported);
		const recovered = resolveExistingFile([
			slot,
			input.trustedSubmissionDir ? path.join(input.trustedSubmissionDir, basename) : undefined,
			input.trustedSubmissionDir ? path.join(input.trustedSubmissionDir, name) : undefined,
		]);
		if (recovered) {
			outputs[name] = { kind: "file", path: recovered, ...(submission.sha256 ? { sha256: submission.sha256 } : {}) };
			repairs.push(`rewrote outputs.${name}.path to existing file '${recovered}'`);
			continue;
		}
		const inlineText = textFromJsonLike(input.result.summary.text)
			?? (port.mediaType.toLowerCase().startsWith("text/") ? textFromJsonLike(input.result.summary) : undefined);
		// Only salvage from summary when it already looks like the document, not a
		// 200-character abstract. Short summaries stay missing so format-steer can ask
		// the child to write the slot or submit an inline value.
		if (inlineText && inlineText.length >= 800 && port.mediaType.toLowerCase().startsWith("text/")) {
			outputs[name] = { kind: "value", value: inlineText };
			repairs.push(`converted missing outputs.${name} file path to inline value from a long summary.text`);
		}
	}
	if (repairs.length === 0) return { result: input.result, repairs };
	return { result: { ...input.result, outputs }, repairs };
}

export function assertWorkflowOutputFilesExist(input: {
	result: WorkflowResult;
	contract: WorkflowDataContract;
	outputSlots?: Record<string, string>;
	trustedSubmissionDir?: string;
}): void {
	for (const [name, port] of Object.entries(input.contract.outputs)) {
		const submission = input.result.outputs[name];
		if (!submission || submission.kind !== "file") continue;
		if (!submission.path) throw new Error(`Output port '${name}' file path is missing.`);
		const reported = path.resolve(submission.path);
		if (fileExists(reported)) continue;
		const slot = input.outputSlots?.[name];
		throw new Error(
			`Output port '${name}' reports kind:file at '${submission.path}', but that file does not exist.`
			+ (slot ? ` Write the content to the preallocated slot '${slot}' first, then report that exact path.` : "")
			+ ` Small results must stay inline as {kind:'value', value:'...'}. Never report a slot path you did not write, and never use a slot as the outer structured_output.path.`
			+ (port.storage === "inline" ? ` This port requires an inline value.` : ""),
		);
	}
}

export function allocateWorkflowOutputSlots(input: {
	run: WorkflowRun;
	node: WorkflowNode;
	attemptId: string;
	contract: WorkflowDataContract;
	artifactStore: WorkflowArtifactStore;
}): Record<string, string> {
	return Object.fromEntries(Object.entries(input.contract.outputs)
		.filter(([, port]) => port.storage !== "inline")
		.map(([name]) => [name, input.artifactStore.allocateOutputSlot({ workflowId: input.run.id, nodeId: input.node.id, attemptId: input.attemptId, port: name })]));
}

export function registerWorkflowOutputs(input: {
	run: WorkflowRun;
	node: WorkflowNode;
	attemptId: string;
	result: WorkflowResult;
	contract: WorkflowDataContract;
	artifactStore: WorkflowArtifactStore;
	outputSlots?: Record<string, string>;
	/** Harness-managed submission directory accepted for file submissions that missed their slot. */
	trustedSubmissionDir?: string;
}): RegisteredWorkflowOutputs {
	const repaired = repairWorkflowOutputSubmissions({
		result: input.result,
		contract: input.contract,
		...(input.outputSlots ? { outputSlots: input.outputSlots } : {}),
		...(input.trustedSubmissionDir ? { trustedSubmissionDir: input.trustedSubmissionDir } : {}),
	});
	const result = repaired.result;
	const resultArtifact = input.artifactStore.put({
		workflowId: input.run.id,
		nodeId: input.node.id,
		attemptId: input.attemptId,
		port: "workflow-result",
		mediaType: "application/json",
		classification: "internal",
		content: JSON.stringify(result),
	});
	const outputs: Record<string, WorkflowResolvedOutput> = {};
	for (const [name, port] of Object.entries(input.contract.outputs)) {
		const submission = result.outputs[name];
		if (!submission) {
			if (port.required) throw new Error(`Required output port '${name}' is missing.`);
			continue;
		}
		if (submission.kind === "file") {
			if (port.storage === "inline") throw new Error(`Output port '${name}' requires an inline value.`);
			if (!submission.path) throw new Error(`Output port '${name}' file path is missing.`);
			outputs[name] = {
				kind: "artifact",
				artifact: input.artifactStore.captureOutputSlot({
					workflowId: input.run.id,
					nodeId: input.node.id,
					attemptId: input.attemptId,
					port: name,
					mediaType: port.mediaType,
					classification: port.classification,
					slotPath: submission.path,
					...(submission.sha256 ? { expectedSha256: submission.sha256 } : {}),
					maxBytes: MAX_WORKFLOW_OUTPUT_FILE_BYTES,
					...(input.trustedSubmissionDir ? { fallbackDirs: [input.trustedSubmissionDir] } : {}),
				}),
			};
			continue;
		}
		if (submission.value === undefined) throw new Error(`Output port '${name}' value is missing.`);
		const value = structuredClone(submission.value);
		const encoded = serialized(value, port.mediaType);
		const maxInlineBytes = port.maxInlineBytes ?? DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES;
		if (port.storage === "inline" && encoded.bytes > maxInlineBytes) throw new Error(`Output port '${name}' exceeds its ${maxInlineBytes}-byte inline budget.`);
		if (port.storage === "inline" || (port.storage === "auto" && encoded.bytes <= maxInlineBytes)) {
			outputs[name] = { kind: "inline", mediaType: port.mediaType, bytes: jsonBytes(value), classification: port.classification, value };
			continue;
		}
		outputs[name] = {
			kind: "artifact",
			artifact: input.artifactStore.put({ workflowId: input.run.id, nodeId: input.node.id, attemptId: input.attemptId, port: name, mediaType: port.mediaType, classification: port.classification, content: encoded.content }),
		};
	}
	return { resultArtifact, outputs, eventResult: boundedEventResult(result) };
}

export function hydrateWorkflowResult(descriptor: WorkflowArtifactDescriptor, artifactStore: WorkflowArtifactStore): WorkflowResult {
	return JSON.parse(artifactStore.read(descriptor).toString("utf8")) as WorkflowResult;
}
