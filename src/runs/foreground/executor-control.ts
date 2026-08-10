import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canInvokeAgent, effectiveAgentInvocation, resolveAgentName, type AgentConfig, type AgentInvocationOrigin, type AgentScope } from "../../agents/agents.ts";
import { getArtifactsDir, getProjectChainRunsDir } from "../../shared/artifacts.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { resolveEffectiveThinking, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { executeChain } from "./chain-execution.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	forgetForegroundSteeringCleanup,
	foregroundSchedulingSettled,
	foregroundSteeringCleanupKey,
	foregroundSteeringPaths,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	trackForegroundSteeringCleanup,
	updateForegroundChild,
} from "./foreground-control.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { runSync } from "./execution.ts";
import { handleWatchdogToolAction, WATCHDOG_TOOL_ACTIONS } from "../../watchdog/tool-actions.ts";
import type { MainWatchdogRuntime } from "../../watchdog/runtime.ts";
import { buildModelCandidates, normalizeParentModel, resolveEffectiveSubagentModel, resolveModelCandidate, type ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { buildAsyncRunnerSteps, executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import {
	collectRequestedAgentNames,
	duplicateNames,
	escapeRegExp,
	firstChainAgent,
	firstRawChainTask,
	getRequestedModeLabel,
	isAsyncRunNotFound,
	isExactResumeError,
	isResumeAmbiguity,
	nestedRunAgent,
	nestedRunSessionFile,
	pathWithin,
	resolveAsyncEventGoal,
	resolveRequestedCwd,
	resumeTargetExact,
	canonicalizeAgentName,
} from "./executor-helpers.ts";
import type { AgentDefaultContextPolicy } from "./executor-validation.ts";
import {
	applySingleAgentLaunchDefaults,
	buildRequestedModeError,
	canonicalizeExecutionParams,
	normalizeRepeatedParallelCounts,
	preflightForkSessionsForStaticTasks,
	resolveAgentDefaultContextPolicy,
	resolveEffectiveToolBudget,
	resolveRunTimeout,
	toExecutionErrorResult,
	validateAgentInvocationPolicy,
	validateExecutionChainBindings,
	validateExecutionInput,
	withForkThinkingNotes,
	withResolvedContext,
	wrapChainTasksForFork,
} from "./executor-validation.ts";
import type {
	ExecutionContextData,
	ExecutorDeps,
	ForkSessionFileForTask,
	ForkThinkingOverrideForTask,
	SubagentParamsLike,
} from "./executor-types.ts";

import type { ScheduledRunAction } from "../background/scheduled-runs.ts";
import { enqueueChainAppendRequest, readPendingChainAppendRequests, runnerStepOutputNames } from "../background/chain-append.ts";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";
import { createForkContextResolver, forkedChildRequiresThinkingOff } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { formatSpawnBudget, getSpawnBudgetSnapshot, grantSpawnBudget, preflightSpawnBudget, preflightSpawnBudgetGrant, reserveSpawnBudget } from "../shared/spawn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState, validateUsageBudgetConfig } from "../shared/usage-budget.ts";
import { intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { isAgentContractV1 } from "../shared/agent-contract.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage } from "../../shared/utils.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.ts";
import { formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup } from "../shared/parallel-handoff.ts";
import { summarizeContextModes, type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { applySteeringRecoveryAgentConfig, buildRevivedAsyncTask, resolveAsyncResumeTarget, resolveAsyncRunLocation } from "../background/async-resume.ts";
import { deliverCheckpointDecisionRequest, deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.ts";
import { waitForSteeringAction } from "../background/steering.ts";
import { steerAsyncRun } from "./async-steering-action.ts";
import { stopAsyncRun } from "./async-stop-action.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveAsyncRootResultPath } from "../background/chain-root-attachment.ts";
import { attachRootChildrenToSteps, createNestedRoute, findNestedControlResult, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, snapshotNestedEventFiles, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type AsyncStatus,
	type AcceptanceInput,
	type AgentContract,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type ForegroundRunControl,
	type IntercomEventBus,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SingleResult,
	type SubagentForegroundCompleteEvent,
	type ToolBudgetConfig,
	type TurnBudgetConfig,
	type UsageBudgetConfig,
	type SubagentRunMode,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SUBAGENT_ACTIONS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	wrapForkTask,
} from "../../shared/types.ts";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset", "grant-spawn-budget", "watchdog.configure"]);
interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	outputSchema?: JsonSchemaObject;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	toolBudget?: ToolBudgetConfig;
}


export function rememberParentModel(state: { currentSessionId?: string | null; lastParentModel?: ParentModel }, sessionId: string | null, model: unknown): ParentModel | undefined {
	if (state.currentSessionId !== sessionId) state.lastParentModel = undefined;
	state.currentSessionId = sessionId;
	const parentModel = normalizeParentModel(model);
	if (!sessionId) return parentModel;
	if (parentModel) state.lastParentModel = parentModel;
	return parentModel ?? state.lastParentModel;
}


export function removeForegroundControlIfIdle(state: SubagentState, runId: string): boolean {
	state.foregroundControls ??= new Map();
	state.cleanupTimers ??= new Map();
	const control = state.foregroundControls.get(runId);
	if (control && (!foregroundSchedulingSettled(control) || (control.activeChildren?.size ?? 0) > 0)) return false;
	clearPendingForegroundControlNotices(state, runId);
	if (control?.steeringDir) {
		const steeringDir = control.steeringDir;
		const cleanupKey = foregroundSteeringCleanupKey(steeringDir);
		const previous = state.cleanupTimers.get(cleanupKey);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			fs.rmSync(steeringDir, { recursive: true, force: true });
			state.cleanupTimers.delete(cleanupKey);
			forgetForegroundSteeringCleanup(state, cleanupKey);
		}, 5_000);
		timer.unref?.();
		state.cleanupTimers.set(cleanupKey, timer);
		trackForegroundSteeringCleanup(state, cleanupKey, steeringDir);
	}
	state.foregroundControls.delete(runId);
	if (state.lastForegroundControlId === runId) state.lastForegroundControlId = null;
	return true;
}

export function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

export function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running") return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

export function nestedResolutionScopeForExecutor(deps: ExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}

export function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
	const roots = deps.config.defaultSessionDir ? [path.resolve(deps.expandTilde(deps.config.defaultSessionDir))] : [];
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	if (parentSessionFile) roots.push(deps.getSubagentSessionRoot(parentSessionFile));
	return [...new Set(roots)];
}

export function spawnBudgetErrorResult(message: string, mode: "single" | "parallel" | "chain"): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

export function withSpawnBudgetStatus(
	result: AgentToolResult<Details>,
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string | null,
): AgentToolResult<Details> {
	const spawnBudget = getSpawnBudgetSnapshot(state, config, sessionId);
	return {
		...result,
		content: result.content.map((item, index) => index === 0 && item.type === "text"
			? { ...item, text: `${formatSpawnBudget(spawnBudget)}\n${item.text}` }
			: item),
		details: { ...result.details, spawnBudget },
	};
}

export function hasActiveSubagentChildren(state: SubagentState): boolean {
	if (state.subagentInProgress || state.foregroundControls.size > 0) return true;
	const isActive = (status: string) => status === "queued" || status === "running";
	return [...state.asyncJobs.values(), ...(state.fleetJobs?.values() ?? [])].some((job) => isActive(job.status));
}

export function countRequestedSubagentSpawns(params: SubagentParamsLike, config: ExtensionConfig): number {
	if (params.tasks) return params.tasks.length;
	if (params.chain) {
		return params.chain.reduce((total, step) => {
			if (isDynamicParallelStep(step)) return total + (step.expand.maxItems ?? config.chain?.dynamicFanout?.maxItems ?? 0);
			return total + getStepAgents(step).length;
		}, 0);
	}
	return params.agent ? 1 : 0;
}

export function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

export function trimRememberedForegroundRuns(state: SubagentState): void {
	if (!state.foregroundRuns) return;
	while (state.foregroundRuns.size > 50) {
		const oldestTerminal = [...state.foregroundRuns.values()]
			.filter((run) => !run.children.some((child) => child.status === "detached"))
			.sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldestTerminal) break;
		state.foregroundRuns.delete(oldestTerminal.runId);
	}
}

