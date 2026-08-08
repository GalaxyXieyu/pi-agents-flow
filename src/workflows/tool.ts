import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyText, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import { compactText } from "../shared/formatters.ts";
import type { ActivitySnapshot } from "../activity/types.ts";
import { noticePrefix } from "../tui/visual-language.ts";
import { renderWorkflowInlineCard, type WorkflowInlineCardInput } from "../tui/workflow-inline-card.ts";
import { Container } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { buildAssetCatalog, formatAssetCatalog, type AssetCatalog } from "./asset-catalog.ts";
import type {
	WorkflowActionParams,
	WorkflowController,
	WorkflowControllerDetails,
} from "./controller.ts";
import { assertWorkflowDataContract } from "./data-contract.ts";
import { WORKFLOW_PORT_NAME_PATTERN, workflowProfileForKind } from "./plan-rules.ts";
import { resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { MAX_WORKFLOW_MAX_NODE_ATTEMPTS, MAX_WORKFLOW_MAX_NODES } from "./retry-policy.ts";
import type { DocumentOutline, EphemeralAgentSpec, ResearchBrief, WorkflowClarificationOption, WorkflowClarificationQuestion, WorkflowDataContract, WorkflowNodeKind, WorkflowTaskPlan, WorkflowWorkUnitPlan } from "./types.ts";

const MAX_NODE_TOOL_ENTRIES = 64;

const ClarificationOptionParams = Type.Union([
	Type.String(),
	Type.Object({
		label: Type.String(),
		description: Type.Optional(Type.String()),
	}, { additionalProperties: false }),
]);

const ClarificationQuestionParams = Type.Object({
	id: Type.String(),
	prompt: Type.String(),
	options: Type.Array(ClarificationOptionParams, { minItems: 2, maxItems: 6 }),
	multiple: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const ResearchBriefParams = Type.Object({
	version: Type.Literal(0),
	audience: Type.String(),
	purpose: Type.String(),
	scope: Type.String(),
	depth: Type.String({ enum: ["overview", "standard", "deep", "expert"] }),
	deliverable: Type.String({ enum: ["research-report", "technical-whitepaper", "decision-memo"] }),
	targetWords: Type.Object({ min: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
	requiredTopics: Type.Array(Type.String()),
	excludedTopics: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	assumptions: Type.Array(Type.String()),
	clarification: Type.String({ enum: ["confirmed", "inferred"] }),
}, { additionalProperties: false });

const DocumentOutlineParams = Type.Object({
	version: Type.Literal(0),
	title: Type.String(),
	thesis: Type.String(),
	approval: Type.String({ enum: ["user", "supervisor"], description: "Use user to open the inline approval/revision form. Use supervisor only when the user explicitly requested immediate execution without outline review." }),
	sections: Type.Array(Type.Object({
		id: Type.String(),
		title: Type.String(),
		objective: Type.String(),
		questions: Type.Array(Type.String()),
		evidenceRequirements: Type.Array(Type.String()),
		targetWords: Type.Integer({ minimum: 100 }),
		writerNodeId: Type.String(),
	}, { additionalProperties: false }), { minItems: 2 }),
}, { additionalProperties: false });

const WorkflowAgentSpecParams = Type.Object({
	id: Type.String({ description: "Stable node-local AgentSpec id." }),
	baseAgent: Type.String({ description: "Existing persistent base Agent that owns the tool, extension, and MCP allowlists." }),
	role: Type.String({ description: "Task-specific role for this ephemeral child." }),
	objective: Type.String({ description: "One bounded outcome this child must produce." }),
	instructions: Type.String({ description: "Execution constraints, evidence policy, and expected result details." }),
	context: Type.String({ enum: ["fresh", "fork"], description: "Child context mode." }),
	model: Type.Optional(Type.String({ description: "Optional Pi model id, for example provider/model." })),
	thinking: Type.Optional(Type.String({ enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] })),
	skills: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Skills resolved by normal pi-agents-flow preflight." })),
	extraTools: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_NODE_TOOL_ENTRIES, description: "Tools granted to this node on top of the base Agent allowlist. Entries with '/' are MCP selectors (server or server/tool); others are builtin tool names. Extension paths are rejected and the capability ceiling still applies. Requires a base Agent that declares an explicit tools allowlist." })),
	denyTools: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_NODE_TOOL_ENTRIES, description: "Tools revoked for this node even though the base Agent declares them. Requires a base Agent that declares an explicit tools allowlist." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	turnBudget: Type.Optional(Type.Object({
		maxTurns: Type.Integer({ minimum: 1 }),
		graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false })),
	toolBudget: Type.Optional(Type.Object({
		soft: Type.Optional(Type.Integer({ minimum: 0 })),
		hard: Type.Integer({ minimum: 0 }),
		block: Type.Optional(Type.Unsafe({
			oneOf: [
				{ type: "array", items: { type: "string" } },
				{ type: "string", enum: ["*"] },
			],
		})),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

const WorkflowDataContractParams = Type.Unsafe<WorkflowDataContract>({
	type: "object",
	additionalProperties: false,
	required: ["version", "profile", "inputs", "outputs"],
	properties: {
		version: { const: 1 },
		profile: { type: "string", enum: ["generic", "research", "writer", "reviewer"] },
		inputs: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "from", "purpose"],
				properties: {
					name: { type: "string", pattern: WORKFLOW_PORT_NAME_PATTERN, description: "Lowercase binding name; use '-' or '_' instead of camelCase, e.g. architecture-map." },
					from: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["nodeId", "port"],
							properties: {
								nodeId: { type: "string" },
								port: { type: "string", pattern: WORKFLOW_PORT_NAME_PATTERN, description: "Lowercase producer output port, e.g. result or architecture-map." },
								select: { type: "string" },
							},
						},
					},
					purpose: { type: "string" },
					delivery: { type: "string", enum: ["auto", "manifest", "summary", "inline", "reference"] },
					merge: { type: "string", enum: ["list", "map-by-node", "concat-text", "first", "error"] },
					required: { type: "boolean" },
					maxInlineBytes: { type: "integer", minimum: 0 },
				},
			},
		},
		outputs: {
			type: "object",
			propertyNames: { pattern: WORKFLOW_PORT_NAME_PATTERN, description: "Lowercase output port; use '-' or '_' instead of camelCase." },
			minProperties: 1,
			additionalProperties: {
				type: "object",
				additionalProperties: false,
				required: ["mediaType", "description", "storage", "required", "classification"],
				properties: {
					mediaType: { type: "string" },
					description: { type: "string" },
					storage: { type: "string", enum: ["auto", "inline", "artifact"] },
					required: { type: "boolean" },
					maxInlineBytes: { type: "integer", minimum: 0 },
					classification: { type: "string", enum: ["public", "internal", "sensitive", "secret"] },
					schema: { type: "object" },
				},
			},
		},
		context: {
			type: "object",
			additionalProperties: false,
			properties: {
				maxInlineBytes: { type: "integer", minimum: 0 },
				maxPackBytes: { type: "integer", minimum: 0 },
				maxEstimatedTokens: { type: "integer", minimum: 0 },
				clearance: { type: "string", enum: ["public", "internal", "sensitive", "secret"] },
			},
		},
		annotations: { type: "object" },
		extensions: { type: "object" },
	},
});

const WorkflowTaskPlanParams = Type.Object({
	id: Type.String({ description: "Stable human-level task id." }),
	label: Type.String({ description: "Short user-visible task label." }),
	parentId: Type.Optional(Type.String({ description: "Optional parent task id for nested task structure." })),
	order: Type.Integer({ minimum: 0, description: "Stable display order among sibling tasks." }),
}, { additionalProperties: false });

const WorkflowWorkUnitPlanParams = Type.Object({
	id: Type.String({ description: "Stable schedulable work-unit id used by dependencies and decisions." }),
	taskId: Type.String({ description: "Human-level task that owns this work unit." }),
	kind: Type.String({ enum: ["research", "verification", "outline", "section-writer", "writer", "editor", "reviewer", "custom"] }),
	label: Type.String({ description: "Short user-visible work-unit label." }),
	order: Type.Integer({ minimum: 0, description: "Stable display order inside the owning task." }),
	dependsOn: Type.Array(Type.String(), { description: "Work-unit ids that must be accepted before this work unit becomes ready." }),
	agentSpec: WorkflowAgentSpecParams,
	dataContract: WorkflowDataContractParams,
	replaces: Type.Optional(Type.String({ description: "Id of a failed/cancelled/rejected/pending/ready node this work unit replaces (same kind). The replaced node is auto-superseded when this one is accepted." })),
}, { additionalProperties: false });

const WorkflowParams = Type.Object({
	action: Type.String({
		enum: ["start", "clarify", "set_brief", "set_outline", "apply_plan", "run_ready", "evaluate", "quality", "get_result", "accept", "reject", "supersede", "reopen", "record_decision", "complete", "status", "pause", "resume", "stop", "cancel_node"],
		description: "Workflow state transition to perform.",
	}),
	runId: Type.Optional(Type.String({ description: "Workflow run id. Omit to use the run bound to this session branch." })),
	mode: Type.Optional(Type.String({ enum: ["general", "deep-research"], description: "Workflow policy mode for action=start." })),
	language: Type.Optional(Type.String({ enum: ["auto", "zh", "en"], description: "Workflow UI/output language for action=start. Auto detects from the goal." })),
	policy: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional gate/evidence/quality policy overrides for action=start." })),
	maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_MAX_NODES, description: "Hard cumulative work-unit budget for the workflow (default 64)." })),
	goal: Type.Optional(Type.String({ description: "User goal for action=start." })),
	questions: Type.Optional(Type.Array(ClarificationQuestionParams, { minItems: 1, maxItems: 5 })),
	brief: Type.Optional(ResearchBriefParams),
	outline: Type.Optional(DocumentOutlineParams),
	tasks: Type.Optional(Type.Array(WorkflowTaskPlanParams, { minItems: 1, description: "Human-level task hierarchy for action=apply_plan." })),
	workUnits: Type.Optional(Type.Array(WorkflowWorkUnitPlanParams, { minItems: 1, description: "Schedulable work units for action=apply_plan." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Maximum concurrent ready nodes for action=run_ready." })),
	nodeId: Type.Optional(Type.String({ minLength: 1, description: "Target node for accept/reject/supersede/get_result/cancel_node, or the one failed/cancelled node to retry with run_ready." })),
	port: Type.Optional(Type.String({ pattern: WORKFLOW_PORT_NAME_PATTERN, description: "Accepted artifact output port for action=complete." })),
	digest: Type.Optional(Type.String({ minLength: 1, description: "SHA-256 digest of the accepted artifact output for action=complete." })),
	replacementNodeId: Type.Optional(Type.String({ description: "Accepted replacement node for action=supersede." })),
	additionalAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_MAX_NODE_ATTEMPTS, description: "Extra attempts to grant a failed/cancelled node for action=reopen. Defaults to the run's per-node attempt budget." })),
	decision: Type.Optional(Type.String({ description: "Supervisor rationale for action=accept, reject, supersede, or reopen." })),
	decisionKind: Type.Optional(Type.String({ enum: ["accepted_uncertainty", "gap_resolution", "conflict_resolution"], description: "Decision category for action=record_decision." })),
	target: Type.Optional(Type.String({ description: "Exact gap question or conflict statement for action=record_decision." })),
	rationale: Type.Optional(Type.String({ description: "Evidence-based rationale for action=record_decision." })),
	reason: Type.Optional(Type.String({ description: "Human-readable reason for action=pause. Recorded in the workflow event stream for audit." })),
}, { additionalProperties: false });

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

