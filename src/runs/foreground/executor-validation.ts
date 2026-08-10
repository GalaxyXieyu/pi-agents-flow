/**
 * Launch validation / param normalization helpers for the subagent executor.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { canInvokeAgent, effectiveAgentInvocation, type AgentConfig, type AgentInvocationOrigin } from "../../agents/agents.ts";
import {
	getStepAgents,
	isDynamicParallelStep,
	isParallelStep,
	type ChainStep,
	type SequentialStep,
} from "../../shared/settings.ts";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.ts";
import { summarizeContextModes, type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";
import { wrapForkTask } from "../../shared/types.ts";
import type {
	Details,
	ResolvedToolBudget,
	ToolBudgetConfig,
} from "../../shared/types.ts";
import type { AgentDefaultContextPolicy, SubagentParamsLike, TaskParam } from "./executor-types.ts";
import {
	canonicalizeAgentName,
	collectRequestedAgentNames,
	getRequestedModeLabel,
} from "./executor-helpers.ts";

export function canonicalizeExecutionParams(params: SubagentParamsLike, agents: AgentConfig[]): { params?: SubagentParamsLike; error?: string } {
	const resolve = (name: string, location?: string): { name?: string; error?: string } => {
		const result = canonicalizeAgentName(name, agents);
		return result.error && location ? { error: `${result.error} (${location})` } : result;
	};
	if (params.agent) {
		const result = resolve(params.agent);
		if (result.error) return { error: result.error };
		params = { ...params, agent: result.name };
	}
	if (params.tasks) {
		const tasks: TaskParam[] = [];
		for (let index = 0; index < params.tasks.length; index++) {
			const task = params.tasks[index]!;
			const result = resolve(task.agent, `task ${index + 1}`);
			if (result.error) return { error: result.error };
			tasks.push({ ...task, agent: result.name! });
		}
		params = { ...params, tasks };
	}
	if (params.chain) {
		const chain: ChainStep[] = [];
		for (let index = 0; index < params.chain.length; index++) {
			const step = params.chain[index]!;
			if (isParallelStep(step)) {
				const parallel: typeof step.parallel = [];
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const task = step.parallel[taskIndex]!;
					const result = resolve(task.agent, `step ${index + 1}, task ${taskIndex + 1}`);
					if (result.error) return { error: result.error };
					parallel.push({ ...task, agent: result.name! });
				}
				chain.push({ ...step, parallel });
				continue;
			}
			if (isDynamicParallelStep(step)) {
				const result = resolve(step.parallel.agent, `step ${index + 1}`);
				if (result.error) return { error: result.error };
				chain.push({ ...step, parallel: { ...step.parallel, agent: result.name! } });
				continue;
			}
			if ("agent" in step && typeof step.agent === "string") {
				const result = resolve(step.agent, `step ${index + 1}`);
				if (result.error) return { error: result.error };
				chain.push({ ...step, agent: result.name! });
				continue;
			}
			chain.push(step);
		}
		params = { ...params, chain };
	}
	return { params };
}

export function validateAgentInvocationPolicy(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	origin: AgentInvocationOrigin,
): string | undefined {
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	for (const name of [...new Set(collectRequestedAgentNames(params))]) {
		const agent = byName.get(name);
		if (!agent || canInvokeAgent(agent, origin)) continue;
		const policy = effectiveAgentInvocation(agent);
		return `Agent '${name}' does not allow ${origin} invocation (configured invocation: ${policy}).`;
	}
	return undefined;
}

export function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const acceptanceErrors = validateExecutionAcceptance(params);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: acceptanceErrors.join(" ") }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		};
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (isDynamicParallelStep(firstStep)) {
			return {
				content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

export function validateExecutionChainBindings(params: SubagentParamsLike, dynamicFanoutMaxItems?: number): AgentToolResult<Details> | null {
	if ((params.chain?.length ?? 0) === 0) return null;
	try {
		validateChainOutputBindingsWithContext(params.chain as ChainStep[], { maxItems: dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		throw error;
	}
	return null;
}

export type { AgentDefaultContextPolicy } from "./executor-types.ts";

export function resolveAgentDefaultContextPolicy(params: SubagentParamsLike, agents: AgentConfig[]): AgentDefaultContextPolicy {
	if (params.context !== undefined) {
		return resolveExplicitContextPolicy(params);
	}
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): ContextMode =>
		byName.get(agentName)?.defaultContext === "fork" ? "fork" : "fresh";
	const requestedAgentNames = collectRequestedAgentNames(params);
	const contextSummary = summarizeContextModes(requestedAgentNames.map((name) => contextForAgent(name)));
	const usesFork = contextSummary === "fork" || contextSummary === "mixed";
	return {
		params,
		contextForAgent,
		contextSummary,
		usesFork,
	};
}

export function resolveExplicitContextPolicy(params: SubagentParamsLike): AgentDefaultContextPolicy {
	const context = params.context === "fork" ? "fork" : "fresh";
	return {
		params,
		contextForAgent: () => context,
		contextSummary: context,
		usesFork: context === "fork",
	};
}

export function shouldForkAgent(contextPolicy: AgentDefaultContextPolicy, agentName: string): boolean {
	return contextPolicy.contextForAgent(agentName) === "fork";
}

export function summarizeResultContext(details: Details, fallback: ContextSummary | undefined): ContextSummary | undefined {
	return summarizeContextModes(details.results.map((result) => result.context)) ?? fallback;
}

export function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withResolvedContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

export function applySingleAgentLaunchDefaults(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if ((params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0 || !params.agent) return params;
	const agent = agents.find((candidate) => candidate.name === params.agent);
	if (!agent) return params;
	return {
		...params,
		...(params.async === undefined && agent.defaultAsync !== undefined ? { async: agent.defaultAsync } : {}),
		...(params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs !== undefined
			? { timeoutMs: agent.defaultTimeoutMs }
			: {}),
		...(params.turnBudget === undefined && agent.defaultTurnBudget !== undefined
			? { turnBudget: agent.defaultTurnBudget }
			: {}),
		...(params.acceptance === undefined && agent.defaultAcceptance !== undefined
			? { acceptance: agent.defaultAcceptance }
			: {}),
	};
}

export function resolveRunTimeout(params: SubagentParamsLike): { timeoutMs?: number; error?: string } {
	const rawTimeout = params.timeoutMs;
	const rawMaxRuntime = params.maxRuntimeMs;
	if (rawTimeout === undefined && rawMaxRuntime === undefined) return {};
	for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]] as const) {
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			return { error: `${name} must be a positive integer.` };
		}
	}
	if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
		return { error: "timeoutMs and maxRuntimeMs are aliases; provide only one value or use the same value for both." };
	}
	return { timeoutMs: rawTimeout ?? rawMaxRuntime };
}

export function resolveToolBudget(
	raw: unknown,
	label = "toolBudget",
	options?: { minimumHard?: 0 | 1 },
): { toolBudget?: ResolvedToolBudget; error?: string } {
	const resolved = validateToolBudgetConfig(raw, label, options);
	return { toolBudget: resolved.budget, error: resolved.error };
}

export function resolveEffectiveToolBudget(input: { stepBudget?: ToolBudgetConfig; runBudget?: ResolvedToolBudget; agentBudget?: ToolBudgetConfig; configBudget?: ToolBudgetConfig }): { toolBudget?: ResolvedToolBudget; error?: string } {
	if (input.stepBudget !== undefined) return resolveToolBudget(input.stepBudget, "toolBudget");
	if (input.runBudget !== undefined) return { toolBudget: input.runBudget };
	if (input.agentBudget !== undefined) return resolveToolBudget(input.agentBudget, "agent.toolBudget");
	return resolveToolBudget(input.configBudget, "config.toolBudget");
}

export function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

export function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

export function withResolvedContext(
	result: AgentToolResult<Details>,
	fallback: ContextSummary | undefined,
): AgentToolResult<Details> {
	if (!result.details) return result;
	const context = summarizeResultContext(result.details, fallback);
	if (!context) return result;
	return {
		...result,
		details: {
			...result.details,
			context,
		},
	};
}

export function withForkThinkingNotes(
	result: AgentToolResult<Details>,
	downgrades: Map<number, string>,
): AgentToolResult<Details> {
	if (downgrades.size === 0) return result;
	const children = [...downgrades.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, agent]) => `${agent} (child ${index})`)
		.join(", ");
	const note = `Note: fork context forced thinking off for ${children}. The forked transcript contained signed Anthropic thinking blocks that were sanitized, and Anthropic children cannot resume such a transcript with thinking enabled. Use context: "fresh" when an Anthropic child needs thinking.`;
	return { ...result, content: [...result.content, { type: "text", text: note }] };
}

export function toExecutionErrorResult(params: SubagentParamsLike, error: unknown, contextSummary?: ContextSummary): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withResolvedContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		contextSummary,
	);
}

export function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForTask: ForkSessionFileForTask,
	dynamicFanoutMaxItems?: number,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				sessionFiles.push(sessionFileForTask(task.agent, flatIndex, task.model));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				sessionFiles.push(sessionFileForTask(step.parallel.agent, flatIndex, step.parallel.model));
				flatIndex++;
			}
			continue;
		}
		const sequential = step as SequentialStep;
		sessionFiles.push(sessionFileForTask(sequential.agent, flatIndex, sequential.model));
		flatIndex++;
	}
	return sessionFiles;
}

export function collectChainThinkingOverrides(
	chain: ChainStep[],
	thinkingOverrideForTask: ForkThinkingOverrideForTask,
	dynamicFanoutMaxItems?: number,
): (AgentConfig["thinking"] | undefined)[] {
	const thinkingOverrides: (AgentConfig["thinking"] | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				thinkingOverrides.push(thinkingOverrideForTask(task.agent, flatIndex, task.model));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				thinkingOverrides.push(thinkingOverrideForTask(step.parallel.agent, flatIndex, step.parallel.model));
				flatIndex++;
			}
			continue;
		}
		const sequential = step as SequentialStep;
		thinkingOverrides.push(thinkingOverrideForTask(sequential.agent, flatIndex, sequential.model));
		flatIndex++;
	}
	return thinkingOverrides;
}

export function wrapChainTasksForFork(chain: ChainStep[], contextPolicy: AgentDefaultContextPolicy): ChainStep[] {
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: shouldForkAgent(contextPolicy, task.agent)
						? wrapForkTask(task.task ?? "{previous}")
						: task.task,
				})),
			};
		}
		if (isDynamicParallelStep(step)) {
			return {
				...step,
				parallel: {
					...step.parallel,
					task: shouldForkAgent(contextPolicy, step.parallel.agent)
						? wrapForkTask(step.parallel.task ?? "{previous}")
						: step.parallel.task,
				},
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: shouldForkAgent(contextPolicy, sequential.agent)
				? wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"))
				: sequential.task,
		};
	});
}

export function preflightForkSessionsForStaticTasks(
	params: SubagentParamsLike,
	contextPolicy: AgentDefaultContextPolicy,
	sessionFileForTask: ForkSessionFileForTask,
	dynamicFanoutMaxItems?: number,
): void {
	if (!contextPolicy.usesFork) return;
	if (params.agent) {
		if (shouldForkAgent(contextPolicy, params.agent)) sessionFileForTask(params.agent, 0, params.model);
		return;
	}
	if (params.tasks) {
		params.tasks.forEach((task, index) => {
			if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, index, task.model);
		});
		return;
	}
	if (!params.chain?.length) return;
	let flatIndex = 0;
	for (const step of params.chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, flatIndex, task.model);
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			if (shouldForkAgent(contextPolicy, step.parallel.agent)) {
				for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) sessionFileForTask(step.parallel.agent, flatIndex + itemIndex, step.parallel.model);
			}
			flatIndex += maxItems;
			continue;
		}
		const sequential = step as SequentialStep;
		if (shouldForkAgent(contextPolicy, sequential.agent)) sessionFileForTask(sequential.agent, flatIndex, sequential.model);
		flatIndex++;
	}
}

