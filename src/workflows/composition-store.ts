/**
 * Composition templates: reusable, declarative node plans.
 *
 * A composition contains human-level tasks plus schedulable work units with
 * `{{param}}` placeholders and optional per-work-unit `enableIf` conditions. The Supervisor decides the shape of a
 * workflow once, the user reviews and edits it, and later runs reuse it with new
 * parameters instead of asking a model to re-derive the same graph.
 *
 * ## Render-time only
 *
 * Every placeholder substitution and every `enableIf` evaluation happens here,
 * before the plan reaches the workflow Controller. Disabled nodes are removed
 * from the array, so the execution layer never sees `enableIf` and the DAG is
 * fully determined before the first node starts. Anything that can only be
 * decided from a running node's result belongs in a script-driven workflow, not
 * in a composition template.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { writeAtomicJson } from "../shared/atomic-json.ts";
import { evaluateCompositionExpr, type CompositionParamValue } from "./composition-expr.ts";
import type { WorkflowDataContract, WorkflowNodeKind } from "./types.ts";

const COMPOSITION_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_COMPOSITION_BYTES = 512 * 1024;

export interface CompositionParamDecl {
	name: string;
	required: boolean;
	description?: string;
	default?: CompositionParamValue;
}

/**
 * A node plan whose `agentSpec` is still unvalidated.
 *
 * Templates deliberately do not re-validate agent specs: the workflow tool's own
 * `parseWorkflowActionParams` is the single source of truth, and it runs after
 * rendering. Templates only guarantee the graph-level shape.
 */
export interface CompositionTaskTemplate {
	id: string;
	label: string;
	parentId?: string;
	order: number;
}

export interface CompositionWorkUnitTemplate {
	id: string;
	taskId: string;
	kind: WorkflowNodeKind;
	label: string;
	order: number;
	dependsOn: string[];
	agentSpec: Record<string, unknown>;
	dataContract?: Record<string, unknown>;
	/** Render-time condition that decides inclusion. */
	enableIf?: string;
}

export interface CompositionTemplate {
	name: string;
	description?: string;
	params: CompositionParamDecl[];
	tasks: CompositionTaskTemplate[];
	workUnits: CompositionWorkUnitTemplate[];
}

export interface RenderedCompositionWorkUnit {
	id: string;
	taskId: string;
	kind: WorkflowNodeKind;
	label: string;
	order: number;
	dependsOn: string[];
	agentSpec: Record<string, unknown>;
	dataContract: Record<string, unknown>;
}

export interface RenderedComposition {
	tasks: CompositionTaskTemplate[];
	workUnits: RenderedCompositionWorkUnit[];
	/** Work-unit ids removed because their `enableIf` evaluated to false. */
	skipped: Array<{ id: string; enableIf: string }>;
}

export function compositionsDir(cwd: string): string {
	return path.join(cwd, ".pi-agents-flow", "compositions");
}

function assertCompositionName(name: string): void {
	if (!COMPOSITION_NAME_PATTERN.test(name)) {
		throw new Error("Composition name must contain only letters, numbers, dots, underscores, and hyphens.");
	}
}

export function compositionPath(cwd: string, name: string): string {
	assertCompositionName(name);
	return path.join(compositionsDir(cwd), `${name}.json`);
}

export function listCompositions(cwd: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(compositionsDir(cwd));
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.filter((name) => COMPOSITION_NAME_PATTERN.test(name))
		.sort((a, b) => a.localeCompare(b));
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
	return value;
}

function parseParamValue(value: unknown, field: string): CompositionParamValue {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	throw new Error(`${field} must be a string, number, or boolean.`);
}

function parseParams(value: unknown): CompositionParamDecl[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("params must be an array.");
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (!record(entry)) throw new Error(`params[${index}] must be an object.`);
		const name = requiredString(entry.name, `params[${index}].name`);
		if (seen.has(name)) throw new Error(`Duplicate composition param '${name}'.`);
		seen.add(name);
		if (entry.required !== undefined && typeof entry.required !== "boolean") {
			throw new Error(`params[${index}].required must be a boolean.`);
		}
		const description = entry.description === undefined ? undefined : requiredString(entry.description, `params[${index}].description`);
		return {
			name,
			required: entry.required !== false,
			...(description ? { description } : {}),
			...(entry.default !== undefined ? { default: parseParamValue(entry.default, `params[${index}].default`) } : {}),
		};
	});
}

const NODE_KINDS = new Set<WorkflowNodeKind>(["research", "verification", "outline", "section-writer", "writer", "editor", "reviewer", "custom"]);