function parseAgentSpec(value: unknown, nodeId: string): EphemeralAgentSpec {
	if (!record(value)) throw new Error(`Node '${nodeId}' agentSpec must be an object.`);
	const context = value.context;
	if (context !== "fresh" && context !== "fork") throw new Error(`Node '${nodeId}' agentSpec.context must be fresh or fork.`);
	const thinking = value.thinking;
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	if (thinking !== undefined && !thinkingLevels.includes(thinking as (typeof thinkingLevels)[number])) {
		throw new Error(`Node '${nodeId}' agentSpec.thinking is invalid.`);
	}
	const skills = value.skills;
	if (skills !== undefined && (!Array.isArray(skills) || !skills.every((entry) => typeof entry === "string" && entry.trim()))) {
		throw new Error(`Node '${nodeId}' agentSpec.skills must be a non-empty string array.`);
	}
	const normalizedSkills = Array.isArray(skills) ? skills as string[] : undefined;
	const parseToolList = (value: unknown, field: string, rejectExtensionPaths: boolean): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry.trim())) {
			throw new Error(`Node '${nodeId}' agentSpec.${field} must be a non-empty string array.`);
		}
		const entries = value as string[];
		if (entries.length > MAX_NODE_TOOL_ENTRIES) throw new Error(`Node '${nodeId}' agentSpec.${field} supports at most ${MAX_NODE_TOOL_ENTRIES} entries.`);
		for (const entry of entries) {
			if (rejectExtensionPaths && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
				throw new Error(`Node '${nodeId}' agentSpec.${field} entry '${entry}' looks like an extension path; grants may name builtin tools or MCP selectors only.`);
			}
		}
		return [...entries];
	};
	const extraTools = parseToolList(value.extraTools, "extraTools", true);
	const denyTools = parseToolList(value.denyTools, "denyTools", false);
	const timeoutMs = value.timeoutMs;
	if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
		throw new Error(`Node '${nodeId}' agentSpec.timeoutMs must be an integer >= 1.`);
	}
	const turnBudget = value.turnBudget;
	if (turnBudget !== undefined && (!record(turnBudget) || !Number.isInteger(turnBudget.maxTurns) || (turnBudget.maxTurns as number) < 1)) {
		throw new Error(`Node '${nodeId}' agentSpec.turnBudget.maxTurns must be an integer >= 1.`);
	}
	const toolBudget = value.toolBudget;
	if (toolBudget !== undefined && (!record(toolBudget) || !Number.isInteger(toolBudget.hard) || (toolBudget.hard as number) < 0)) {
		throw new Error(`Node '${nodeId}' agentSpec.toolBudget.hard must be an integer >= 0.`);
	}
	return {
		id: requiredString(value.id, `Node '${nodeId}' agentSpec.id`),
		baseAgent: requiredString(value.baseAgent, `Node '${nodeId}' agentSpec.baseAgent`),
		role: requiredString(value.role, `Node '${nodeId}' agentSpec.role`),
		objective: requiredString(value.objective, `Node '${nodeId}' agentSpec.objective`),
		instructions: requiredString(value.instructions, `Node '${nodeId}' agentSpec.instructions`),
		context,
		...(optionalString(value.model, `Node '${nodeId}' agentSpec.model`) ? { model: optionalString(value.model, `Node '${nodeId}' agentSpec.model`) } : {}),
		...(thinking ? { thinking: thinking as EphemeralAgentSpec["thinking"] } : {}),
		...(normalizedSkills ? { skills: [...normalizedSkills] } : {}),
		...(extraTools ? { extraTools } : {}),
		...(denyTools ? { denyTools } : {}),
		...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
		...(record(turnBudget) ? { turnBudget: turnBudget as unknown as NonNullable<EphemeralAgentSpec["turnBudget"]> } : {}),
		...(record(toolBudget) ? { toolBudget: toolBudget as unknown as NonNullable<EphemeralAgentSpec["toolBudget"]> } : {}),
	};
}