export function foregroundChildActivityFromProgress(progress: SingleResult["progress"] | undefined) {
	return {
		...(progress?.activityState ? { activityState: progress.activityState } : {}),
		...(progress?.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}),
		...(progress?.currentTool ? { currentTool: progress.currentTool } : {}),
		...(progress?.currentToolStartedAt !== undefined ? { currentToolStartedAt: progress.currentToolStartedAt } : {}),
		...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
		...(progress?.turnCount !== undefined ? { turnCount: progress.turnCount } : {}),
		...(progress?.tokens !== undefined ? { tokens: progress.tokens } : {}),
		...(progress?.toolCount !== undefined ? { toolCount: progress.toolCount } : {}),
	};
}

export function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId: string | null; results: SingleResult[]; checkpoint?: Details["checkpoint"] }): void {
	state.foregroundRuns ??= new Map();
	const previous = state.foregroundRuns.get(input.runId);
	const updatedAt = Date.now();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		updatedAt,
		...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
		children: input.results.map((result, index) => {
			const child = {
				agent: result.agent,
				index,
				...(result.context ? { context: result.context } : {}),
				status: resolveSubagentResultStatus({
					exitCode: result.exitCode,
					interrupted: result.interrupted,
					detached: result.detached,
					processSignal: result.processSignal,
					timedOut: result.timedOut,
					stopped: result.stopped,
					turnBudgetExceeded: result.turnBudgetExceeded,
				}),
				...foregroundChildActivityFromProgress(result.progress),
				...(result.progressSummary?.durationMs !== undefined ? { durationMs: result.progressSummary.durationMs } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				updatedAt,
				...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
				...(result.error ? { error: result.error } : {}),
				...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
				...(result.outputState ? { outputState: result.outputState } : {}),
				...(result.outputMode ? { outputMode: result.outputMode } : {}),
				...(result.savedOutputPath ? { savedOutputPath: result.savedOutputPath } : {}),
				...(result.outputSaveError ? { outputSaveError: result.outputSaveError } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.model ? { model: result.model } : {}),
				...(result.thinking ? { thinking: result.thinking } : {}),
				...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
				...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
				...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
				...(result.detachedReason ? { detachedReason: result.detachedReason } : {}),
				...(result.acceptance ? { acceptance: result.acceptance } : {}),
				...(result.launchContractDigest ? { launchContractDigest: result.launchContractDigest } : {}),
				...(result.launchResolvedExtensions ? { launchResolvedExtensions: result.launchResolvedExtensions } : {}),
				...(result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: result.runtimeAcknowledgedExtensions } : {}),
				...(result.capabilityCeiling ? { capabilityCeiling: result.capabilityCeiling } : {}),
				...(result.capabilityAudit ? { capabilityAudit: result.capabilityAudit } : {}),
			};
			const recovered = previous?.children[index];
			return child.status === "detached" && recovered && recovered.status !== "detached" ? recovered : child;
		}),
	});
	trimRememberedForegroundRuns(state);
}

