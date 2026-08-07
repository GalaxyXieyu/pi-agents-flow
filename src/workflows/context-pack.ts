import * as fs from "node:fs";
import * as path from "node:path";

import { writeAtomicJson } from "../shared/atomic-json.ts";
import { writeAtomicTextFile, type WorkflowArtifactStore } from "./artifact-store.ts";
import {
	DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES,
	DEFAULT_WORKFLOW_CONTEXT_PACK_BYTES,
	DEFAULT_WORKFLOW_CONTEXT_TOKENS,
	jsonBytes,
	selectJsonPointer,
} from "./data-contract.ts";
import { dependencyIsAccepted } from "./effective-nodes.ts";
import type {
	WorkflowArtifactDescriptor,
	WorkflowDataContract,
	WorkflowInputBinding,
	WorkflowJsonValue,
	WorkflowNode,
	WorkflowResolvedOutput,
	WorkflowRun,
} from "./types.ts";

export interface WorkflowContextPackInput {
	binding: string;
	purpose: string;
	sourceNodeId: string;
	effectiveNodeId: string;
	port: string;
	delivery: "manifest" | "inline" | "reference";
	mediaType: string;
	bytes: number;
	sha256?: string;
	artifactId?: string;
	materializedPath?: string;
	inlineValue?: WorkflowJsonValue;
}

export interface WorkflowContextPackManifest {
	version: 1;
	workflowId: string;
	revision: number;
	nodeId: string;
	inputs: WorkflowContextPackInput[];
	omitted: Array<{ binding: string; source: string; reason: string }>;
	budget: {
		maxInlineBytes: number;
		maxPackBytes: number;
		maxEstimatedTokens: number;
		inlineBytes: number;
		packBytes: number;
		estimatedTokens: number;
	};
}

export interface MaterializedWorkflowContextPack {
	dir: string;
	manifestPath: string;
	instructionsPath: string;
	manifest: WorkflowContextPackManifest;
}

interface ResolvedSource {
	sourceNodeId: string;
	effectiveNode: WorkflowNode;
	port: string;
	output: WorkflowResolvedOutput;
	value?: WorkflowJsonValue;
}

function effectiveDependency(run: WorkflowRun, nodeId: string): WorkflowNode | undefined {
	const visited = new Set<string>();
	let node = run.nodes[nodeId];
	while (node?.status === "superseded" && node.supersededBy && !visited.has(node.id)) {
		visited.add(node.id);
		node = run.nodes[node.supersededBy];
	}
	return node;
}

const CLASSIFICATION_RANK = { public: 0, internal: 1, sensitive: 2, secret: 3 } as const;

function assertClearance(output: WorkflowResolvedOutput, clearance: keyof typeof CLASSIFICATION_RANK, binding: string): void {
	const classification = output.kind === "inline" ? output.classification : output.artifact.classification;
	if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[clearance]) {
		throw new Error(`Input binding '${binding}' requires ${classification} clearance; node clearance is ${clearance}.`);
	}
}

function artifactValue(store: WorkflowArtifactStore, descriptor: WorkflowArtifactDescriptor): WorkflowJsonValue {
	if (descriptor.encoding !== "utf-8") throw new Error(`Artifact '${descriptor.artifactId}' cannot be selected as JSON because it is binary.`);
	const text = store.read(descriptor).toString("utf8");
	if (descriptor.mediaType === "application/json") return JSON.parse(text) as WorkflowJsonValue;
	return text;
}

function outputValue(store: WorkflowArtifactStore, output: WorkflowResolvedOutput): WorkflowJsonValue {
	if (output.kind === "inline") return output.value;
	return artifactValue(store, output.artifact);
}

function resolveSources(run: WorkflowRun, node: WorkflowNode, binding: WorkflowInputBinding, store: WorkflowArtifactStore, clearance: keyof typeof CLASSIFICATION_RANK): ResolvedSource[] {
	return binding.from.flatMap((source) => {
		if (!node.dependsOn.includes(source.nodeId)) throw new Error(`Input binding '${binding.name}' references hidden dependency '${source.nodeId}'.`);
		if (!dependencyIsAccepted(run.nodes, source.nodeId)) {
			if (binding.required !== false) throw new Error(`Required input '${binding.name}' depends on unaccepted node '${source.nodeId}'.`);
			return [];
		}
		const effectiveNode = effectiveDependency(run, source.nodeId);
		const output = effectiveNode?.outputs?.[source.port];
		if (!effectiveNode || !output) {
			if (binding.required !== false) throw new Error(`Required input '${binding.name}' cannot resolve port '${source.port}' from '${source.nodeId}'.`);
			return [];
		}
		assertClearance(output, clearance, binding.name);
		const raw = binding.delivery === "summary" ? effectiveNode.result?.summary : source.select === undefined ? undefined : outputValue(store, output);
		const value = raw === undefined ? undefined : source.select === undefined ? raw as WorkflowJsonValue : selectJsonPointer(raw, source.select) as WorkflowJsonValue;
		return [{ sourceNodeId: source.nodeId, effectiveNode, port: source.port, output, ...(value !== undefined ? { value } : {}) }];
	});
}

function mergedValue(binding: WorkflowInputBinding, sources: ResolvedSource[], store: WorkflowArtifactStore): WorkflowJsonValue {
	const values = sources.map((source) => source.value ?? outputValue(store, source.output));
	const merge = binding.merge ?? "first";
	if (merge === "first") return values[0] ?? null;
	if (merge === "list") return values;
	if (merge === "map-by-node") return Object.fromEntries(sources.map((source, index) => [source.effectiveNode.id, values[index] ?? null]));
	if (merge === "concat-text") {
		if (!values.every((value) => typeof value === "string")) throw new Error(`Input binding '${binding.name}' concat-text requires text values.`);
		return values.join("\n\n");
	}
	if (sources.length !== 1) throw new Error(`Input binding '${binding.name}' expected one source, received ${sources.length}.`);
	return values[0] ?? null;
}