function parseTasks(value: unknown): WorkflowTaskPlan[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("tasks must be a non-empty array for action=apply_plan.");
	return value.map((entry, index) => {
		if (!record(entry)) throw new Error(`tasks[${index}] must be an object.`);
		const id = requiredString(entry.id, `tasks[${index}].id`);
		if (!Number.isInteger(entry.order) || (entry.order as number) < 0) throw new Error(`Task '${id}' order must be an integer >= 0.`);
		const parentId = optionalString(entry.parentId, `Task '${id}' parentId`);
		return {
			id,
			label: requiredString(entry.label, `Task '${id}' label`),
			...(parentId ? { parentId } : {}),
			order: entry.order as number,
		};
	});
}

function parseWorkflowDataContract(value: unknown, nodeId: string): WorkflowDataContract {
	if (!record(value) || value.version !== 1) throw new Error(`Work unit '${nodeId}' must declare WorkflowDataContract version 1.`);
	if (!Array.isArray(value.inputs) || !value.inputs.every((binding) => record(binding) && Array.isArray(binding.from))) {
		throw new Error(`Work unit '${nodeId}' dataContract.inputs must be an array of input bindings.`);
	}
	if (!record(value.outputs)) throw new Error(`Work unit '${nodeId}' dataContract.outputs must be an object.`);
	return structuredClone(value) as unknown as WorkflowDataContract;
}

