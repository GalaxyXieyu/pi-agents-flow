import { terminalAcceptedEditors } from "./effective-nodes.ts";
import { WORKFLOW_PORT_NAME, workflowProfileForKind } from "./plan-rules.ts";
import type {
	WorkflowDataContract,
	WorkflowInputBinding,
	WorkflowJsonValue,
	WorkflowMode,
	WorkflowRun,
	WorkflowWorkUnitPlan,
} from "./types.ts";

export const DEFAULT_WORKFLOW_CONTEXT_INLINE_BYTES = 32 * 1024;
export const DEFAULT_WORKFLOW_CONTEXT_PACK_BYTES = 128 * 1024;
export const DEFAULT_WORKFLOW_CONTEXT_TOKENS = 24_000;
export const MAX_WORKFLOW_SUMMARY_BYTES = 8 * 1024;
export const MAX_WORKFLOW_EXTENSION_BYTES = 4 * 1024;
export const MAX_WORKFLOW_INPUT_SOURCES = 100;
export const MAX_WORKFLOW_OUTPUT_FILE_BYTES = 64 * 1024 * 1024;

const EXTENSION_NAME = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*@\d+$/;

export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertJsonValue(value: unknown, field: string): asserts value is WorkflowJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) assertJsonValue(item, `${field}[${index}]`);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${field}.${key}`);
		return;
	}
	throw new Error(`${field} must contain plain JSON values.`);
}

function assertInputBinding(plan: WorkflowWorkUnitPlan, binding: WorkflowInputBinding, index: number): void {
	const field = `Work unit '${plan.id}' dataContract.inputs[${index}]`;
	if (!WORKFLOW_PORT_NAME.test(binding.name)) throw new Error(`${field}.name '${binding.name}' must match ${WORKFLOW_PORT_NAME.source} (lowercase; use '-' or '_' instead of camelCase).`);
	if (!binding.purpose.trim()) throw new Error(`${field}.purpose must not be blank.`);
	if (binding.delivery !== undefined && binding.delivery !== "auto" && binding.delivery !== "manifest" && binding.delivery !== "summary" && binding.delivery !== "inline" && binding.delivery !== "reference") throw new Error(`${field}.delivery is invalid.`);
	if (binding.merge !== undefined && binding.merge !== "list" && binding.merge !== "map-by-node" && binding.merge !== "concat-text" && binding.merge !== "first" && binding.merge !== "error") throw new Error(`${field}.merge is invalid.`);
	if (binding.from.length === 0 || binding.from.length > MAX_WORKFLOW_INPUT_SOURCES) throw new Error(`${field}.from must contain 1-${MAX_WORKFLOW_INPUT_SOURCES} sources.`);
	if (binding.from.length > 1 && !binding.merge) throw new Error(`${field}.merge is required for fan-in bindings.`);
	if (binding.merge === "first" && binding.from.length !== 1) throw new Error(`${field}.merge 'first' requires exactly one source.`);
	for (const [sourceIndex, source] of binding.from.entries()) {
		if (!plan.dependsOn.includes(source.nodeId)) throw new Error(`${field}.from[${sourceIndex}] references '${source.nodeId}', which is not a direct dependency.`);
		if (!WORKFLOW_PORT_NAME.test(source.port)) throw new Error(`${field}.from[${sourceIndex}].port '${source.port}' must match ${WORKFLOW_PORT_NAME.source} (lowercase; use '-' or '_' instead of camelCase).`);
		if (source.select !== undefined && source.select !== "" && !source.select.startsWith("/")) throw new Error(`${field}.from[${sourceIndex}].select must be a JSON Pointer.`);
	}
	if (binding.maxInlineBytes !== undefined && (!Number.isInteger(binding.maxInlineBytes) || binding.maxInlineBytes < 0)) throw new Error(`${field}.maxInlineBytes must be an integer >= 0.`);
}

export function assertWorkflowDataContract(plan: WorkflowWorkUnitPlan): void {
	const contract = plan.dataContract;
	if (!contract || contract.version !== 1) throw new Error(`Work unit '${plan.id}' must declare WorkflowDataContract.`);
	if (contract.profile !== "generic" && contract.profile !== "research" && contract.profile !== "writer" && contract.profile !== "reviewer") throw new Error(`Work unit '${plan.id}' dataContract.profile is invalid.`);
	const expectedProfile = workflowProfileForKind(plan.kind);
	if (contract.profile !== expectedProfile) throw new Error(`Work unit '${plan.id}' with kind '${plan.kind}' must use dataContract.profile '${expectedProfile}', not '${contract.profile}'.`);
	const inputNames = new Set<string>();
	for (const [index, binding] of contract.inputs.entries()) {
		assertInputBinding(plan, binding, index);
		if (inputNames.has(binding.name)) throw new Error(`Work unit '${plan.id}' has duplicate input binding '${binding.name}'.`);
		inputNames.add(binding.name);
	}
	const outputNames = Object.keys(contract.outputs);
	if (outputNames.length === 0) throw new Error(`Work unit '${plan.id}' dataContract.outputs must not be empty.`);
	for (const [name, port] of Object.entries(contract.outputs)) {
		const field = `Work unit '${plan.id}' dataContract.outputs.${name}`;
		if (!WORKFLOW_PORT_NAME.test(name)) throw new Error(`${field} name must match ${WORKFLOW_PORT_NAME.source} (lowercase; use '-' or '_' instead of camelCase).`);
		if (!port.mediaType.trim()) throw new Error(`${field}.mediaType must not be blank.`);
		if (!port.description.trim()) throw new Error(`${field}.description must not be blank.`);
		if (port.storage !== "auto" && port.storage !== "inline" && port.storage !== "artifact") throw new Error(`${field}.storage is invalid.`);
		if (port.classification !== "public" && port.classification !== "internal" && port.classification !== "sensitive" && port.classification !== "secret") throw new Error(`${field}.classification is invalid.`);
		if (port.maxInlineBytes !== undefined && (!Number.isInteger(port.maxInlineBytes) || port.maxInlineBytes < 0)) throw new Error(`${field}.maxInlineBytes must be an integer >= 0.`);
		if (port.schema !== undefined && (typeof port.schema !== "object" || port.schema === null || Array.isArray(port.schema))) throw new Error(`${field}.schema must be a JSON Schema object.`);
	}
	if (contract.context) {
		for (const [name, value] of Object.entries(contract.context)) {
			if (name === "clearance") {
				if (value !== "public" && value !== "internal" && value !== "sensitive" && value !== "secret") throw new Error(`Work unit '${plan.id}' dataContract.context.clearance is invalid.`);
				continue;
			}
			if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Work unit '${plan.id}' dataContract.context.${name} must be an integer >= 0.`);
		}
	}
	if (contract.annotations) {
		assertJsonValue(contract.annotations, `Work unit '${plan.id}' dataContract.annotations`);
		if (jsonBytes(contract.annotations) > MAX_WORKFLOW_EXTENSION_BYTES) throw new Error(`Work unit '${plan.id}' dataContract.annotations exceeds ${MAX_WORKFLOW_EXTENSION_BYTES} bytes.`);
	}
	if (contract.extensions) {
		for (const [name, value] of Object.entries(contract.extensions)) {
			if (!EXTENSION_NAME.test(name)) throw new Error(`Work unit '${plan.id}' extension '${name}' must use namespace/name@version.`);
			assertJsonValue(value, `Work unit '${plan.id}' dataContract.extensions.${name}`);
		}
		if (jsonBytes(contract.extensions) > MAX_WORKFLOW_EXTENSION_BYTES) throw new Error(`Work unit '${plan.id}' dataContract.extensions exceeds ${MAX_WORKFLOW_EXTENSION_BYTES} bytes.`);
	}
}

