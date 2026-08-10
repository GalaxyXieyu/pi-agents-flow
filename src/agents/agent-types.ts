/**
 * Agent config types and pure name/policy helpers (no filesystem I/O).
 */
import type { AcceptanceInput, AcceptanceRole, OutputMode, ToolBudgetConfig, TurnBudgetConfig } from "../shared/types.ts";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "package" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";
export type AgentVisibility = "default" | "hidden";
export type AgentInvocation = "both" | "model" | "user" | "disabled";
export type AgentInvocationOrigin = "model" | "user";

export function effectiveAgentVisibility(agent: Pick<AgentConfig, "visibility">): AgentVisibility {
	return agent.visibility ?? "default";
}

export function effectiveAgentInvocation(agent: Pick<AgentConfig, "invocation">): AgentInvocation {
	return agent.invocation ?? "both";
}

export function isAgentVisibleToModel(agent: Pick<AgentConfig, "visibility" | "disabled">): boolean {
	return agent.disabled !== true && effectiveAgentVisibility(agent) === "default";
}

export function canInvokeAgent(
	agent: Pick<AgentConfig, "invocation" | "disabled">,
	origin: AgentInvocationOrigin,
): boolean {
	if (agent.disabled === true) return false;
	const invocation = effectiveAgentInvocation(agent);
	return invocation === "both" || invocation === origin;
}

export type AgentMemoryScope = "project" | "user";

export interface AgentMemoryConfig {
	scope: AgentMemoryScope;
	path: string;
}

export const BUILTIN_AGENT_NAMES = [
	"advisor",
	"context-builder",
	"delegate",
	"oracle",
	"planner",
	"researcher",
	"reviewer",
	"scout",
	"worker",
] as const;

export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

export function defaultInheritSkills(): boolean {
	return false;
}

export interface BuiltinAgentOverrideBase {
	description?: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	acceptanceRole?: AcceptanceRole;
	disabled?: boolean;
	visibility?: AgentVisibility;
	invocation?: AgentInvocation;
	systemPrompt: string;
	skills?: string[];
	skillPath?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
}

export interface BuiltinAgentOverrideConfig {
	description?: string;
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext | false;
	acceptanceRole?: AcceptanceRole | false;
	disabled?: boolean;
	visibility?: AgentVisibility | false;
	invocation?: AgentInvocation | false;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
	extensions?: string[] | false;
	subagentOnlyExtensions?: string[] | false;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig | false;
}

export interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentModelSourceInfo {
	type: "subagents.defaultModel";
	scope: "user" | "project";
	path: string;
	model: string;
}

export interface AgentConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	aliases?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	defaultAsync?: boolean;
	defaultTimeoutMs?: number;
	defaultTurnBudget?: TurnBudgetConfig;
	defaultAcceptance?: AcceptanceInput;
	acceptanceRole?: AcceptanceRole;
	visibility?: AgentVisibility;
	invocation?: AgentInvocation;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	skillPath?: string[];
	extensions?: string[];
	extensionsFromDefault?: boolean;
	subagentOnlyExtensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
	memory?: AgentMemoryConfig;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
	modelSource?: AgentModelSourceInfo;
}

export type ProjectRootResolution = "nearest" | "git-root";

export interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	defaultModel?: string;
	defaultThinking?: string;
	defaultExtensions?: string[];
	disableBuiltins?: boolean;
	disableThinking?: boolean;
	modelScope?: ModelScopeConfig;
}

export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };
export const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

export interface ChainStepConfig {
	agent?: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: string | Record<string, unknown>;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
	parallel?: unknown;
	expand?: unknown;
	collect?: unknown;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	acceptance?: AcceptanceInput;
	toolBudget?: ToolBudgetConfig;
}

export interface ChainConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface ChainDiscoveryDiagnostic {
	source: AgentSource;
	filePath: string;
	error: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	modelScope?: ModelScopeConfig;
}

export function normalizeAgentAliases(rawAliases: string[] | undefined, agentName: string): string[] | undefined {
	const aliases = [...new Set((rawAliases ?? []).map((alias) => alias.trim()).filter(Boolean))]
		.filter((alias) => alias !== agentName);
	return aliases.length > 0 ? aliases : undefined;
}

export function effectiveAgentMatch(matches: AgentConfig[]): { agent?: AgentConfig; error?: string } {
	const distinctNames = [...new Set(matches.map((agent) => agent.name))];
	if (distinctNames.length === 1) {
		const sourceRank = new Map<AgentConfig["source"], number>([["builtin", 0], ["package", 1], ["user", 2], ["project", 3]]);
		return { agent: [...matches].sort((a, b) => (sourceRank.get(b.source) ?? 0) - (sourceRank.get(a.source) ?? 0))[0] };
	}
	return {};
}

export function resolveAgentName(name: string, agents: AgentConfig[]): { agent?: AgentConfig; error?: string } {
	const raw = name.trim();
	const exact = agents.filter((agent) => agent.name === raw || agent.localName === raw);
	if (exact.length === 1) return { agent: exact[0] };
	if (exact.length > 1) {
		const effective = effectiveAgentMatch(exact);
		if (effective.agent) return effective;
		return { error: `Ambiguous agent name '${name}': ${exact.map((agent) => agent.name).join(", ")}` };
	}

	const aliases = agents.filter((agent) => agent.aliases?.includes(raw));
	if (aliases.length === 1) return { agent: aliases[0] };
	if (aliases.length > 1) {
		const effective = effectiveAgentMatch(aliases);
		if (effective.agent) return effective;
		return { error: `Ambiguous agent alias '${name}': ${aliases.map((agent) => agent.name).join(", ")}` };
	}
	return {};
}

export function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(rawTools !== undefined ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

export function joinToolList(config: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined {
	const joined = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	return joined.length > 0 ? joined : undefined;
}

export function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		description: agent.description,
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		acceptanceRole: agent.acceptanceRole,
		disabled: agent.disabled,
		visibility: agent.visibility,
		invocation: agent.invocation,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		skillPath: agent.skillPath ? [...agent.skillPath] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		extensions: agent.extensionsFromDefault ? undefined : agent.extensions ? [...agent.extensions] : undefined,
		subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
		completionGuard: agent.completionGuard,
		toolBudget: agent.toolBudget,
	};
}

export function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
	return {
		...(override.description !== undefined ? { description: override.description } : {}),
		...(override.model !== undefined ? { model: override.model } : {}),
		...(override.fallbackModels !== undefined
			? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
			: {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
		...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
		...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
		...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
		...(override.acceptanceRole !== undefined ? { acceptanceRole: override.acceptanceRole } : {}),
		...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
		...(override.visibility !== undefined ? { visibility: override.visibility } : {}),
		...(override.invocation !== undefined ? { invocation: override.invocation } : {}),
		...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
		...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
		...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
		...(override.extensions !== undefined ? { extensions: override.extensions === false ? false : [...override.extensions] } : {}),
		...(override.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: override.subagentOnlyExtensions === false ? false : [...override.subagentOnlyExtensions] } : {}),
		...(override.completionGuard !== undefined ? { completionGuard: override.completionGuard } : {}),
		...(override.toolBudget !== undefined ? { toolBudget: override.toolBudget === false ? false : { ...override.toolBudget, ...(Array.isArray(override.toolBudget.block) ? { block: [...override.toolBudget.block] } : {}) } } : {}),
	};
}