function parseWorkUnits(value: unknown): WorkflowWorkUnitPlan[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("workUnits must be a non-empty array for action=apply_plan.");
	const kinds = new Set<WorkflowNodeKind>(["research", "verification", "outline", "section-writer", "writer", "editor", "reviewer", "custom"]);
	return value.map((entry, index) => {
		if (!record(entry)) throw new Error(`workUnits[${index}] must be an object.`);
		const id = requiredString(entry.id, `workUnits[${index}].id`);
		if (!kinds.has(entry.kind as WorkflowNodeKind)) throw new Error(`Work unit '${id}' kind is invalid.`);
		if (!Array.isArray(entry.dependsOn) || !entry.dependsOn.every((dependency) => typeof dependency === "string" && dependency.trim())) {
			throw new Error(`Work unit '${id}' dependsOn must be a string array.`);
		}
		if (!Number.isInteger(entry.order) || (entry.order as number) < 0) throw new Error(`Work unit '${id}' order must be an integer >= 0.`);
		const kind = entry.kind as WorkflowNodeKind;
		const workUnit: WorkflowWorkUnitPlan = {
			id,
			taskId: requiredString(entry.taskId, `Work unit '${id}' taskId`),
			kind,
			label: requiredString(entry.label, `Work unit '${id}' label`),
			order: entry.order as number,
			dependsOn: [...entry.dependsOn] as string[],
			agentSpec: parseAgentSpec(entry.agentSpec, id),
			dataContract: parseWorkflowDataContract(entry.dataContract, id),
			...(entry.replaces !== undefined ? { replaces: requiredString(entry.replaces, `Work unit '${id}' replaces`) } : {}),
		};
		assertWorkflowDataContract(workUnit);
		const expectedProfile = workflowProfileForKind(kind);
		if (workUnit.dataContract.profile !== expectedProfile) throw new Error(`Work unit '${id}' kind '${kind}' requires dataContract.profile '${expectedProfile}'.`);
		return workUnit;
	});
}

function parseStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) throw new Error(`${field} must be a string array.`);
	return [...value];
}

function parseClarificationQuestions(value: unknown): WorkflowClarificationQuestion[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error("questions must contain 1-5 clarification questions.");
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (!record(entry) || (entry.multiple !== undefined && typeof entry.multiple !== "boolean")) throw new Error(`questions[${index}] is invalid.`);
		const id = requiredString(entry.id, `questions[${index}].id`);
		if (ids.has(id)) throw new Error(`Duplicate clarification question '${id}'.`);
		ids.add(id);
		if (!Array.isArray(entry.options)) throw new Error(`questions[${index}].options must be an array.`);
		const options: WorkflowClarificationOption[] = entry.options.map((option, optionIndex) => {
			if (typeof option === "string") return { label: requiredString(option, `questions[${index}].options[${optionIndex}]`) };
			if (!record(option)) throw new Error(`questions[${index}].options[${optionIndex}] is invalid.`);
			const description = optionalString(option.description, `questions[${index}].options[${optionIndex}].description`);
			return {
				label: requiredString(option.label, `questions[${index}].options[${optionIndex}].label`),
				...(description ? { description } : {}),
			};
		});
		if (options.length < 2 || options.length > 6) throw new Error(`questions[${index}].options must contain 2-6 choices.`);
		if (new Set(options.map((option) => option.label.trim())).size !== options.length) throw new Error(`questions[${index}].options must be unique.`);
		return { id, prompt: requiredString(entry.prompt, `questions[${index}].prompt`), options, multiple: entry.multiple === true };
	});
}

function parseBrief(value: unknown): ResearchBrief {
	if (!record(value) || value.version !== 0) throw new Error("brief must be a ResearchBrief object.");
	if (value.depth !== "overview" && value.depth !== "standard" && value.depth !== "deep" && value.depth !== "expert") throw new Error("brief.depth is invalid.");
	if (value.deliverable !== "research-report" && value.deliverable !== "technical-whitepaper" && value.deliverable !== "decision-memo") throw new Error("brief.deliverable is invalid.");
	if (value.clarification !== "confirmed" && value.clarification !== "inferred") throw new Error("brief.clarification is invalid.");
	if (!record(value.targetWords) || !Number.isInteger(value.targetWords.min) || !Number.isInteger(value.targetWords.max)) throw new Error("brief.targetWords must contain integer min and max values.");
	return {
		version: 0,
		audience: requiredString(value.audience, "brief.audience"),
		purpose: requiredString(value.purpose, "brief.purpose"),
		scope: requiredString(value.scope, "brief.scope"),
		depth: value.depth,
		deliverable: value.deliverable,
		targetWords: { min: value.targetWords.min as number, max: value.targetWords.max as number },
		requiredTopics: parseStringArray(value.requiredTopics, "brief.requiredTopics"),
		excludedTopics: parseStringArray(value.excludedTopics, "brief.excludedTopics"),
		constraints: parseStringArray(value.constraints, "brief.constraints"),
		assumptions: parseStringArray(value.assumptions, "brief.assumptions"),
		clarification: value.clarification,
	};
}

function parseOutline(value: unknown): DocumentOutline {
	if (!record(value) || value.version !== 0) throw new Error("outline must be a DocumentOutline object.");
	if (value.approval !== "user" && value.approval !== "supervisor") throw new Error("outline.approval is invalid.");
	if (!Array.isArray(value.sections) || value.sections.length < 2) throw new Error("outline.sections must contain at least two sections.");
	return {
		version: 0,
		title: requiredString(value.title, "outline.title"),
		thesis: requiredString(value.thesis, "outline.thesis"),
		approval: value.approval,
		sections: value.sections.map((entry, index) => {
			if (!record(entry) || !Number.isInteger(entry.targetWords)) throw new Error(`outline.sections[${index}] is invalid.`);
			return {
				id: requiredString(entry.id, `outline.sections[${index}].id`),
				title: requiredString(entry.title, `outline.sections[${index}].title`),
				objective: requiredString(entry.objective, `outline.sections[${index}].objective`),
				questions: parseStringArray(entry.questions, `outline.sections[${index}].questions`),
				evidenceRequirements: parseStringArray(entry.evidenceRequirements, `outline.sections[${index}].evidenceRequirements`),
				targetWords: entry.targetWords as number,
				writerNodeId: requiredString(entry.writerNodeId, `outline.sections[${index}].writerNodeId`),
			};
		}),
	};
}

