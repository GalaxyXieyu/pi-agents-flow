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
	const resultArtifact = input.artifactStore.put({
		workflowId: input.run.id,
		nodeId: input.node.id,
		attemptId: input.attemptId,
		port: "workflow-result",
		mediaType: "application/json",
		classification: "internal",
		content: JSON.stringify(input.result),
	});
	const outputs: Record<string, WorkflowResolvedOutput> = {};
	for (const [name, port] of Object.entries(input.contract.outputs)) {
		const submission = input.result.outputs[name];
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
	return { resultArtifact, outputs, eventResult: boundedEventResult(input.result) };
}

export function hydrateWorkflowResult(descriptor: WorkflowArtifactDescriptor, artifactStore: WorkflowArtifactStore): WorkflowResult {
	return JSON.parse(artifactStore.read(descriptor).toString("utf8")) as WorkflowResult;
}
