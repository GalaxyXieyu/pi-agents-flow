import { DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES, MAX_WORKFLOW_OUTPUT_FILE_BYTES, jsonBytes } from "./data-contract.ts";
import type { WorkflowArtifactStore } from "./artifact-store.ts";
import type {
	WorkflowArtifactDescriptor,
	WorkflowDataContract,
	WorkflowJsonValue,
	WorkflowNode,
	WorkflowResolvedOutput,
	WorkflowResult,
	WorkflowRun,
} from "./types.ts";

export interface RegisteredWorkflowOutputs {
	resultArtifact: WorkflowArtifactDescriptor;
	outputs: Record<string, WorkflowResolvedOutput>;
	eventResult: WorkflowResult;
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
	outputSlots: Record<string, string>;
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