export function parseWorkflowActionParams(value: unknown): WorkflowActionParams {
	if (!record(value)) throw new Error("Workflow arguments must be an object.");
	const runId = optionalString(value.runId, "runId");
	switch (value.action) {
		case "start": {
			if (value.mode !== undefined && value.mode !== "general" && value.mode !== "deep-research") throw new Error("mode must be general or deep-research.");
			if (value.language !== undefined && value.language !== "auto" && value.language !== "zh" && value.language !== "en") throw new Error("language must be auto, zh, or en.");
			const mode = value.mode === "deep-research" || value.mode === "general" ? value.mode : undefined;
			const policy = value.policy && record(value.policy)
				? resolveWorkflowPolicy(mode ?? "general", value.policy as Partial<WorkflowPolicy>)
				: undefined;
			return {
				action: "start",
				goal: requiredString(value.goal, "goal"),
				...(mode ? { mode } : {}),
				...(value.language === "auto" || value.language === "zh" || value.language === "en" ? { language: value.language } : {}),
				...(policy ? { policy } : {}),
				...(typeof value.maxNodes === "number" ? { maxNodes: value.maxNodes } : {}),
			};
		}
		case "set_brief":
			return { action: "set_brief", ...(runId ? { runId } : {}), brief: parseBrief(value.brief) };
		case "clarify":
			return { action: "clarify", ...(runId ? { runId } : {}), questions: parseClarificationQuestions(value.questions) };
		case "set_outline":
			return { action: "set_outline", ...(runId ? { runId } : {}), outline: parseOutline(value.outline) };
		case "apply_plan":
			return {
				action: "apply_plan",
				...(runId ? { runId } : {}),
				tasks: parseTasks(value.tasks),
				workUnits: parseWorkUnits(value.workUnits),
			};
		case "run_ready": {
			if (value.concurrency !== undefined && (!Number.isInteger(value.concurrency) || (value.concurrency as number) < 1 || (value.concurrency as number) > 32)) {
				throw new Error("concurrency must be an integer between 1 and 32.");
			}
			const nodeId = optionalString(value.nodeId, "nodeId");
			return {
				action: "run_ready",
				...(runId ? { runId } : {}),
				...(typeof value.concurrency === "number" ? { concurrency: value.concurrency } : {}),
				...(nodeId ? { nodeId } : {}),
			};
		}
		case "evaluate":
		case "quality":
		case "status":
			return { action: value.action, ...(runId ? { runId } : {}) };
		case "pause": {
			const reason = optionalString(value.reason, "reason");
			return { action: "pause", ...(runId ? { runId } : {}), ...(reason ? { reason } : {}) };
		}
		case "resume":
		case "stop":
			return { action: value.action, ...(runId ? { runId } : {}) };
		case "get_result":
			return { action: "get_result", ...(runId ? { runId } : {}), nodeId: requiredString(value.nodeId, "nodeId") };
		case "cancel_node":
			return { action: "cancel_node", ...(runId ? { runId } : {}), nodeId: requiredString(value.nodeId, "nodeId") };
		case "accept":
		case "reject":
			return {
				action: value.action,
				...(runId ? { runId } : {}),
				nodeId: requiredString(value.nodeId, "nodeId"),
				decision: requiredString(value.decision, "decision"),
			};
		case "supersede":
			return {
				action: "supersede",
				...(runId ? { runId } : {}),
				nodeId: requiredString(value.nodeId, "nodeId"),
				replacementNodeId: requiredString(value.replacementNodeId, "replacementNodeId"),
				decision: requiredString(value.decision, "decision"),
			};
		case "reopen": {
			if (value.additionalAttempts !== undefined && (!Number.isInteger(value.additionalAttempts) || (value.additionalAttempts as number) < 1 || (value.additionalAttempts as number) > MAX_WORKFLOW_MAX_NODE_ATTEMPTS)) {
				throw new Error(`additionalAttempts must be an integer between 1 and ${MAX_WORKFLOW_MAX_NODE_ATTEMPTS}.`);
			}
			return {
				action: "reopen",
				...(runId ? { runId } : {}),
				nodeId: requiredString(value.nodeId, "nodeId"),
				...(typeof value.additionalAttempts === "number" ? { additionalAttempts: value.additionalAttempts } : {}),
				decision: requiredString(value.decision, "decision"),
			};
		}
		case "complete":
			const nodeId = requiredString(value.nodeId, "nodeId");
			const port = requiredString(value.port, "port");
			const digest = requiredString(value.digest, "digest");
			return { action: "complete", ...(runId ? { runId } : {}), nodeId, port, digest };
		case "record_decision": {
			if (value.decisionKind !== "accepted_uncertainty" && value.decisionKind !== "gap_resolution" && value.decisionKind !== "conflict_resolution") {
				throw new Error("decisionKind must be accepted_uncertainty, gap_resolution, or conflict_resolution.");
			}
			return {
				action: "record_decision",
				...(runId ? { runId } : {}),
				decisionKind: value.decisionKind,
				target: requiredString(value.target, "target"),
				rationale: requiredString(value.rationale, "rationale"),
			};
		}
		default:
			throw new Error(`Unsupported workflow action '${String(value.action)}'.`);
	}
}