function defaultProfile(kind: WorkflowNodeKind): WorkflowDataContract["profile"] {
	if (kind === "research" || kind === "verification") return "research";
	if (kind === "section-writer" || kind === "writer" || kind === "editor") return "writer";
	if (kind === "reviewer") return "reviewer";
	return "generic";
}

function defaultOutputName(kind: WorkflowNodeKind): string {
	const profile = defaultProfile(kind);
	return profile === "writer" ? "document" : profile === "reviewer" ? "review" : "result";
}

function declaredOutputName(workUnit: CompositionWorkUnitTemplate): string {
	const fallback = defaultOutputName(workUnit.kind);
	const outputs = workUnit.dataContract?.outputs;
	if (!record(outputs)) return fallback;
	if (record(outputs[fallback])) return fallback;
	const names = Object.keys(outputs);
	if (names.length === 1) return names[0]!;
	throw new Error(`Composition work unit '${workUnit.id}' declares multiple outputs without the standard '${fallback}' port; dependent default contracts cannot choose one safely.`);
}

function pruneExplicitDataContract(
	dataContract: Record<string, unknown>,
	dependsOn: string[],
): Record<string, unknown> {
	const inputs = dataContract.inputs;
	if (!Array.isArray(inputs)) return dataContract;
	const keptDependencies = new Set(dependsOn);
	return {
		...dataContract,
		inputs: inputs.flatMap((binding) => {
			if (!record(binding) || !Array.isArray(binding.from)) return [binding];
			const from = binding.from.filter((source) => record(source) && typeof source.nodeId === "string" && keptDependencies.has(source.nodeId));
			if (from.length === 0) return [];
			return [{ ...binding, from, ...(from.length === 1 && binding.merge !== undefined ? { merge: "first" } : {}) }];
		}),
	};
}

function defaultDataContract(kind: WorkflowNodeKind, dependencies: CompositionWorkUnitTemplate[]): WorkflowDataContract {
	const profile = defaultProfile(kind);
	const outputName = defaultOutputName(kind);
	return {
		version: 1,
		profile,
		inputs: dependencies.length === 0
			? []
			: [{
				name: "dependencies",
				from: dependencies.map((dependency) => ({ nodeId: dependency.id, port: declaredOutputName(dependency) })),
				purpose: "Accepted direct dependency outputs",
				delivery: "manifest",
				merge: dependencies.length === 1 ? "first" : "list",
				required: true,
			}],
		outputs: {
			[outputName]: {
				mediaType: "text/markdown",
				description: "Composition work-unit output",
				storage: "artifact",
				required: true,
				classification: "internal",
			},
		},
	};
}

function parseTaskTemplate(value: unknown, index: number): CompositionTaskTemplate {
	if (!record(value)) throw new Error(`tasks[${index}] must be an object.`);
	const id = requiredString(value.id, `tasks[${index}].id`);
	if (!Number.isInteger(value.order) || (value.order as number) < 0) throw new Error(`Task '${id}' order must be an integer >= 0.`);
	const parentId = value.parentId === undefined ? undefined : requiredString(value.parentId, `Task '${id}' parentId`);
	return { id, label: requiredString(value.label, `Task '${id}' label`), ...(parentId ? { parentId } : {}), order: value.order as number };
}

function parseWorkUnitTemplate(value: unknown, index: number): CompositionWorkUnitTemplate {
	if (!record(value)) throw new Error(`workUnits[${index}] must be an object.`);
	const id = requiredString(value.id, `workUnits[${index}].id`);
	if (!NODE_KINDS.has(value.kind as WorkflowNodeKind)) throw new Error(`Work unit '${id}' kind is invalid.`);
	if (!Array.isArray(value.dependsOn) || !value.dependsOn.every((entry) => typeof entry === "string" && entry.trim())) {
		throw new Error(`Work unit '${id}' dependsOn must be a string array.`);
	}
	if (!Number.isInteger(value.order) || (value.order as number) < 0) throw new Error(`Work unit '${id}' order must be an integer >= 0.`);
	if (!record(value.agentSpec)) throw new Error(`Work unit '${id}' agentSpec must be an object.`);
	if (value.dataContract !== undefined && !record(value.dataContract)) throw new Error(`Work unit '${id}' dataContract must be an object.`);
	const enableIf = value.enableIf === undefined ? undefined : requiredString(value.enableIf, `Work unit '${id}' enableIf`);
	return {
		id,
		taskId: requiredString(value.taskId, `Work unit '${id}' taskId`),
		kind: value.kind as WorkflowNodeKind,
		label: requiredString(value.label, `Work unit '${id}' label`),
		order: value.order as number,
		dependsOn: [...value.dependsOn] as string[],
		agentSpec: value.agentSpec,
		...(record(value.dataContract) ? { dataContract: value.dataContract } : {}),
		...(enableIf ? { enableIf } : {}),
	};
}

