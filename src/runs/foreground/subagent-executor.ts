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
	resolveToolBudget,
	shouldForkAgent,
	toExecutionErrorResult,
	validateAgentInvocationPolicy,
	validateExecutionChainBindings,
	validateExecutionInput,
	withForkThinkingNotes,
	withResolvedContext,
} from "./executor-validation.ts";
import type {
	ExecutionContextData,
	ExecutorDeps,
	SubagentParamsLike,
} from "./executor-types.ts";
import {
	appendStepToAsyncChain,
	countRequestedSubagentSpawns,
	createForegroundControlNotifier,
	emitControlNotification,
	formatForegroundActivity,
	foregroundStatusResult,
	getAsyncInterruptTarget,
	getForegroundControl,
	hasActiveSubagentChildren,
	interruptAsyncRun,
	interruptNestedRun,
	nestedResolutionScopeForExecutor,
	rememberParentModel,
	removeForegroundControlIfIdle,
	resolveForegroundResumeTarget,
	resolveNestedResumeTarget,
	resolveResumeTarget,
	resumeAsyncRun,
	resumeLiveNestedRun,
	spawnBudgetErrorResult,
	steerNestedRun,
	trustedSessionRootsForStatus,
	withSpawnBudgetStatus,
} from "./executor-control.ts";
import {
	omitExecutionModeActionAlias,
	duplicateSubagentCallResult,
	runAsyncPath,
	runChainPath,
	runParallelPath,
	runSinglePath,
} from "./executor-run-paths.ts";

export type { SubagentParamsLike, ExecutorDeps, ExecutionContextData } from "./executor-types.ts";
export { validateAgentInvocationPolicy } from "./executor-validation.ts";
export type { AgentDefaultContextPolicy } from "./executor-validation.ts";

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



