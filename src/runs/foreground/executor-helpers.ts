/**
 * Pure helpers extracted from subagent-executor for smaller review surfaces.
 * Behavior is intentionally identical to the previous private functions.
 */
import * as path from "node:path";

import type { AgentConfig } from "../../agents/agents.ts";
import { resolveAgentName } from "../../agents/agents.ts";
import {
	getStepAgents,
	isDynamicParallelStep,
	isParallelStep,
	type ChainStep,
	type SequentialStep,
} from "../../shared/settings.ts";
import { DEFAULT_FORK_PREAMBLE, type NestedRunSummary } from "../../shared/types.ts";
import type { SubagentParamsLike } from "./subagent-executor.ts"; // type-only: no runtime cycle

export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

export function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

export function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

export function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

export function duplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		else seen.add(name);
	}
	return [...duplicates];
}

export function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

export function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

export function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function canonicalizeAgentName(name: string, agents: AgentConfig[]): { name?: string; error?: string } {
	const resolved = resolveAgentName(name, agents);
	if (resolved.error) return { error: resolved.error };
	if (!resolved.agent) return { error: `Unknown agent: ${name}` };
	return { name: resolved.agent.name };
}

export function getRequestedModeLabel(params: SubagentParamsLike): "single" | "parallel" | "chain" {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

export function collectRequestedAgentNames(params: SubagentParamsLike): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names;
}

export function firstChainAgent(chain: ChainStep[]): string | undefined {
	const first = chain[0];
	if (!first) return undefined;
	if (isParallelStep(first)) return first.parallel[0]?.agent;
	if (isDynamicParallelStep(first)) return first.parallel.agent;
	return (first as SequentialStep).agent;
}

export function firstRawChainTask(chain: ChainStep[]): string | undefined {
	const first = chain[0];
	if (!first) return undefined;
	if (isParallelStep(first)) return first.parallel[0]?.task;
	if (isDynamicParallelStep(first)) return first.parallel.task;
	return (first as SequentialStep).task;
}

export function resolveAsyncEventGoal(workflowTask: string | undefined, rawChain: ChainStep[], unwrapForkFallback = false): string {
	if (workflowTask?.trim()) return workflowTask;
	const fallback = firstRawChainTask(rawChain) || "";
	if (!unwrapForkFallback) return fallback;
	const forkPrefix = `${DEFAULT_FORK_PREAMBLE}\n\nTask:\n`;
	return fallback.startsWith(forkPrefix) ? fallback.slice(forkPrefix.length) : fallback;
}