export function applyControlEventToRememberedForegroundRun(state: SubagentState, event: ControlEvent): void {
	const run = state.foregroundRuns?.get(event.runId);
	if (!run) return;
	const index = event.index ?? (run.children.length === 1 ? run.children[0]?.index : undefined);
	if (index === undefined) return;
	const child = run.children[index];
	if (!child || child.status !== "detached") return;
	const updatedAt = event.ts;
	run.updatedAt = updatedAt;
	run.children[index] = {
		...child,
		activityState: event.to,
		updatedAt,
		...(event.elapsedMs !== undefined ? { lastActivityAt: event.ts - event.elapsedMs } : {}),
		...(event.currentTool ? { currentTool: event.currentTool } : {}),
		...(event.currentToolDurationMs !== undefined ? { currentToolStartedAt: event.ts - event.currentToolDurationMs } : {}),
		...(event.currentPath ? { currentPath: event.currentPath } : {}),
		...(event.turns !== undefined ? { turnCount: event.turns } : {}),
		...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
		...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
	};
}

export function updateRememberedForegroundChild(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId: string | null; index: number; result: SingleResult; events: IntercomEventBus }): void {
	state.foregroundRuns ??= new Map();
	const updatedAt = Date.now();
	let run = state.foregroundRuns.get(input.runId);
	if (!run) {
		run = { runId: input.runId, mode: input.mode, cwd: input.cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}), updatedAt, children: [] };
		state.foregroundRuns.set(input.runId, run);
	}
	run.updatedAt = updatedAt;
	const terminalStatus = resolveSubagentResultStatus({
		exitCode: input.result.exitCode,
		...(input.result.acceptance?.status === "rejected" ? { success: false } : {}),
		interrupted: input.result.interrupted,
		detached: false,
		processSignal: input.result.processSignal,
		timedOut: input.result.timedOut,
		stopped: input.result.stopped,
		turnBudgetExceeded: input.result.turnBudgetExceeded,
	});
	const child = run.children[input.index] ?? { agent: input.result.agent, index: input.index, status: "detached" as const };
	run.children[input.index] = {
		...child,
		agent: input.result.agent,
		index: input.index,
		...(input.result.context ? { context: input.result.context } : {}),
		status: terminalStatus,
		...foregroundChildActivityFromProgress(input.result.progress),
		...(input.result.progressSummary?.durationMs !== undefined ? { durationMs: input.result.progressSummary.durationMs } : {}),
		...(input.result.usage ? { usage: input.result.usage } : {}),
		updatedAt,
		...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
		...(input.result.error ? { error: input.result.error } : {}),
		...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
		outputState: input.result.outputState,
		outputMode: input.result.outputMode,
		savedOutputPath: input.result.savedOutputPath,
		outputSaveError: input.result.outputSaveError,
		...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
		...(input.result.model ? { model: input.result.model } : {}),
		...(input.result.thinking ? { thinking: input.result.thinking } : {}),
		...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
		...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
		...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
		...(input.result.detachedReason ? { detachedReason: input.result.detachedReason } : {}),
		...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
		...(input.result.launchContractDigest ? { launchContractDigest: input.result.launchContractDigest } : {}),
		...(input.result.launchResolvedExtensions ? { launchResolvedExtensions: input.result.launchResolvedExtensions } : {}),
		...(input.result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: input.result.runtimeAcknowledgedExtensions } : {}),
		...(input.result.capabilityCeiling ? { capabilityCeiling: input.result.capabilityCeiling } : {}),
		...(input.result.capabilityAudit ? { capabilityAudit: input.result.capabilityAudit } : {}),
	};
	trimRememberedForegroundRuns(state);
	const output = getSingleResultOutput(input.result).trim();
	const success = terminalStatus === "completed";
	const summary = !success && input.result.error
		? `${input.result.error}${output ? `\n\nOutput:\n${output}` : ""}`
		: output || input.result.error || "Detached child exited without final output.";
	// A detached callback may outlive its extension runtime. Stale sessions are
	// intentionally dropped rather than routed through a replacement runtime.
	if (!input.sessionId || input.sessionId !== state.currentSessionId) return;
	const completionEvent: SubagentForegroundCompleteEvent = {
		id: `${input.runId}:${input.index}`,
		runId: input.runId,
		source: "foreground",
		mode: input.mode,
		agent: input.result.agent,
		success,
		summary,
		exitCode: input.result.exitCode,
		state: terminalStatus === "completed" ? "complete" : terminalStatus,
		...(input.result.interrupted !== undefined ? { interrupted: input.result.interrupted } : {}),
		...(input.result.stopped !== undefined ? { stopped: input.result.stopped } : {}),
		...(input.result.processSignal !== undefined ? { processSignal: input.result.processSignal } : {}),
		...(input.result.timedOut !== undefined ? { timedOut: input.result.timedOut } : {}),
		...(input.result.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: input.result.turnBudgetExceeded } : {}),
		timestamp: updatedAt,
		cwd: input.cwd,
		sessionFile: input.result.sessionFile,
		sessionId: input.sessionId,
		taskIndex: input.index,
		...(input.result.structuredOutput !== undefined ? { structuredOutput: input.result.structuredOutput } : {}),
		...(input.result.model ? { model: input.result.model } : {}),
		...(input.result.thinking ? { thinking: input.result.thinking } : {}),
		...(input.result.launchContractDigest ? { launchContractDigest: input.result.launchContractDigest } : {}),
		usage: input.result.usage,
		...(input.result.progressSummary ? { progressSummary: input.result.progressSummary } : {}),
		...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
	};
	input.events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, completionEvent);
}