const WorkflowAssetsParams = Type.Object({}, { additionalProperties: false });

export interface WorkflowAssetsDetails {
	catalog: AssetCatalog;
}

/**
 * Read-only companion to the `workflow` tool.
 *
 * This is deliberately a separate tool rather than a `workflow` action: every
 * `workflow` action resolves to a run and `WorkflowControllerDetails.run` is
 * required, so a catalog lookup would have to invent or load a run just to answer
 * a question that has nothing to do with run state.
 */
export function registerWorkflowAssetsTool(pi: ExtensionAPI): void {
	const tool: ToolDefinition<typeof WorkflowAssetsParams, WorkflowAssetsDetails> = {
		name: "workflow_assets",
		label: "Workflow Assets",
		description: "List the base Agents, skills, and MCP direct tools available for composing workflow nodes. Read-only; it never changes workflow state.",
		promptSnippet: "List available base Agents, skills, and MCP tools before composing a workflow DAG.",
		promptGuidelines: [
			"Call this once before apply_plan when you need to choose baseAgent, skills, or tools. Do not guess names.",
			"Agent names are valid agentSpec.baseAgent values; skill names are valid agentSpec.skills entries.",
		],
		parameters: WorkflowAssetsParams,
		executionMode: "parallel",
		async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<WorkflowAssetsDetails>> {
			// Asset catalogs are intentionally a compact card in the transcript. Keep
			// the host's global tool-output toggle from leaking a previous expanded
			// state into this high-volume, model-facing inspection step.
			if (ctx.hasUI && typeof ctx.ui.setToolsExpanded === "function") ctx.ui.setToolsExpanded(false);
			const catalog = buildAssetCatalog(ctx.cwd);
			return { content: [{ type: "text", text: formatAssetCatalog(catalog) }], details: { catalog } };
		},
		/**
		 * Collapsed by default. The full catalog is what the model needs, but printing
		 * every Agent with its tool list fills the screen, so the human sees counts
		 * plus an expand hint while the model still receives the whole text.
		 */
		renderResult(result, options, theme) {
			const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
			if (options.expanded) return new Text(text, 0, 0);
			const catalog = result.details?.catalog;
			if (!catalog) return new Text(`${noticePrefix("error")} ${compactText(text, 96)}`, 0, 0);
			const counts = [
				`${catalog.agents.length} agents`,
				`${catalog.skills.length} skills`,
				`${catalog.mcpTools.length} mcp tools`,
			].join(" · ");
			const total = text.split("\n").length;
			return new Text(
				`${theme.fg("dim", counts)}${theme.fg("muted", ` ... (${total} lines, ${keyText("app.tools.expand")} to expand)`)}`,
				0,
				0,
			);
		},
	};
	pi.registerTool(tool);
}

function renderWorkflowInlineCardFromRun(run: WorkflowRun, theme: Theme, getSnapshot?: () => ActivitySnapshot | undefined, frame?: number, expanded = false): import("@earendil-works/pi-tui").Component {
	const c = new Container();
	const lines = renderWorkflowInlineCard(
		{ runId: run.id, language: run.language, status: run.status, snapshot: getSnapshot?.(), frame, createdAt: run.createdAt, updatedAt: run.updatedAt } as WorkflowInlineCardInput,
		theme,
		process.stdout.columns || 120,
		expanded,
	);
	for (const line of lines) c.addChild(new Text(line, 0, 0));
	return c;
}