export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		origin?: AgentInvocationOrigin,
	) => Promise<AgentToolResult<Details>>;
	/**
	 * Correlated extension-to-extension delegation owns its request IDs and
	 * cancellation controllers, so independent requests may execute concurrently.
	 * The ordinary model-facing tool keeps the one-foreground-call-per-turn guard.
	 */
	executeDelegated: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		origin?: AgentInvocationOrigin,
	) => Promise<AgentToolResult<Details>>;
} {
	const delegatedThinkingOverrides = new WeakMap<object, AgentConfig["thinking"]>();
	const delegatedZeroToolBudgets = new WeakSet<object>();
	const delegatedRunIds = new WeakMap<object, string>();
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		origin: AgentInvocationOrigin = "model",
	): Promise<AgentToolResult<Details>> => {
		const delegatedThinkingOverride = delegatedThinkingOverrides.get(params);
		const allowZeroToolBudget = delegatedZeroToolBudgets.has(params);
		const delegatedRunId = delegatedRunIds.get(params);
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestParams = omitExecutionModeActionAlias(params);
		const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
		const paramsWithResolvedCwd = requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
		const action = paramsWithResolvedCwd.action;
		let requestParentModel: ParentModel | undefined;
		try {
			requestParentModel = rememberParentModel(deps.state, resolveCurrentSessionId(ctx.sessionManager), ctx.model);
		} catch (error) {
			if (action?.toLowerCase() !== "doctor") throw error;
			requestParentModel = normalizeParentModel(ctx.model);
		}
		if (action) {
			if ((WATCHDOG_TOOL_ACTIONS as readonly string[]).includes(action)) {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
						isError: true,
						details: { mode: "management" as const, results: [] },
					};
				}
				const persistsWatchdogConfig = action === "watchdog.configure"
					&& (paramsWithResolvedCwd.scope === "user" || paramsWithResolvedCwd.scope === "project");
				if (origin === "model" && persistsWatchdogConfig) {
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: `Action '${action}' with scope '${paramsWithResolvedCwd.scope}' requires native user confirmation and is unavailable without a UI.` }],
							isError: true,
							details: { mode: "management" as const, results: [] },
						};
					}
					const confirmed = await ctx.ui.confirm(
						"Persist watchdog configuration?",
						`Allow the model to update ${paramsWithResolvedCwd.scope} watchdog settings?`,
					);
					if (!confirmed) {
						return {
							content: [{ type: "text", text: `Action '${action}' canceled; no watchdog configuration was changed.` }],
							details: { mode: "management" as const, results: [] },
						};
					}
				}
				return handleWatchdogToolAction(action, paramsWithResolvedCwd, ctx, deps.watchdog);
			}
			if (action === "grant-spawn-budget") {
				if (deps.allowMutatingManagementActions === false || !ctx.hasUI) {
					return {
						content: [{ type: "text", text: "Action 'grant-spawn-budget' is available only from the root interactive parent session." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				if (!deps.state.currentSessionId) {
					return {
						content: [{ type: "text", text: "Action 'grant-spawn-budget' requires an active parent session id." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				if (hasActiveSubagentChildren(deps.state)) {
					const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
					return {
						content: [{ type: "text", text: "Spawn budget grants are rejected while current-session children are queued or running. Wait for them to settle, then retry the explicit grant." }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget },
					};
				}
				const sessionId = deps.state.currentSessionId;
				const additional = paramsWithResolvedCwd.additional ?? Number.NaN;
				const preview = preflightSpawnBudgetGrant(deps.state, deps.config, sessionId, additional);
				if (preview.error) {
					return {
						content: [{ type: "text", text: preview.error }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget: preview.snapshot },
					};
				}
				const confirmed = await ctx.ui.confirm(
					"Grant subagent spawn budget?",
					`Add ${additional} launches to this logical session?\n\n${formatSpawnBudget(preview.snapshot)}\n\nUsage is not reset. Compaction keeps the same budget; a new parent session starts a fresh one.`,
				);
				if (!confirmed) {
					return {
						content: [{ type: "text", text: "Spawn budget grant canceled; no capacity was added." }],
						details: { mode: "management", results: [], spawnBudget: preview.snapshot },
					};
				}
				const currentBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
				if (
					resolveCurrentSessionId(ctx.sessionManager) !== sessionId
					|| hasActiveSubagentChildren(deps.state)
					|| currentBudget.used !== preview.snapshot.used
					|| currentBudget.granted !== preview.snapshot.granted
				) {
					return {
						content: [{ type: "text", text: "Spawn budget grant was not applied because the session, budget, or active-child state changed while confirmation was open." }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget: currentBudget },
					};
				}
				const granted = grantSpawnBudget(deps.state, deps.config, sessionId, additional);
				return {
					content: [{ type: "text", text: granted.error ?? `Spawn budget grant applied: +${additional}. ${formatSpawnBudget(granted.snapshot)}` }],
					...(granted.error ? { isError: true } : {}),
					details: { mode: "management", results: [], spawnBudget: granted.snapshot },
				};
			}
			if (action === "doctor") {
				let currentSessionFile: string | null = null;
				let currentSessionId = deps.state.currentSessionId;
				let sessionError: string | undefined;
				try {
					currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch (error) {
					sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				let orchestratorTarget: string | undefined;
				try {
					orchestratorTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
				} catch (error) {
					if (!sessionError) sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, currentSessionId);
				return {
					content: [{
						type: "text",
						text: buildDoctorReport({
							cwd: requestCwd,
							config: deps.config,
							state: deps.state,
							context: paramsWithResolvedCwd.context,
							requestedSessionDir: paramsWithResolvedCwd.sessionDir,
							currentSessionFile,
							currentSessionId,
							orchestratorTarget,
							sessionError,
							expandTilde: deps.expandTilde,
						}),
					}],
					details: { mode: "management", results: [], spawnBudget },
				};
			}
			if (action === "status") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const withBudget = (result: AgentToolResult<Details>) => withSpawnBudgetStatus(
					result,
					deps.state,
					deps.config,
					deps.state.currentSessionId,
				);
				const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
				const nestedScope = nestedResolutionScopeForExecutor(deps);
				const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
				if (paramsWithResolvedCwd.view === "fleet") {
					return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, { state: deps.state, nested: nestedScope, sessionRoots }));
				}
				if (targetRunId) {
					try {
						const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) {
								if (paramsWithResolvedCwd.view === "transcript") {
									return withBudget({
										content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Persisted session transcript becomes inspectable after the foreground run completes when sessions are enabled." }],
										details: { mode: "management", results: [] },
									});
								}
								return withBudget(foregroundStatusResult(foreground));
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return withBudget({ content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } });
					}
				} else {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground && paramsWithResolvedCwd.view !== "transcript") return withBudget(foregroundStatusResult(foreground));
					if (foreground && paramsWithResolvedCwd.view === "transcript") {
						return withBudget({
							content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background transcript." }],
							details: { mode: "management", results: [] },
						});
					}
				}
				return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, { state: deps.state, nested: nestedScope, sessionRoots }));
			}

			if (action === "approve-checkpoint" || action === "reject-checkpoint") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				if (!targetRunId && !paramsWithResolvedCwd.dir) {
					return { content: [{ type: "text", text: `action='${action}' requires id or dir.` }], isError: true, details: { mode: "management", results: [] } };
				}
				try {
					const resolved = targetRunId ? resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }) : undefined;
					const decision = action === "approve-checkpoint" ? "approved" : "rejected";
					if (resolved?.kind === "foreground") {
						const run = deps.state.foregroundRuns?.get(resolved.id);
						if (!run?.checkpoint || run.checkpoint.status !== "pending") {
							return { content: [{ type: "text", text: `Run '${resolved.id}' is not paused at an approval checkpoint.` }], isError: true, details: { mode: "management", results: [] } };
						}
						if (deps.state.currentSessionId && run.sessionId !== deps.state.currentSessionId) {
							return { content: [{ type: "text", text: `Run '${resolved.id}' was not found in the active session.` }], isError: true, details: { mode: "management", results: [] } };
						}
						const decidedAt = Date.now();
						const checkpoint = { ...run.checkpoint, status: decision, ...(decision === "approved" ? { approvedAt: decidedAt } : { rejectedAt: decidedAt }) };
						run.checkpoint = checkpoint;
						run.updatedAt = decidedAt;
						return {
							content: [{ type: "text", text: `Checkpoint '${checkpoint.name}' ${decision} for foreground run ${resolved.id}.` }],
							details: { mode: "management", results: [], checkpoint },
						};
					}
					const location = paramsWithResolvedCwd.dir
						? resolveAsyncRunLocation(paramsWithResolvedCwd, ASYNC_DIR, RESULTS_DIR)
						: resolved?.kind === "async"
							? resolved.location
							: undefined;
					if (!location?.asyncDir) {
						return { content: [{ type: "text", text: `action='${action}' targets paused foreground or async checkpoints. No matching run found.` }], isError: true, details: { mode: "management", results: [] } };
					}
					const status = readStatus(location.asyncDir);
					const runId = status?.runId ?? location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir);
					if (!status?.checkpoint || status.state !== "paused") {
						return { content: [{ type: "text", text: `Run '${runId}' is not paused at an approval checkpoint.` }], isError: true, details: { mode: "management", results: [] } };
					}
					if (deps.state.currentSessionId && status.sessionId !== deps.state.currentSessionId) {
						return { content: [{ type: "text", text: `Run '${runId}' was not found in the active session.` }], isError: true, details: { mode: "management", results: [] } };
					}
					deliverCheckpointDecisionRequest({ asyncDir: location.asyncDir, decision, source: "subagent-action", ...(paramsWithResolvedCwd.message ? { reason: paramsWithResolvedCwd.message } : {}) });
					return {
						content: [{ type: "text", text: `Checkpoint '${status.checkpoint.name}' ${decision} for run ${runId}.` }],
						details: { mode: "management", results: [], checkpoint: { ...status.checkpoint, status: decision } },
					};
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
				}
			}
			if (action === "resume") {
				return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, origin, parentModel: requestParentModel });
			}
			if (action === "steer") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const message = (paramsWithResolvedCwd.message ?? paramsWithResolvedCwd.task ?? "").trim();
				if (!message) return { content: [{ type: "text", text: "action='steer' requires message." }], isError: true, details: { mode: "management", results: [] } };
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				if (paramsWithResolvedCwd.dir) {
					try {
						const location = resolveAsyncRunLocation(paramsWithResolvedCwd, ASYNC_DIR, RESULTS_DIR);
						const runId = location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir);
						return steerAsyncRun({
							state: deps.state,
							runId,
							message,
							index: paramsWithResolvedCwd.index,
							kill: deps.kill,
							location,
							signal,
							...(paramsWithResolvedCwd.steeringRecovery === false
								? {}
								: {
										recover: ({ absoluteDeadlineAt, ...limits }) =>
											resumeAsyncRun({ params: { ...limits, action: "resume", id: runId, message }, requestCwd, ctx, deps, origin, parentModel: requestParentModel, absoluteDeadlineAt }),
									}
							),
						});
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId) return { content: [{ type: "text", text: "action='steer' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
				let resolved: ResolvedSubagentRunId | undefined;
				try {
					resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind === "nested") return steerNestedRun({ target: resolved, message, index: paramsWithResolvedCwd.index, signal });
				if (resolved?.kind === "foreground") return { content: [{ type: "text", text: "action='steer' currently supports live async Pi child sessions only; use action='interrupt' or action='resume' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
				if (resolved?.kind !== "async") return { content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
				return steerAsyncRun({
					state: deps.state,
					runId: resolved.id,
					message,
					index: paramsWithResolvedCwd.index,
					kill: deps.kill,
					location: resolved.location,
					signal,
					...(paramsWithResolvedCwd.steeringRecovery === false
						? {}
						: {
								recover: ({ absoluteDeadlineAt, ...limits }) =>
									resumeAsyncRun({
										params: { ...limits, action: "resume", id: resolved!.id, message },
										requestCwd,
										ctx,
										deps,
										origin,
										parentModel: requestParentModel,
										absoluteDeadlineAt,
									}),
							}
					),
				});
			}
			if (action === "append-step") {
				return appendStepToAsyncChain({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, origin, parentModel: requestParentModel });
			}
			if (action === "schedule" || action === "schedule-list" || action === "schedule-status" || action === "schedule-cancel") {
				if (!deps.handleScheduledRunAction) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available in this subagent context.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				if (action === "schedule") {
					const scheduledTarget = { ...paramsWithResolvedCwd };
					delete scheduledTarget.action;
					delete scheduledTarget.schedule;
					delete scheduledTarget.scheduleName;
					const scope = resolveExecutionAgentScope(scheduledTarget.agentScope);
					const scheduledAgents = deps.discoverAgents(requestCwd, scope).agents;
					const canonical = canonicalizeExecutionParams(scheduledTarget, scheduledAgents);
					if (canonical.error) return buildRequestedModeError(scheduledTarget, canonical.error);
					const invocationError = validateAgentInvocationPolicy(canonical.params!, scheduledAgents, "model");
					if (invocationError) return buildRequestedModeError(canonical.params!, invocationError);
					return deps.handleScheduledRunAction({ ...paramsWithResolvedCwd, ...canonical.params!, action, schedule: paramsWithResolvedCwd.schedule, scheduleName: paramsWithResolvedCwd.scheduleName }, ctx);
				}
				return deps.handleScheduledRunAction(paramsWithResolvedCwd, ctx);
			}
			if (action === "stop") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (paramsWithResolvedCwd.dir) {
					try {
						const location = resolveAsyncRunLocation(paramsWithResolvedCwd, ASYNC_DIR, RESULTS_DIR);
						return stopAsyncRun(deps.state, location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir), deps.kill, location);
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId) return { content: [{ type: "text", text: "action='stop' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
				try {
					resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind === "nested") return { content: [{ type: "text", text: "action='stop' supports current-session top-level async runs only." }], isError: true, details: { mode: "management", results: [] } };
				if (resolved?.kind === "foreground") return { content: [{ type: "text", text: "action='stop' supports async runs only. Use action='interrupt' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
				const stopResult = stopAsyncRun(
					deps.state,
					resolved?.kind === "async" ? resolved.id : targetRunId,
					deps.kill,
					resolved?.kind === "async" ? resolved.location : undefined,
				);
				if (stopResult) return stopResult;
				return {
					content: [{ type: "text", text: "No stoppable async run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (resolved?.kind === "nested") return interruptNestedRun(resolved);
				const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
				if (foreground?.interrupt) {
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						foreground.currentActivityState = undefined;
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(
					deps.state,
					resolved?.kind === "async" ? resolved.id : targetRunId,
					deps.kill,
					resolved?.kind === "async" ? resolved.location : undefined,
				);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
				return {
					content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			if (origin === "model" && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: `Action '${action}' requires native user confirmation and is unavailable without a UI.` }],
						isError: true,
						details: { mode: "management" as const, results: [] },
					};
				}
				const target = paramsWithResolvedCwd.agent ?? paramsWithResolvedCwd.chainName ?? "configuration";
				const confirmed = await ctx.ui.confirm(
					"Apply subagent management change?",
					`Allow model-requested action '${action}' for '${target}'? This can change which agents the model or user may invoke.`,
				);
				if (!confirmed) {
					return {
						content: [{ type: "text", text: `Action '${action}' canceled; no subagent configuration was changed.` }],
						details: { mode: "management" as const, results: [] },
					};
				}
			}
			return handleManagementAction(action, paramsWithResolvedCwd, {
				...ctx,
				cwd: requestCwd,
				config: deps.config,
				currentSessionId: deps.state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined,
			});
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		let effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);
		const runToolBudget = resolveToolBudget(
			effectiveParams.toolBudget,
			"toolBudget",
			allowZeroToolBudget ? { minimumHard: 0 } : undefined,
		);
		if (runToolBudget.error) return buildRequestedModeError(effectiveParams, runToolBudget.error);
		const configToolBudget = resolveToolBudget(deps.config.toolBudget, "config.toolBudget");
		if (configToolBudget.error) return buildRequestedModeError(effectiveParams, configToolBudget.error);
		const usageBudget = validateUsageBudgetConfig(effectiveParams.usageBudget ?? deps.config.usageBudget, effectiveParams.usageBudget ? "usageBudget" : "config.usageBudget");
		if (usageBudget.error) return buildRequestedModeError(effectiveParams, usageBudget.error);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const discovered = deps.discoverAgents(effectiveCwd, scope);
		const discoveredAgents = discovered.agents;
		const canonicalParams = canonicalizeExecutionParams(effectiveParams, discoveredAgents);
		if (canonicalParams.error) return buildRequestedModeError(effectiveParams, canonicalParams.error);
		effectiveParams = canonicalParams.params!;
		const invocationError = validateAgentInvocationPolicy(effectiveParams, discoveredAgents, origin);
		if (invocationError) return buildRequestedModeError(effectiveParams, invocationError);
		const modelScope = discovered.modelScope;
		effectiveParams = applySingleAgentLaunchDefaults(effectiveParams, discoveredAgents);
		const turnBudget = resolveTurnBudgetConfig(effectiveParams.turnBudget ?? deps.config.turnBudget);
		if (turnBudget.error) return buildRequestedModeError(effectiveParams, turnBudget.error);
		const contextPolicy = resolveAgentDefaultContextPolicy(effectiveParams, discoveredAgents);
		effectiveParams = contextPolicy.params;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context ?? (contextPolicy.usesFork ? "fork" : undefined),
			orchestratorTarget: sessionName,
		});
		const agents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const runId = delegatedRunId ?? randomUUID().slice(0, 8);
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
		const shareEnabled = effectiveParams.share === true;
		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const validationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (validationError) return validationError;

		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const requestedSpawns = countRequestedSubagentSpawns(effectiveParams, deps.config);
		const spawnPreflight = preflightSpawnBudget(
			deps.state,
			deps.config,
			deps.state.currentSessionId,
			requestedSpawns,
		);
		if (spawnPreflight.error) return spawnBudgetErrorResult(spawnPreflight.error, foregroundMode);

		let forkSessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkThinkingOverrideForIndex: (idx?: number) => AgentConfig["thinking"] | undefined = () => undefined;
		let prepareForkThinking = (_agentName: string, _index: number, _modelOverride?: string): void => {};
		const forkThinkingRequirements = new Map<number, boolean>();
		const forkThinkingDowngrades = new Map<number, string>();
		try {
			const forkAvailableModels = contextPolicy.usesFork ? ctx.modelRegistry.getAvailable().map(toModelInfo) : [];
			const parentModel = requestParentModel;
			prepareForkThinking = (agentName, index, modelOverride) => {
				const agentConfig = agents.find((agent) => agent.name === agentName);
				const primaryModel = resolveEffectiveSubagentModel(
					modelOverride,
					agentConfig?.model,
					parentModel,
					forkAvailableModels,
					parentModel?.provider,
				);
				const candidates = buildModelCandidates(
					primaryModel,
					agentConfig?.fallbackModels,
					forkAvailableModels,
					parentModel?.provider,
				);
				forkThinkingRequirements.set(
					index,
					candidates.length === 0
						|| candidates.some((candidate) => forkedChildRequiresThinkingOff(candidate, forkAvailableModels, parentModel?.provider)),
				);
			};
			const forkContextResolver = createForkContextResolver(ctx.sessionManager, contextPolicy.usesFork ? "fork" : undefined, {
				forceThinkingOffForIndex: (index) => forkThinkingRequirements.get(index) ?? true,
			});
			forkSessionFileForIndex = forkContextResolver.sessionFileForIndex;
			forkThinkingOverrideForIndex = forkContextResolver.thinkingOverrideForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
		}
		const requestedAsync = effectiveParams.async ?? deps.asyncByDefault;
		const backgroundRequestedWhileClarifying = (hasChain || hasTasks) && requestedAsync && effectiveParams.clarify === true;
		const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
		const runTimeout = resolveRunTimeout(effectiveParams);
		if (runTimeout.error) return buildRequestedModeError(effectiveParams, runTimeout.error);
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
			dir: deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
		};
		const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.config.defaultSessionDir
				? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
				: deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
				contextPolicy.contextSummary,
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);
		const forkSessionFileForTask: ForkSessionFileForTask = (agentName, idx = 0, modelOverride) => {
			if (!shouldForkAgent(contextPolicy, agentName)) return undefined;
			prepareForkThinking(agentName, idx, modelOverride);
			return forkSessionFileForIndex(idx);
		};
		const forkThinkingOverrideForTask: ForkThinkingOverrideForTask = (agentName, idx = 0, modelOverride) => {
			if (!shouldForkAgent(contextPolicy, agentName)) return delegatedThinkingOverride;
			prepareForkThinking(agentName, idx, modelOverride);
			const override = forkThinkingOverrideForIndex(idx);
			if (override === "off") forkThinkingDowngrades.set(idx, agentName);
			return override ?? delegatedThinkingOverride;
		};
		const childSessionFileForTask: ForkSessionFileForTask = (agentName, idx, modelOverride) =>
			forkSessionFileForTask(agentName, idx, modelOverride) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
		const childSessionFileForIndex = (idx?: number) =>
			path.join(sessionDirForIndex(idx), "session.jsonl");
		try {
			if (!(effectiveParams.clarify === true && ctx.hasUI)) {
				preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, forkSessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems);
			}
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
		}
		const chainBindingsError = validateExecutionChainBindings(effectiveParams, deps.config.chain?.dynamicFanout?.maxItems);
		if (chainBindingsError) return withResolvedContext(chainBindingsError, contextPolicy.contextSummary);

		const onUpdateWithContext = onUpdate
			? (r: AgentToolResult<Details>) => onUpdate(withResolvedContext({
				...r,
				details: { ...r.details, runId },
			}, contextPolicy.contextSummary))
			: undefined;

		const reservation = reserveSpawnBudget(
			deps.state,
			deps.config,
			deps.state.currentSessionId,
			requestedSpawns,
		);
		if (reservation.error) return spawnBudgetErrorResult(reservation.error, foregroundMode);

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			sessionFileForTask: childSessionFileForTask,
			thinkingOverrideForTask: forkThinkingOverrideForTask,
			artifactConfig,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			controlConfig,
			intercomBridge,
			nestedRoute,
			timeoutMs: runTimeout.timeoutMs,
			turnBudget: turnBudget.turnBudget,
			toolBudget: runToolBudget.toolBudget,
			usageBudget: usageBudget.budget,
			allowZeroToolBudget,
			configToolBudget: configToolBudget.toolBudget,
			contextPolicy,
			modelScope,
			parentModel: requestParentModel,
			parentSessionId: deps.state.currentSessionId,
			capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(deps.state.currentSessionId ?? undefined),
		};

		const foregroundDescription = effectiveParams.task?.trim()
			|| effectiveParams.tasks?.[0]?.task?.trim()
			|| (effectiveParams.chain ? firstRawChainTask(effectiveParams.chain)?.trim() : undefined);
		const foregroundControl: ForegroundRunControl | undefined = effectiveAsync
			? undefined
			: {
				runId,
				...(deps.state.currentSessionId ? { sessionId: deps.state.currentSessionId } : {}),
				mode: foregroundMode,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				cwd: effectiveCwd,
				currentAgent: undefined,
				currentIndex: undefined,
				description: foregroundDescription,
				currentActivityState: undefined,
				steeringDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-foreground-steer-")),
				activeChildren: new Map(),
				// The outer executor owns scheduling until its finally block settles.
				schedulingOwners: 1,
				nestedRoute,
				interrupt: undefined,
			};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
			if (foregroundControl.steeringDir) trackForegroundSteeringCleanup(deps.state, foregroundSteeringCleanupKey(foregroundControl.steeringDir), foregroundControl.steeringDir);
		}

		const writeNestedForegroundEvent = (type: "subagent.nested.started" | "subagent.nested.completed", result?: AgentToolResult<Details>): void => {
			if (!inheritedNestedRoute || !nestedParentAddress) return;
			const now = Date.now();
			const details = result?.details;
			const state = type === "subagent.nested.started"
				? "running"
				: details?.results.some((child) => child.interrupted || child.detached)
					? "paused"
					: result?.isError || details?.results.some((child) => child.exitCode !== 0)
						? "failed"
						: "complete";
			const errorText = result?.isError
				? result.content.find((item) => item.type === "text")?.text
				: undefined;
			const agentsForSummary = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => task.agent)
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step) ? step.parallel.map((task) => task.agent) : [(step as SequentialStep).agent])
					: effectiveParams.agent ? [effectiveParams.agent] : [];
			const leafIntercomTarget = intercomBridge.active && agentsForSummary[0]
				? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
				: undefined;
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type,
					ts: now,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					child: {
						id: runId,
						parentRunId: nestedParentAddress.parentRunId,
						parentStepIndex: nestedParentAddress.parentStepIndex,
						depth: nestedParentAddress.depth,
						path: nestedParentAddress.path,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget,
						intercomTarget: leafIntercomTarget,
						ownerState: state === "running" ? "live" : "gone",
						mode: foregroundMode,
						state,
						agent: agentsForSummary[0],
						agents: agentsForSummary,
						startedAt: foregroundControl?.startedAt ?? now,
						...(state !== "running" ? { endedAt: now } : {}),
						lastUpdate: now,
						...(details?.totalCost ? { totalCost: details.totalCost } : {}),
						...(errorText ? { error: errorText } : {}),
						...(details?.results.length ? { steps: details.results.map((child) => ({
							agent: child.agent,
							status: child.interrupted || child.detached ? "paused" : child.exitCode === 0 ? "complete" : "failed",
							...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
							...(child.error ? { error: child.error } : {}),
						})) } : {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested foreground status event:", error);
			}
		};

		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withResolvedContext(withForkThinkingNotes(asyncResult, forkThinkingDowngrades), contextPolicy.contextSummary);
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasChain && effectiveParams.chain) {
				const result = await runChainPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary);
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary);
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary);
			}
		} catch (error) {
			const errorResult = withForkThinkingNotes(toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary), forkThinkingDowngrades);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return errorResult;
		} finally {
			if (foregroundControl) {
				settleForegroundSchedulingOwner(foregroundControl);
				removeForegroundControlIfIdle(deps.state, runId);
			}
		}

		return withResolvedContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, contextPolicy.contextSummary);
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		origin: AgentInvocationOrigin = "model",
	): Promise<AgentToolResult<Details>> => {
		const requestParams = omitExecutionModeActionAlias(params);
		if (requestParams.action) return execute(id, requestParams, signal, onUpdate, ctx, origin);
		const { depth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		const dispatchParams = applyForceTopLevelAsyncOverride(requestParams, depth, deps.config.forceTopLevelAsync === true);
		const runsForeground = dispatchParams.clarify === true || (dispatchParams.async ?? deps.asyncByDefault) !== true;
		if (!runsForeground) return execute(id, requestParams, signal, onUpdate, ctx, origin);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(requestParams);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, requestParams, signal, onUpdate, ctx, origin);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	const executeDelegated = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		origin: AgentInvocationOrigin = "model",
	): Promise<AgentToolResult<Details>> => {
		const delegatedParams = { ...params };
		const privateParams = delegatedParams as SubagentParamsLike & {
			delegatedThinkingOverride?: AgentConfig["thinking"];
			delegatedAllowZeroToolBudget?: true;
		};
		const thinkingOverride = privateParams.delegatedThinkingOverride;
		const allowZeroToolBudget = privateParams.delegatedAllowZeroToolBudget === true;
		delete privateParams.delegatedThinkingOverride;
		delete privateParams.delegatedAllowZeroToolBudget;
		if (thinkingOverride !== undefined) delegatedThinkingOverrides.set(delegatedParams, thinkingOverride);
		if (allowZeroToolBudget) delegatedZeroToolBudgets.add(delegatedParams);
		if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) delegatedRunIds.set(delegatedParams, id);
		return execute(id, delegatedParams, signal, onUpdate, ctx, origin);
	};

	return { execute: executeWithSingleDispatchGuard, executeDelegated };
}