export function parseCompositionTemplate(value: unknown, fallbackName?: string): CompositionTemplate {
	if (!record(value)) throw new Error("Composition template must be an object.");
	const name = value.name === undefined && fallbackName !== undefined
		? fallbackName
		: requiredString(value.name, "name");
	assertCompositionName(name);
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("Composition tasks must be a non-empty array.");
	if (!Array.isArray(value.workUnits) || value.workUnits.length === 0) throw new Error("Composition workUnits must be a non-empty array.");
	const tasks = value.tasks.map((entry, index) => parseTaskTemplate(entry, index));
	const workUnits = value.workUnits.map((entry, index) => parseWorkUnitTemplate(entry, index));
	const taskIds = new Set<string>();
	for (const task of tasks) {
		if (taskIds.has(task.id)) throw new Error(`Duplicate composition task '${task.id}'.`);
		taskIds.add(task.id);
	}
	for (const task of tasks) if (task.parentId && !taskIds.has(task.parentId)) throw new Error(`Task '${task.id}' references unknown parent '${task.parentId}'.`);
	const workUnitIds = new Set<string>();
	for (const workUnit of workUnits) {
		if (workUnitIds.has(workUnit.id)) throw new Error(`Duplicate composition work unit '${workUnit.id}'.`);
		if (!taskIds.has(workUnit.taskId)) throw new Error(`Work unit '${workUnit.id}' references unknown task '${workUnit.taskId}'.`);
		workUnitIds.add(workUnit.id);
	}
	const description = value.description === undefined ? undefined : requiredString(value.description, "description");
	return {
		name,
		...(description ? { description } : {}),
		params: parseParams(value.params),
		tasks,
		workUnits,
	};
}

export function loadComposition(cwd: string, name: string): CompositionTemplate {
	const filePath = compositionPath(cwd, name);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		throw new Error(`Composition '${name}' not found at ${filePath}.`);
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_COMPOSITION_BYTES) {
		throw new Error(`Composition '${name}' exceeds ${MAX_COMPOSITION_BYTES} bytes.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Composition '${name}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseCompositionTemplate(parsed, name);
}

/**
 * Write a template, replacing any existing file with the same name.
 *
 * Versioning is intentionally left to the user's VCS: these files are meant to be
 * committed and diffed, so a parallel history directory would duplicate that.
 */
export function saveComposition(cwd: string, template: CompositionTemplate): string {
	const filePath = compositionPath(cwd, template.name);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	writeAtomicJson(filePath, template);
	return filePath;
}

/** Parse `--param key=value` style pairs. Values stay strings unless clearly numeric or boolean. */
export function parseCompositionParamArgs(args: string[]): Record<string, CompositionParamValue> {
	const values: Record<string, CompositionParamValue> = {};
	for (const arg of args) {
		const separator = arg.indexOf("=");
		if (separator <= 0) throw new Error(`Invalid --param '${arg}'; expected name=value.`);
		const name = arg.slice(0, separator).trim();
		const raw = arg.slice(separator + 1);
		if (!name) throw new Error(`Invalid --param '${arg}'; expected name=value.`);
		if (raw === "true" || raw === "false") {
			values[name] = raw === "true";
			continue;
		}
		if (raw !== "" && Number.isFinite(Number(raw))) {
			values[name] = Number(raw);
			continue;
		}
		values[name] = raw;
	}
	return values;
}

export function resolveCompositionParams(
	template: CompositionTemplate,
	supplied: Readonly<Record<string, CompositionParamValue>>,
): Record<string, CompositionParamValue> {
	const declared = new Set(template.params.map((param) => param.name));
	for (const name of Object.keys(supplied)) {
		if (!declared.has(name)) throw new Error(`Composition '${template.name}' does not declare param '${name}'.`);
	}
	const resolved: Record<string, CompositionParamValue> = {};
	const missing: string[] = [];
	for (const param of template.params) {
		if (Object.hasOwn(supplied, param.name)) {
			resolved[param.name] = supplied[param.name]!;
			continue;
		}
		if (param.default !== undefined) {
			resolved[param.name] = param.default;
			continue;
		}
		if (param.required) missing.push(param.name);
	}
	if (missing.length > 0) {
		throw new Error(`Composition '${template.name}' is missing required param${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
	}
	return resolved;
}

function substitute(text: string, params: Readonly<Record<string, CompositionParamValue>>, where: string): string {
	return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
		if (!Object.hasOwn(params, key)) throw new Error(`${where} references undeclared param '${key}'.`);
		return String(params[key]);
	});
}