export function resolveForegroundResumeTarget(params: SubagentParamsLike, state: SubagentState): { runId: string; mode: "single" | "parallel" | "chain"; state: "complete"; agent: string; index: number; cwd: string; sessionFile: string; model?: string; thinking?: string; launchContractDigest?: string; capabilityCeiling?: ResolvedSubagentCapabilityCeiling } | undefined {
	const requested = (params.id ?? params.runId)?.trim();
	if (!requested || !state.foregroundRuns?.size || !state.currentSessionId) return undefined;
	const sessionRuns = [...state.foregroundRuns.values()].filter((run) => run.sessionId === state.currentSessionId);
	const direct = sessionRuns.find((run) => run.runId === requested);
	const matches = direct ? [direct] : sessionRuns.filter((run) => run.runId.startsWith(requested));
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	const run = matches[0]!;
	if (run.children.some((child) => child.status === "detached")) throw new Error(`Foreground run '${run.runId}' is detached for intercom coordination and cannot be revived safely while any child may still be live. Reply to the supervisor request first, then wait with subagent_wait({ id: "${run.runId}" }); use status to recover the result and do not launch a replacement while it remains detached.`);
	if (run.children.length > 1 && params.index === undefined) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= run.children.length) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
	const child = run.children[index]!;
	if (!child.sessionFile) throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
	if (path.extname(child.sessionFile) !== ".jsonl") throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile)) throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
	return {
		runId: run.runId,
		mode: run.mode,
		state: "complete",
		agent: child.agent,
		index,
		cwd: run.cwd,
		sessionFile,
		...(child.model ? { model: child.model } : {}),
		...(child.thinking ? { thinking: child.thinking } : {}),
		...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
		...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
	};
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	cwd?: string;
	sessionFile: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

export function resolveResumeTarget(params: SubagentParamsLike, state: SubagentState, options: { asyncRequireSessionFile?: boolean } = {}): ResumeSourceTarget {
	const requested = (params.id ?? params.runId)?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = {
			source: "async",
			...resolveAsyncResumeTarget(params, {}, {
				requireSessionFile: options.asyncRequireSessionFile,
				sessionId: state.currentSessionId ?? undefined,
			}),
		};
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested)) throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id or runId.");
}

export function getAsyncInterruptTarget(
	state: SubagentState,
	runId: string | undefined,
	location?: { asyncDir: string | null; resolvedId?: string },
	options: { fallbackToNewest?: boolean } = {},
): { asyncId: string; asyncDir: string } | undefined {
	if (location?.asyncDir) {
		return {
			asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
			asyncDir: location.asyncDir,
		};
	}
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
		if (options.fallbackToNewest === false) return undefined;
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

export function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

export function interruptAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId, location);
	if (!target) return null;
	const status = reconcileAsyncRun(target.asyncDir, { kill }).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		deliverInterruptRequest({ asyncDir: target.asyncDir, pid: status.pid, kill, source: "interrupt-action" });
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