export function assertDeepResearchCompletionContracts(mode: WorkflowMode, plans: WorkflowWorkUnitPlan[]): void {
	if (mode !== "deep-research") return;
	for (const plan of plans.filter((candidate) => candidate.kind === "editor")) {
		const document = plan.dataContract.outputs.document;
		if (!document || !document.required || document.storage !== "artifact" || document.mediaType !== "text/markdown") {
			throw new Error(`Deep Research Editor '${plan.id}' must declare required output port 'document' as text/markdown artifact; workflow completion reads that exact port.`);
		}
	}
}

export function assertDeepResearchEditorLineage(run: WorkflowRun, plans: WorkflowWorkUnitPlan[]): void {
	if (run.mode !== "deep-research") return;
	const currentEditors = terminalAcceptedEditors(run);
	if (currentEditors.length === 0) return;
	const combined = new Map([...Object.values(run.nodes), ...plans].map((node) => [node.id, node]));
	const dependsOn = (nodeId: string, targetId: string, visited = new Set<string>()): boolean => {
		if (nodeId === targetId) return true;
		if (visited.has(nodeId)) return false;
		visited.add(nodeId);
		return (combined.get(nodeId)?.dependsOn ?? []).some((dependency) => dependsOn(dependency, targetId, visited));
	};
	for (const plan of plans.filter((candidate) => candidate.kind === "editor")) {
		const missing = currentEditors.filter((editor) => !dependsOn(plan.id, editor.id));
		if (missing.length > 0) {
			throw new Error(`Deep Research repair Editor '${plan.id}' must inherit the current terminal Editor revision(s): ${missing.map((editor) => editor.id).join(", ")}. Parallel final Editor branches cannot be completed safely.`);
		}
	}
}

export function assertWorkflowDataFlow(plans: WorkflowWorkUnitPlan[]): void {
	const byId = new Map(plans.map((plan) => [plan.id, plan]));
	for (const plan of plans) {
		assertWorkflowDataContract(plan);
		for (const binding of plan.dataContract.inputs) {
			for (const source of binding.from) {
				const producer = byId.get(source.nodeId);
				if (!producer) continue;
				const output = producer.dataContract.outputs[source.port];
				if (!output) throw new Error(`Work unit '${plan.id}' input '${binding.name}' references undeclared port '${source.port}' on '${source.nodeId}'.`);
				if (binding.merge === "concat-text" && !output.mediaType.toLowerCase().startsWith("text/")) {
					throw new Error(`Work unit '${plan.id}' input '${binding.name}' uses concat-text but '${source.nodeId}.${source.port}' is ${output.mediaType}, not a text media type.`);
				}
			}
		}
	}
}

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function selectJsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	if (!pointer.startsWith("/")) throw new Error(`Invalid JSON Pointer '${pointer}'.`);
	let current = value;
	for (const rawToken of pointer.slice(1).split("/")) {
		const token = decodePointerToken(rawToken);
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(token)) throw new Error(`JSON Pointer '${pointer}' uses non-numeric array index '${token}'.`);
			current = current[Number(token)];
		} else if (typeof current === "object" && current !== null) current = (current as Record<string, unknown>)[token];
		else current = undefined;
		if (current === undefined) throw new Error(`JSON Pointer '${pointer}' did not resolve.`);
	}
	return current;
}