export function registerWorkflowTool(pi: ExtensionAPI, controller: WorkflowController, getSnapshot?: () => ActivitySnapshot | undefined): void {
	const tool: ToolDefinition<typeof WorkflowParams, WorkflowControllerDetails> = {
		name: "workflow",
		label: "Workflow",
		description: "Operate the root Pi Agent's durable dynamic workflow. Deep Research persists a user-intent brief and detailed outline before applying a typed DAG, then runs evidence lanes, parallel section Writers, a lead editor, and review through pi-agents-flow delegation protocol.",
		promptSnippet: "Create and control a durable dynamic workflow with parallel subagents and explicit result acceptance.",
		promptGuidelines: [
			"The primary Pi Agent is the sole workflow Supervisor; children must not call the workflow tool.",
			"For deep-research ambiguity, call clarify with 1-5 concise choice questions so Pi opens its native questionnaire. Every question must provide 2-6 choices with labels and optional short descriptions; put the recommended/default choice first.",
			"Set multiple=true only when combining choices is meaningful. The questionnaire always provides Other for user-written context. Never print the questionnaire as ordinary assistant text when UI is available.",
			"After clarify succeeds, immediately call set_brief with clarification=confirmed. Never call apply_plan before set_brief succeeds.",
			"After drafting the detailed outline, call set_outline with approval=user instead of printing a standalone confirmation request. Pi opens an inline outline review form where Enter approves or the user can submit revision feedback. If changes are requested, revise and call set_outline again. Use approval=supervisor only when the user explicitly requested immediate execution without outline review.",
			"Deep Research role mapping is strict: research -> researcher, verification -> research-verifier, outline -> research-architect, section-writer -> research-section-writer, writer -> research-writer, editor -> research-editor, reviewer -> research-reviewer. Use kind=outline only for a real Outline Architect artifact, not ordinary reconnaissance. Final plans need at least three research lanes, at least two Section Writers with distinct outline ownership, one Editor after every Section Writer, and one Reviewer after the Editor.",
			"Every workUnit must declare WorkflowDataContract V1. profile must match kind: research/verification -> research, section-writer/writer/editor -> writer, reviewer -> reviewer, outline/custom -> generic. Input binding and output port names must match ^[a-z][a-z0-9._-]{0,63}$: use architecture-map or architecture_map, never camelCase. Inputs bind explicit direct-dependency nodeId/port pairs; outputs declare mediaType, description, storage, required, and classification.",
			"Child completion is not acceptance. Call evaluate, then accept or reject each completed node with a concrete rationale.",
			"run_ready without nodeId launches only newly ready nodes. Retry one failed/cancelled node only with explicit nodeId while it remains below maxNodeAttempts (default 3); never retry unrelated failures while launching a repair node. After the ceiling, inspect retained output, then reject or supersede with one accepted replacement.",
			"Use apply_plan again to add targeted verification or repair nodes when gaps or conflicts remain.",
			"apply_plan requires tasks (human-level hierarchy) plus workUnits (schedulable units with taskId, order, dependsOn, agentSpec, and dataContract each). dependsOn orders work units only; task nesting expresses hierarchy.",
			"complete requires nodeId, port, and digest from an accepted output artifact. The runtime reads the final content from the content-addressed artifact store.",
			"Never mutate .pi-agents-flow/workflows or import Workflow Store code from bash. All transitions must use this tool.",
			"When the workflow result includes todoProjection.operations and the todo tool is available, call todo with each operation in order. Todo is a user-visible projection; never infer Workflow state from it.",
		],
		parameters: WorkflowParams,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult<WorkflowControllerDetails>> {
			// Workflow transitions are represented by the persistent cockpit below the
			// editor. Their raw controller text should remain collapsed even when a
			// prior tool inspection left the global host toggle expanded.
			if (ctx.hasUI && typeof ctx.ui.setToolsExpanded === "function") ctx.ui.setToolsExpanded(false);
			const onProgress = _onUpdate
				? (run: WorkflowRun) => {
					_onUpdate({
						content: [{ type: "text", text: "" }],
						details: { run } as WorkflowControllerDetails,
					});
				}
				: undefined;
			const response = await controller.execute(parseWorkflowActionParams(rawParams), ctx, signal, onProgress);
			return { content: [{ type: "text", text: response.text }], details: response.details };
		},
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult(result, options, theme) {
			const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
			if (result.isError || !result.details?.run) return new Text(`${noticePrefix("error")} ${compactText(text, 96)}`, 0, 0);
			return renderWorkflowInlineCardFromRun(result.details.run, theme, getSnapshot, undefined, options.expanded);
		},
	};
	pi.registerTool(tool);
}