export function appendStepToAsyncChain(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	origin: AgentInvocationOrigin;
	parentModel?: ParentModel;
}): AgentToolResult<Details> {
	const targetRunId = input.params.id ?? input.params.runId;
	if (!targetRunId) {
		return {
			content: [{ type: "text", text: "action='append-step' requires id." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!input.params.chain || input.params.chain.length !== 1) {
		return {
			content: [{ type: "text", text: "action='append-step' requires chain with exactly one step." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const acceptanceErrors = validateExecutionAcceptance(input.params);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step: ${acceptanceErrors.join(" ")}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let resolved: ResolvedSubagentRunId | undefined;
	try {
		resolved = resolveSubagentRunId(targetRunId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}
	if (!resolved) {
		return {
			content: [{ type: "text", text: `No async chain run found for '${targetRunId}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (resolved.kind !== "async" || !resolved.location.asyncDir) {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is not an append-capable async chain run.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const status = readStatus(resolved.location.asyncDir);
	if (!status) {
		return {
			content: [{ type: "text", text: `No async run status found for '${resolved.id}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.mode !== "chain") {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is ${status.mode}; only active chain runs accept appended steps.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.state !== "running") {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is ${status.state}; only running chain runs accept appended steps.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const stillInProgress = (status.steps ?? []).some((step) => step.status === "running" || step.status === "pending") || (status.pendingAppends ?? 0) > 0;
	if (!stillInProgress) {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' has no running or pending chain steps left; append-step must target an in-progress chain.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const pendingAppendRequests = readPendingChainAppendRequests(resolved.location.asyncDir);
	const reservedOutputNames = new Set<string>([
		...Object.keys(status.outputs ?? {}),
		...(status.steps ?? []).map((step) => step.outputName).filter((name): name is string => Boolean(name)),
		...pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)),
	]);
	try {
		validateChainOutputBindingsWithContext(input.params.chain, { maxItems: input.deps.config.chain?.dynamicFanout?.maxItems }, {
			priorOutputNames: reservedOutputNames,
			startStepIndex: status.chainStepCount ?? status.steps?.length ?? 0,
		});
	} catch (error) {
		if (!(error instanceof ChainOutputValidationError)) throw error;
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': ${error.message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discoveredForAppend = input.deps.discoverAgents(input.requestCwd, scope);
	const agents = discoveredForAppend.agents;
	const canonicalParams = canonicalizeExecutionParams(input.params, agents);
	if (canonicalParams.error) return buildRequestedModeError(input.params, canonicalParams.error);
	const effectiveParams = canonicalParams.params!;
	const invocationError = validateAgentInvocationPolicy(effectiveParams, agents, input.origin);
	if (invocationError) return buildRequestedModeError(effectiveParams, invocationError);
	const contextPolicy = resolveExplicitContextPolicy(effectiveParams);
	const chainSkillInput = normalizeSkillInput(effectiveParams.skill);
	const chainSkills = chainSkillInput === false ? [] : (chainSkillInput ?? []);
	const parentModel = input.parentModel;
	const asyncCtx = {
		pi: input.deps.pi,
		cwd: input.ctx.cwd,
		currentSessionId: resolveCurrentSessionId(input.ctx.sessionManager),
		parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
		currentModelProvider: parentModel?.provider,
		currentModel: parentModel,
		modelScope: discoveredForAppend.modelScope,
		interactive: input.ctx.hasUI,
	};
	const built = buildAsyncRunnerSteps(resolved.id, {
		chain: wrapChainTasksForFork(effectiveParams.chain!, contextPolicy),
		task: effectiveParams.task,
		resultMode: "chain",
		agents,
		ctx: asyncCtx,
		availableModels: input.ctx.modelRegistry.getAvailable().map(toModelInfo),
		cwd: status.cwd ?? input.requestCwd,
		chainSkills,
		dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		waitToolEnabled: input.deps.waitToolEnabled,
		contextForAgent: contextPolicy.contextForAgent,
		asyncDir: resolved.location.asyncDir,
		validateOutputBindings: false,
		capabilityCeiling: intersectSubagentCapabilityCeilings(status.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(asyncCtx.currentSessionId)),
	});
	if ("error" in built) {
		return {
			content: [{ type: "text", text: built.error }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const appendedOutputNames = runnerStepOutputNames(built.steps);
	const duplicateAppendedOutputs = duplicateNames(appendedOutputNames);
	if (duplicateAppendedOutputs.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': duplicate output name in appended step: ${duplicateAppendedOutputs.join(", ")}.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const pendingOutputNames = new Set(pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)));
	const pendingDuplicateOutputs = appendedOutputNames.filter((name) => pendingOutputNames.has(name));
	if (pendingDuplicateOutputs.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': output name already belongs to a pending append: ${pendingDuplicateOutputs.join(", ")}.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	try {
		const result = enqueueChainAppendRequest({
			asyncDir: resolved.location.asyncDir,
			runId: resolved.id,
			steps: built.steps,
		});
		const stepText = built.steps.length === 1 ? "step" : "steps";
		return {
			content: [{
				type: "text",
				text: `Append queued for chain run ${resolved.id}: ${built.steps.length} ${stepText}. It becomes eligible after the chain's already-queued steps finish. Pending appends: ${result.pendingCount}.`,
			}],
			details: { mode: "management", results: [], asyncId: resolved.id, asyncDir: resolved.location.asyncDir },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to append step to chain run ${resolved.id}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

export function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
	}
	return realSessionFile;
}

export function resolveNestedResumeTarget(match: ResolvedSubagentRunId & { kind: "nested" }, trustedSessionRoots: string[]): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued") throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	if (run.state === "stopped") throw new Error(`Nested run '${run.id}' was stopped and cannot be resumed. Start a new run instead.`);
	const agent = nestedRunAgent(run);
	if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
	const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	return {
		kind: "revive",
		source: "nested",
		runId: run.id,
		state,
		agent,
		index: 0,
		cwd: asyncDir ? path.dirname(asyncDir) : undefined,
		sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
		...(run.capabilityCeiling ? { capabilityCeiling: run.capabilityCeiling } : {}),
	};
}

export async function waitForNestedControlResult(target: ResolvedSubagentRunId & { kind: "nested" }, requestId: string, ignoredFiles: ReadonlySet<string>, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = findNestedControlResult(target.match.route, requestId, target.match.run.id, ignoredFiles);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

export async function sendNestedControlRequest(target: ResolvedSubagentRunId & { kind: "nested" }, action: "interrupt" | "resume", message?: string) {
	const requestId = randomUUID();
	const ignoredFiles = snapshotNestedEventFiles(target.match.route);
	const requestedAt = Date.now();
	writeNestedControlRequest(target.match.route, {
		ts: requestedAt,
		requestId,
		targetRunId: target.match.run.id,
		action,
		...(message ? { message } : {}),
	});
	return waitForNestedControlResult(target, requestId, ignoredFiles);
}

export function directNestedAsyncInterrupt(target: ResolvedSubagentRunId & { kind: "nested" }): AgentToolResult<Details> | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(RESULTS_DIR, "nested", target.match.rootRunId) }).status;
	const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
	if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0) return undefined;
	try {
		deliverInterruptRequest({ asyncDir, pid, source: "nested-interrupt" });
		return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [] } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
	}
}

export async function directNestedAsyncSteer(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string; index?: number; signal?: AbortSignal }): Promise<AgentToolResult<Details> | undefined> {
	const run = input.target.match.run;
	const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(RESULTS_DIR, "nested", input.target.match.rootRunId) }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) return undefined;
	const steps = status.steps ?? [];
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length) return { content: [{ type: "text", text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.` }], isError: true, details: { mode: "management", results: [] } };
		const step = steps[input.index];
		if (step && step.status !== "running" && step.status !== "pending") return { content: [{ type: "text", text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
	}
	const runningIndexes = steps
		.map((step, index) => step.status === "running" ? index : undefined)
		.filter((index): index is number => index !== undefined);
	const effectiveTargetIndex = input.index ?? (status.mode === "single" && runningIndexes.length === 0 && steps[0]?.status === "pending" ? 0 : undefined);
	const targetIndexes = effectiveTargetIndex !== undefined ? [effectiveTargetIndex] : runningIndexes;
	if (targetIndexes.length === 0) return { content: [{ type: "text", text: `Nested async run ${run.id} has no running child to steer.` }], isError: true, details: { mode: "management", results: [] } };
	const requestId = randomUUID();
	try {
		requestAsyncSteer(asyncDir, {
			message: input.message,
			...(effectiveTargetIndex !== undefined ? { targetIndex: effectiveTargetIndex } : { targetIndexes }),
			source: "nested-steer",
			id: requestId,
		});
	} catch (error) {
		return { content: [{ type: "text", text: `Failed to queue steering for nested async run ${run.id}: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "management", results: [] } };
	}
	const targets = targetIndexes.map((index) => ({ index, state: steps[index]?.status === "pending" ? "scheduled" as const : "pending" as const }));
	if (targets.every((target) => target.state === "scheduled")) {
		const scheduled = { requestId, state: "scheduled" as const, sourceRunId: run.id, targets };
		return { content: [{ type: "text", text: `Steering scheduled for nested async run ${run.id} (request ${requestId}).` }], details: { mode: "management", results: [], steering: scheduled } };
	}
	const waited = await waitForSteeringAction({ asyncDir, sourceRunId: run.id, requestId, timeoutMs: 3_000, signal: input.signal });
	const result = waited ?? { requestId, state: "pending" as const, sourceRunId: run.id, targets };
	const stateText = result.state === "delivered" ? "delivered" : result.state === "failed" ? "failed" : result.state === "partial" ? "partial" : "pending";
	return { content: [{ type: "text", text: `Steering ${stateText} for nested async run ${run.id} (request ${requestId}).` }], ...(result.state === "failed" || result.state === "partial" ? { isError: true } : {}), details: { mode: "management", results: [], steering: result } };
}

export async function interruptNestedRun(target: ResolvedSubagentRunId & { kind: "nested" }): Promise<AgentToolResult<Details>> {
	const run = target.match.run;
	if (run.state === "complete") return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "failed") return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "paused") return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	const direct = directNestedAsyncInterrupt(target);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}

export async function resumeLiveNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string }): Promise<AgentToolResult<Details>> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message);
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}

export async function steerNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string; index?: number; signal?: AbortSignal }): Promise<AgentToolResult<Details>> {
	const run = input.target.match.run;
	if (run.state !== "running" && run.state !== "queued") return { content: [{ type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
	const direct = await directNestedAsyncSteer(input);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.` }], isError: true, details: { mode: "management", results: [] } };
}

export async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	origin: AgentInvocationOrigin;
	parentModel?: ParentModel;
	absoluteDeadlineAt?: number;
}): Promise<AgentToolResult<Details>> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	const attachChain = (input.params.chain?.length ?? 0) > 0 ? input.params.chain as ChainStep[] : undefined;
	if (!followUp && !attachChain) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (input.params.model !== undefined) {
		return {
			content: [{ type: "text", text: "action='resume' reuses the persisted child model and does not accept a model override." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const acceptanceErrors = validateExecutionAcceptance(input.params);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot resume: ${acceptanceErrors.join(" ")}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		let resolved: ResolvedSubagentRunId | undefined;
		try {
			resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const asyncMatches = message.match(/async:/g)?.length ?? 0;
			if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1) throw error;
		}
		if (resolved?.kind === "nested") {
			if (attachChain) {
				return {
					content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for top-level async runs only." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				const scope = resolveExecutionAgentScope(input.params.agentScope);
				const nestedAgent = input.deps.discoverAgents(input.requestCwd, scope).agents.find((agent) => agent.name === resolved.match.run.agent);
				if (!nestedAgent) return buildRequestedModeError(input.params, `Unknown agent for live nested resume: ${resolved.match.run.agent ?? "(unknown)"}`);
				if (!canInvokeAgent(nestedAgent, input.origin)) {
					return buildRequestedModeError(input.params, `Agent '${nestedAgent.name}' does not allow ${input.origin} invocation (configured invocation: ${effectiveAgentInvocation(nestedAgent)}).`);
				}
				return resumeLiveNestedRun({ target: resolved, message: followUp });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else {
			target = resolveResumeTarget(input.params, input.deps.state, { asyncRequireSessionFile: !attachChain });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live" && !attachChain) {
		return {
			content: [{
				type: "text",
				text: [
					`Async child '${target.runId}' index ${target.index} is still running. action='resume' only revives paused, completed, or failed children.`,
					`Send live input with subagent({ action: "steer", id: "${target.runId}", index: ${target.index}, message: "..." }).`,
				].join("\n"),
			}],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discovered = input.deps.discoverAgents(effectiveCwd, scope);
	const discoveredAgents = discovered.agents;
	const modelScope = discovered.modelScope;
	const sessionName = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
	const discoveredAgentConfig = agents.find((agent) => agent.name === target.agent);
	const agentConfig: AgentConfig | undefined = discoveredAgentConfig ?? (recoveryDescriptor ? {
		name: recoveryDescriptor.agent,
		description: "Persisted async recovery contract",
		systemPrompt: "",
		systemPromptMode: recoveryDescriptor.systemPromptMode,
		inheritProjectContext: recoveryDescriptor.inheritProjectContext,
		inheritSkills: recoveryDescriptor.inheritSkills,
		invocation: recoveryDescriptor.invocation,
		source: "project",
		filePath: recoveryDescriptor.agentFilePath ?? path.join(recoveryDescriptor.cwd, ".pi-agents-flow-recovery-agent"),
	} : undefined);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!canInvokeAgent(agentConfig, input.origin)) {
		return buildRequestedModeError(input.params, `Agent '${target.agent}' does not allow ${input.origin} invocation (configured invocation: ${effectiveAgentInvocation(agentConfig)}).`);
	}
	if (attachChain) {
		const canonicalParams = canonicalizeExecutionParams({ ...input.params, chain: attachChain }, agents);
		if (canonicalParams.error) return buildRequestedModeError(input.params, canonicalParams.error);
		const invocationError = validateAgentInvocationPolicy(canonicalParams.params!, agents, input.origin);
		if (invocationError) return buildRequestedModeError(canonicalParams.params!, invocationError);
	}

	if (attachChain) {
		if (target.source !== "async") {
			return {
				content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for async runs only." }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-agents-flow package dependencies are installed." }],
				isError: true,
				details: { mode: "chain", results: [] },
			};
		}
		const runId = randomUUID().slice(0, 8);
		const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir };
		const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
		const contextPolicy = resolveExplicitContextPolicy(input.params);
		const workflowTask = (input.params.task ?? followUp) || undefined;
		const goal = resolveAsyncEventGoal(workflowTask, attachChain);
		const chain = wrapChainTasksForFork(attachChain, contextPolicy);
		const normalized = normalizeSkillInput(input.params.skill);
		const parentModel = input.parentModel;
		const result = executeAsyncChain(runId, {
			chain,
			task: workflowTask,
			goal,
			attachRoot: {
				runId: target.runId,
				asyncDir: target.asyncDir ?? path.join(ASYNC_DIR, target.runId),
				resultPath: resolveAsyncRootResultPath(RESULTS_DIR, target.runId),
				index: target.index,
				agent: target.agent,
				label: `Attached ${target.runId}`,
			},
			agents,
			ctx: {
				pi: input.deps.pi,
				cwd: input.requestCwd,
				currentSessionId: input.deps.state.currentSessionId,
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: parentModel?.provider,
				currentModel: parentModel,
				modelScope,
				interactive: input.ctx.hasUI,
			},
			availableModels,
			cwd: effectiveCwd,
			maxOutput: input.params.maxOutput,
			artifactsDir: getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir),
			artifactConfig,
			shareEnabled: input.params.share === true,
			sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
			chainSkills: normalized === false ? [] : (normalized ?? []),
			agentContract: input.params.agentContract,
			dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
			waitToolEnabled: input.deps.waitToolEnabled,
			worktreeSetupHook: input.deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: input.deps.config.worktreeBaseDir,
			controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
			controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
			globalConcurrencyLimit: input.deps.config.globalConcurrencyLimit,
			capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
		});
		if (result.isError) return result;
		const attachedId = result.details.asyncId ?? runId;
		const lines = [
			`Attached async subagent ${target.runId} as the first step of a new chain.`,
			`Chain run: ${attachedId}`,
			`Root: ${target.agent} (step ${target.index + 1})`,
			result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
			`Status if needed: subagent({ action: "status", id: "${attachedId}" })`,
		].filter((line): line is string => Boolean(line));
		return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }], details: result.details };
	}

	const runId = randomUUID().slice(0, 8);
	const recoveryAgentConfig = recoveryDescriptor ? applySteeringRecoveryAgentConfig(agentConfig, recoveryDescriptor) : agentConfig;
	const artifactConfig: ArtifactConfig = recoveryDescriptor?.artifactConfig ?? { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir };
	const artifactsDir = recoveryDescriptor?.artifactsDir ?? getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const parentModel = input.parentModel;
	const result = executeAsyncSingle(runId, {
		agent: target.agent,
		task: buildRevivedAsyncTask(target, followUp),
		goal: followUp,
		agentConfig: recoveryAgentConfig,
		ctx: {
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			currentModelProvider: parentModel?.provider,
			currentModel: parentModel,
			modelScope,
			interactive: input.ctx.hasUI,
		},
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput ?? recoveryDescriptor?.maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled: recoveryDescriptor?.share ?? input.params.share === true,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
		...(recoveryDescriptor?.sessionDir ? { sessionDir: recoveryDescriptor.sessionDir } : {}),
		sessionFile: target.sessionFile,
		revivalLease: {
			sessionFile: target.sessionFile,
			runId,
			sourceRunId: target.runId,
			...(input.deps.state.currentSessionId ? { parentSessionId: input.deps.state.currentSessionId } : {}),
		},
		modelOverride: recoveryDescriptor?.model ?? target.model,
		thinkingOverride: recoveryDescriptor?.thinking ?? target.thinking,
		outputBaseDir: resolveSingleRunOutputBaseDir(input.deps, artifactsDir, runId),
		maxSubagentDepth: recoveryDescriptor?.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		waitToolEnabled: input.deps.waitToolEnabled,
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: input.deps.config.worktreeBaseDir,
		controlConfig: recoveryDescriptor?.controlConfig ?? resolveControlConfig(input.deps.config.control, input.params.control),
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		availableModels,
		output: typeof input.params.output === "string" ? input.params.output : recoveryDescriptor?.outputPath,
		outputMode: input.params.outputMode ?? recoveryDescriptor?.outputMode,
		...(recoveryDescriptor?.agentContract ? { agentContract: recoveryDescriptor.agentContract } : {}),
		...(recoveryDescriptor?.structuredOutputSchema ? { structuredOutputSchema: recoveryDescriptor.structuredOutputSchema } : {}),
		...(recoveryDescriptor?.skills ? { skills: [...recoveryDescriptor.skills] } : {}),
		...(recoveryDescriptor?.acceptance !== undefined && input.params.acceptance === undefined ? { acceptance: recoveryDescriptor.acceptance } : {}),
		...(input.params.timeoutMs !== undefined ? { timeoutMs: input.params.timeoutMs } : {}),
		...(input.absoluteDeadlineAt !== undefined ? { absoluteDeadlineAt: input.absoluteDeadlineAt } : {}),
		...(input.params.turnBudget !== undefined ? { turnBudget: input.params.turnBudget } : {}),
		...(input.params.toolBudget !== undefined ? { toolBudget: input.params.toolBudget } : {}),
		capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, recoveryDescriptor?.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
	});
	if (result.isError) return result;

	const revivedId = result.details.asyncId ?? runId;
	const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }],
		details: {
			...result.details,
			...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
		},
	};
}

export function resultSummaryForIntercom(result: SingleResult): string {
	const output = getSingleResultOutput(result);
	if (result.exitCode !== 0 && result.error) {
		return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
	}
	return output || result.error || "(no output)";
}

export function formatFailedSingleRunOutput(result: SingleResult, displayOutput: string): string {
	const error = result.error || "Failed";
	const output = displayOutput.trim();
	const lines = [error];
	if (output && output !== error.trim()) {
		lines.push("", "Output:", output);
	}
	if (result.artifactPaths?.outputPath && fs.existsSync(result.artifactPaths.outputPath)) {
		lines.push("", `Output artifact: ${result.artifactPaths.outputPath}`);
	}
	return lines.join("\n");
}

export function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi" | "state">): (event: ControlEvent) => void {
	return (event) => {
		applyControlEventToRememberedForegroundRun(deps.state, event);
		emitControlNotification({
			pi: deps.pi,
			controlConfig: data.controlConfig,
			intercomBridge: data.intercomBridge,
			event,
		});
	};
}

export async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
	chainSteps?: number;
	nestedChildren?: NestedRunSummary[];
	parallelHandoff?: Details["parallelHandoff"];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	if (!input.intercomBridge.active || !input.intercomBridge.resultDelivery || !input.intercomBridge.orchestratorTarget) return null;
	const children = input.results.flatMap((result, index) => result.detached ? [] : [{
		agent: result.agent,
		status: resolveSubagentResultStatus({
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			detached: result.detached,
			processSignal: result.processSignal,
			timedOut: result.timedOut,
			stopped: result.stopped,
			turnBudgetExceeded: result.turnBudgetExceeded,
		}),
		outputState: result.outputState ?? "unknown",
		summary: resultSummaryForIntercom(result),
		index,
		artifactPath: result.artifactPaths?.outputPath,
		sessionPath: result.sessionFile,
		intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
	}]);
	if (children.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		source: "foreground",
		children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
		...(input.parallelHandoff ? { parallelHandoff: input.parallelHandoff } : {}),
	});
	const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
	if (!delivered) return null;
	return payload;
}

export async function maybeBuildForegroundIntercomReceipt(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	nestedChildren?: NestedRunSummary[];
}): Promise<{ text: string; details: Details } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
		...(input.details.parallelHandoff ? { parallelHandoff: input.details.parallelHandoff } : {}),
	});
	if (!payload) return null;
	return {
		text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
		details: stripDetailsOutputsForIntercomReceipt(input.details),
	};
}