function sourceReference(binding: WorkflowInputBinding, source: ResolvedSource): WorkflowContextPackInput {
	if (source.output.kind === "artifact") {
		return {
			binding: binding.name,
			purpose: binding.purpose,
			sourceNodeId: source.sourceNodeId,
			effectiveNodeId: source.effectiveNode.id,
			port: source.port,
			delivery: binding.delivery === "manifest" ? "manifest" : "reference",
			mediaType: source.output.artifact.mediaType,
			bytes: source.output.artifact.bytes,
			sha256: source.output.artifact.sha256,
			artifactId: source.output.artifact.artifactId,
			...(binding.delivery === "manifest" ? {} : { materializedPath: source.output.artifact.storage.materializedPath }),
		};
	}
	return {
		binding: binding.name,
		purpose: binding.purpose,
		sourceNodeId: source.sourceNodeId,
		effectiveNodeId: source.effectiveNode.id,
		port: source.port,
		delivery: "manifest",
		mediaType: source.output.mediaType,
		bytes: source.output.bytes,
	};
}

export function materializeWorkflowContextPack(input: {
	run: WorkflowRun;
	node: WorkflowNode;
	contract: WorkflowDataContract;
	outputDir: string;
	artifactStore: WorkflowArtifactStore;
	taskContext: string;
}): MaterializedWorkflowContextPack {
	const context = input.contract.context ?? {};
	const maxInlineBytes = context.maxInlineBytes ?? DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES;
	const maxPackBytes = context.maxPackBytes ?? DEFAULT_WORKFLOW_CONTEXT_PACK_BYTES;
	const maxEstimatedTokens = context.maxEstimatedTokens ?? DEFAULT_WORKFLOW_CONTEXT_TOKENS;
	const clearance = context.clearance ?? "internal";
	const inputs: WorkflowContextPackInput[] = [];
	const omitted: WorkflowContextPackManifest["omitted"] = [];
	let inlineBytes = 0;
	for (const binding of input.contract.inputs ?? []) {
		const sources = resolveSources(input.run, input.node, binding, input.artifactStore, clearance);
		if (sources.length === 0) {
			omitted.push({ binding: binding.name, source: "none", reason: "optional input was unavailable" });
			continue;
		}
		const requested = binding.delivery ?? "auto";
		const bindingLimit = Math.min(binding.maxInlineBytes ?? maxInlineBytes, maxInlineBytes - inlineBytes);
		if (requested === "inline" || requested === "summary" || requested === "auto") {
			const value = mergedValue(binding, sources, input.artifactStore);
			const bytes = jsonBytes(value);
			if (bytes <= bindingLimit) {
				inputs.push({
					binding: binding.name,
					purpose: binding.purpose,
					sourceNodeId: sources.map((source) => source.sourceNodeId).join(","),
					effectiveNodeId: sources.map((source) => source.effectiveNode.id).join(","),
					port: sources.map((source) => source.port).join(","),
					delivery: "inline",
					mediaType: sources.length === 1 ? sources[0]!.output.mediaType : "application/json",
					bytes,
					inlineValue: value,
				});
				inlineBytes += bytes;
				continue;
			}
			if (requested === "inline" || requested === "summary") throw new Error(`Required inline input '${binding.name}' exceeds its ${bindingLimit}-byte budget.`);
		}
		for (const source of sources) inputs.push(sourceReference(binding, source));
	}

	const dir = path.resolve(input.outputDir);
	fs.mkdirSync(dir, { recursive: true });
	const manifestPath = path.join(dir, "manifest.json");
	const instructionsPath = path.join(dir, "context.md");
	const instructionLines = [
		"# Workflow Context Pack V1",
		"",
		"Only the inputs in manifest.json are authorized for this node. Do not inspect the workflow directory or parent-session history.",
		"",
		"## Task context",
		input.taskContext,
		"",
		"## Inputs",
		...inputs.map((item) => {
			if (item.delivery === "inline") return `- ${item.binding} (${item.purpose}, inline): ${JSON.stringify(item.inlineValue)}`;
			if (item.delivery === "reference") return `- ${item.binding} (${item.purpose}, ${item.mediaType}, ${item.bytes} bytes): ${item.materializedPath}`;
			return `- ${item.binding} (${item.purpose}, manifest only, ${item.mediaType}, ${item.bytes} bytes): ${item.artifactId ?? "inline value omitted"}`;
		}),
	];
	const contextText = instructionLines.join("\n");
	const estimatedTokens = Math.ceil(Buffer.byteLength(contextText, "utf8") / 4);
	const provisional: WorkflowContextPackManifest = {
		version: 1,
		workflowId: input.run.id,
		revision: input.run.revision,
		nodeId: input.node.id,
		inputs,
		omitted,
		budget: { maxInlineBytes, maxPackBytes, maxEstimatedTokens, inlineBytes, packBytes: 0, estimatedTokens },
	};
	const packBytes = Buffer.byteLength(contextText, "utf8") + jsonBytes(provisional);
	if (packBytes > maxPackBytes) throw new Error(`Context pack for '${input.node.id}' exceeds its ${maxPackBytes}-byte budget.`);
	if (estimatedTokens > maxEstimatedTokens) throw new Error(`Context pack for '${input.node.id}' exceeds its ${maxEstimatedTokens}-token estimate budget.`);
	const manifest = { ...provisional, budget: { ...provisional.budget, packBytes } };
	writeAtomicJson(manifestPath, manifest);
	writeAtomicTextFile(instructionsPath, contextText);
	return { dir, manifestPath, instructionsPath, manifest };
}