function substituteDeep(value: unknown, params: Readonly<Record<string, CompositionParamValue>>, where: string): unknown {
	if (typeof value === "string") return substitute(value, params, where);
	if (Array.isArray(value)) return value.map((entry, index) => substituteDeep(entry, params, `${where}[${index}]`));
	if (record(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteDeep(entry, params, `${where}.${key}`)]));
	}
	return value;
}

/**
 * Render a template into tasks and work units ready for `apply_plan`.
 *
 * Work units whose `enableIf` is false are dropped. Remaining work units lose any
 * dependency on a dropped work unit, because a pruned unit can never be accepted and
 * would otherwise deadlock the graph.
 */
export function renderComposition(
	template: CompositionTemplate,
	supplied: Readonly<Record<string, CompositionParamValue>>,
): RenderedComposition {
	const params = resolveCompositionParams(template, supplied);
	const skipped: RenderedComposition["skipped"] = [];
	const kept: CompositionWorkUnitTemplate[] = [];
	for (const workUnit of template.workUnits) {
		if (workUnit.enableIf === undefined) {
			kept.push(workUnit);
			continue;
		}
		const evaluated = evaluateCompositionExpr(workUnit.enableIf, params);
		if (!evaluated.ok) {
			throw new Error(`Composition '${template.name}' work unit '${workUnit.id}' enableIf failed: ${evaluated.error}`);
		}
		if (evaluated.value === true) kept.push(workUnit);
		else skipped.push({ id: workUnit.id, enableIf: workUnit.enableIf });
	}
	const keptById = new Map(kept.map((workUnit) => [workUnit.id, workUnit]));
	const keptIds = new Set(keptById.keys());
	const workUnits = kept.map((workUnit): RenderedCompositionWorkUnit => {
		const dependsOn = workUnit.dependsOn.filter((dependency) => keptIds.has(dependency));
		return {
			id: workUnit.id,
			taskId: workUnit.taskId,
			kind: workUnit.kind,
			label: substitute(workUnit.label, params, `Work unit '${workUnit.id}' label`),
			order: workUnit.order,
			dependsOn,
			agentSpec: substituteDeep(workUnit.agentSpec, params, `Work unit '${workUnit.id}' agentSpec`) as Record<string, unknown>,
			dataContract: workUnit.dataContract
				? pruneExplicitDataContract(
					substituteDeep(workUnit.dataContract, params, `Work unit '${workUnit.id}' dataContract`) as Record<string, unknown>,
					dependsOn,
				)
				: defaultDataContract(workUnit.kind, dependsOn.map((dependency) => keptById.get(dependency)!)),
		};
	});
	for (const workUnit of workUnits) {
		for (const dependency of workUnit.dependsOn) {
			if (!keptIds.has(dependency)) throw new Error(`Work unit '${workUnit.id}' depends on unknown work unit '${dependency}'.`);
		}
	}
	return { tasks: template.tasks.map((task) => ({ ...task })), workUnits, skipped };
}

export function formatCompositionSummary(template: CompositionTemplate): string {
	const lines = [
		`${template.name}${template.description ? ` - ${template.description}` : ""}`,
		`Params (${template.params.length})`,
		...template.params.map((param) => {
			const parts = [param.required ? "required" : "optional"];
			if (param.default !== undefined) parts.push(`default=${String(param.default)}`);
			return `- ${param.name} [${parts.join(" ")}]${param.description ? ` - ${param.description}` : ""}`;
		}),
		`Tasks (${template.tasks.length})`,
		...template.tasks.map((task) => `- ${task.id}${task.parentId ? ` under ${task.parentId}` : ""}`),
		`Work units (${template.workUnits.length})`,
		...template.workUnits.map((workUnit) => {
			const dependencies = workUnit.dependsOn.length > 0 ? ` after ${workUnit.dependsOn.join(",")}` : "";
			const condition = workUnit.enableIf ? ` if ${workUnit.enableIf}` : "";
			return `- ${workUnit.id} (${workUnit.kind}) in ${workUnit.taskId}${dependencies}${condition}`;
		}),
	];
	if (template.params.length === 0) lines.splice(2, 0, "- (none)");
	return lines.join("\n");
}
