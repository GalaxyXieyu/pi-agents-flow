import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { writeAtomicJson } from "../shared/atomic-json.ts";
import { DEFAULT_WORKFLOW_CONCURRENCY, loadConfig } from "../extension/config.ts";
import { classifyWorkflowFailure, normalizeParentModel } from "../runs/shared/model-fallback.ts";
import { toModelInfo } from "../shared/model-info.ts";
import type { SubagentForegroundCompleteEvent } from "../shared/types.ts";
import { collectWorkflowClarification } from "../tui/workflow-clarify.ts";
import { collectWorkflowOutlineReview, type WorkflowOutlineReviewResult } from "../tui/workflow-outline-review.ts";
import type { WorkflowDelegationAdapter } from "./delegation-adapter.ts";
import { createLocalWorkflowArtifactStore, writeAtomicTextFile } from "./artifact-store.ts";
import { assertWorkflowBinding, createWorkflowBinding, type WorkflowBinding } from "./branch-binding.ts";
import {
	CODING_APPROVAL_ANNOTATION,
	CODING_PREAPPROVAL_READONLY_ANNOTATION,
	buildCodingContract,
	type CodingWorkflowContract,
} from "./coding-preset.ts";
import { dependencyIsAccepted, finalAcceptedEditor } from "./effective-nodes.ts";
import { evaluateWorkflow, type WorkflowEvaluation } from "./gates.ts";
import { resolveWorkflowLanguage, workflowLanguageInstruction, workflowRunLanguage, type WorkflowLanguageMode } from "./language.ts";
import { buildWorkflowRepairGuidance, formatWorkflowRepairGuidance, type WorkflowRepairGuidance } from "./guidance.ts";
import { registerWorkflowOutputs } from "./output-ports.ts";
import { assertDeepResearchCompletionContracts, assertDeepResearchEditorLineage } from "./data-contract.ts";
import { parseWorkflowResult } from "./result-contract.ts";
import { DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS, resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import { createWorkflowScheduler, type WorkflowScheduler } from "./scheduler.ts";
import { resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { assessWorkflowQuality, formatWorkflowQualityReport, type WorkflowQualityReport } from "./quality.ts";
import { createWorkflowStore, type WorkflowStore } from "./store.ts";
import { getProjectWorkflowsDir } from "../shared/project-runtime.ts";
import type { WorkflowTodoAdapterResult } from "./todo-adapter.ts";
import { buildWorkflowTodoProjection, type WorkflowTodoProjection } from "./todo-projection.ts";
import type { DocumentOutline, ResearchBrief, WorkflowResult, WorkflowClarificationQuestion, WorkflowClarificationRound, WorkflowContinuationState, WorkflowEvent, WorkflowMode, WorkflowTaskPlan, WorkflowWorkUnitPlan, WorkflowRun } from "./types.ts";

import {
	WORKFLOW_BINDING_ENTRY_TYPE,
	bindingFrom,
	bounded,
	codingWorkflowContract,
	defaultBranch,
	dependsOnGate,
	effectiveWorkflowNodeId,
	guidanceDetails,
	latestBinding,
	parseForegroundCompletion,
	readJsonRecord,
	statusText,
	type CreateWorkflowControllerOptions,
	type WorkflowActionParams,
	type WorkflowContinuationDecision,
	type WorkflowController,
	type WorkflowControllerDetails,
	type WorkflowControllerResult,
} from "./controller-helpers.ts";

export type {
	WorkflowActionParams,
	WorkflowControllerDetails,
	WorkflowControllerResult,
	WorkflowController,
	WorkflowContinuationDecision,
	CreateWorkflowControllerOptions,
} from "./controller-helpers.ts";
export { WORKFLOW_BINDING_ENTRY_TYPE } from "./controller-helpers.ts";

export function createWorkflowController(options: CreateWorkflowControllerOptions): WorkflowController {
	const now = options.now ?? Date.now;
	const createRunId = options.createRunId ?? (() => randomUUID());
	const createEventId = options.createEventId ?? (() => randomUUID());
	const resolveBranch = options.resolveBranch ?? defaultBranch;
	const rootDir = options.rootDir ?? ((cwd: string) => getProjectWorkflowsDir(cwd, "write"));
	const storeFor = (cwd: string): WorkflowStore => createWorkflowStore({ rootDir: rootDir(cwd) });
	// Resolved once: process-level defaults must not drift between transitions.
	const extensionConfig = loadConfig();
	const maxConcurrency = options.maxConcurrency ?? extensionConfig.workflowConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY;
	const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(options.maxNodeAttempts ?? extensionConfig.workflowMaxNodeAttempts ?? DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS);
	const activeRuns = new Map<string, AbortController>();
	const activeSchedulers = new Map<string, WorkflowScheduler>();
	const pendingForegroundCompletions = new Map<string, SubagentForegroundCompleteEvent>();
	const persistBinding = (run: WorkflowRun): void => options.appendEntry(WORKFLOW_BINDING_ENTRY_TYPE, createWorkflowBinding(run));
	const requireCodingImplementationApproval = async (
		run: WorkflowRun,
		gateNodeId: string,
		ctx: ExtensionContext,
		options: { replacementNodeId?: string } = {},
	): Promise<void> => {
		const gateNode = run.nodes[gateNodeId];
		if (!gateNode?.dataContract.annotations?.[CODING_APPROVAL_ANNOTATION]) return;
		if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
			throw new Error(`Accepting or superseding '${gateNode.id}' requires native user approval before Coding implementation can start.`);
		}
		const planSummary = run.nodes["coding-plan"]?.result?.summary.text;
		const reviewSummary = options.replacementNodeId
			? run.nodes[options.replacementNodeId]?.result?.summary.text
			: gateNode.result?.summary.text;
		const approvalContext = [
			options.replacementNodeId
				? `Accept replacement '${options.replacementNodeId}' for the verified plan gate and unlock implementation, integration checking, and final verification?`
				: "Accept the verified plan and unlock implementation, integration checking, and final verification?",
			planSummary ? `Plan:\n${bounded(planSummary, 3_000)}` : undefined,
			reviewSummary ? `Plan check:\n${bounded(reviewSummary, 1_500)}` : undefined,
		].filter((entry): entry is string => entry !== undefined).join("\n\n");
		const approved = await ctx.ui.confirm("Approve Coding implementation?", approvalContext);
		if (!approved) throw new Error("Coding implementation approval was declined; the plan gate remains unchanged.");
	};
	const classifiedFailure = (error: string, context: Parameters<typeof classifyWorkflowFailure>[1] = {}) => {
		const classification = classifyWorkflowFailure(error, context);
		return {
			failureClass: classification.failureClass,
			retryable: classification.retryable,
			suggestedAction: classification.suggestedAction,
			...(classification.pauseWorkflow ? { pauseWorkflow: true } : {}),
		};
	};
	const registerCompletion = (store: WorkflowStore, run: WorkflowRun, nodeId: string, attemptId: string, result: WorkflowResult): Pick<Extract<WorkflowEvent, { type: "node.completed" }>, "result" | "resultArtifact" | "outputs"> => {
		const node = run.nodes[nodeId];
		if (!node) throw new Error(`Unknown workflow node '${nodeId}'.`);
		const structuredOutputPath = node.attempts.at(-1)?.structuredOutputPath;
		const registered = registerWorkflowOutputs({
			run,
			node,
			attemptId,
			result,
			contract: node.dataContract,
			artifactStore: createLocalWorkflowArtifactStore(store.paths(run.id).artifacts),
			...(structuredOutputPath ? { trustedSubmissionDir: path.join(path.dirname(structuredOutputPath), "submissions") } : {}),
		});
		return { result: registered.eventResult, resultArtifact: registered.resultArtifact, outputs: registered.outputs };
	};
	const applyForegroundCompletion = (store: WorkflowStore, run: WorkflowRun, completion: SubagentForegroundCompleteEvent): WorkflowRun => {
		const match = Object.values(run.nodes).find((node) => {
			const attempt = node.attempts.at(-1);
			return node.status === "waiting" && attempt?.status === "waiting" && attempt.childRunId === completion.runId;
		});
		const attempt = match?.attempts.at(-1);
		if (!match || !attempt) return run;
		const usage = completion.usage
			? {
				input: completion.usage.input,
				output: completion.usage.output,
				cacheRead: completion.usage.cacheRead,
				cacheWrite: completion.usage.cacheWrite,
				cost: completion.usage.cost,
				turns: completion.usage.turns,
				toolCalls: completion.progressSummary?.toolCount ?? 0,
				durationMs: completion.progressSummary?.durationMs ?? 0,
			}
			: undefined;
		const retainedArtifacts = completion.artifactPaths
			? [...new Set(Object.values(completion.artifactPaths).filter((value): value is string => Boolean(value)))]
			: [];
		const metadata = {
			childRunId: completion.runId,
			...(completion.launchContractDigest ?? attempt.launchContractDigest ? { launchContractDigest: completion.launchContractDigest ?? attempt.launchContractDigest } : {}),
			...(completion.model ?? attempt.model ? { model: completion.model ?? attempt.model } : {}),
			...(retainedArtifacts.length ? { artifactPaths: retainedArtifacts } : {}),
			...(usage ? { usage } : {}),
		};
		try {
			const parsed = parseWorkflowResult(completion.structuredOutput, match.dataContract);
			const recoveryError = completion.summary || `Detached child exited with code ${completion.exitCode}.`;
			return store.append(run.id, {
				id: `foreground:${completion.id}:completed`,
				type: "node.completed",
				at: completion.timestamp,
				nodeId: match.id,
				attemptId: attempt.attemptId,
				...registerCompletion(store, run, match.id, attempt.attemptId, parsed),
				...(completion.success ? {} : { recoveredFromError: recoveryError }),
				...metadata,
			});
		} catch (error) {
			const terminalError = completion.success
				? `Detached child returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`
				: completion.summary || `Detached child exited with code ${completion.exitCode}.`;
			return store.append(run.id, {
				id: `foreground:${completion.id}:failed`,
				type: "node.failed",
				at: completion.timestamp,
				nodeId: match.id,
				attemptId: attempt.attemptId,
				error: terminalError,
				failure: classifiedFailure(terminalError, completion.success ? { failureClass: "invalid_result" } : { stage: "transport" }),
				...metadata,
			});
		}
	};
	const reconcileForegroundCompletions = (store: WorkflowStore, run: WorkflowRun): WorkflowRun => {
		let next = run;
		for (const [childRunId, completion] of pendingForegroundCompletions) {
			const reconciled = applyForegroundCompletion(store, next, completion);
			if (reconciled.revision === next.revision) continue;
			next = reconciled;
			pendingForegroundCompletions.delete(childRunId);
		}
		return next;
	};
	const recoverWaitingAttempts = (store: WorkflowStore, run: WorkflowRun): WorkflowRun => {
		if (run.status !== "active" && run.status !== "paused") return run;
		let next = run;
		for (const node of Object.values(run.nodes)) {
			const attempt = node.attempts.at(-1);
			if (node.status !== "waiting" || attempt?.status !== "waiting") continue;
			// A waiting node whose wait deadline has passed and never reported back is
			// failed so the workflow cannot wait forever on a detached child that died.
			const deadline = attempt.waitDeadline;
			if (deadline !== undefined && now() >= deadline) {
				next = store.append(next.id, {
					id: `recovery:${attempt.attemptId}:wait-timeout`,
					type: "node.failed",
					at: now(),
					nodeId: node.id,
					attemptId: attempt.attemptId,
					error: `Detached child did not resolve within the configured wait deadline; retry is allowed.`,
					...(attempt.childRunId ? { childRunId: attempt.childRunId } : {}),
					...(attempt.structuredOutputPath ? { structuredOutputPath: attempt.structuredOutputPath } : {}),
					...(attempt.metadataPath ? { metadataPath: attempt.metadataPath } : {}),
				});
				continue;
			}
			if (!attempt.metadataPath) continue;
			const metadata = readJsonRecord(attempt.metadataPath);
			if (!metadata) continue;
			const exitCode = metadata.exitCode;
			if (typeof exitCode !== "number" || exitCode === -2) continue;
			const at = typeof metadata.timestamp === "number" ? metadata.timestamp : now();
			const eventMetadata = {
				...(attempt.childRunId ? { childRunId: attempt.childRunId } : {}),
				...(typeof metadata.launchContractDigest === "string" || attempt.launchContractDigest ? { launchContractDigest: typeof metadata.launchContractDigest === "string" ? metadata.launchContractDigest : attempt.launchContractDigest } : {}),
				...(typeof metadata.model === "string" || attempt.model ? { model: typeof metadata.model === "string" ? metadata.model : attempt.model } : {}),
			};
			// Judged on envelope validity, not on a clean exit code. A child that wrote a
			// valid envelope and then died on a provider connection error has finished the
			// work, and requiring exitCode === 0 discarded it.
			if (attempt.structuredOutputPath) {
				try {
					const parsed = parseWorkflowResult(readJsonRecord(attempt.structuredOutputPath), node.dataContract);
					next = store.append(next.id, {
						id: `recovery:${attempt.attemptId}:completed`,
						type: "node.completed",
						at,
						nodeId: node.id,
						attemptId: attempt.attemptId,
						...registerCompletion(store, next, node.id, attempt.attemptId, parsed),
						...(exitCode === 0 ? {} : { recoveredFromError: `Child exited with code ${exitCode} after writing a valid result.` }),
						...eventMetadata,
					});
					continue;
				} catch (error) {
					next = store.append(next.id, {
						id: `recovery:${attempt.attemptId}:failed`,
						type: "node.failed",
						at,
						nodeId: node.id,
						attemptId: attempt.attemptId,
						error: `Detached child recovery found invalid structured output: ${error instanceof Error ? error.message : String(error)}`,
						...eventMetadata,
				});
				continue;
			}
			}
			next = store.append(next.id, {
				id: `recovery:${attempt.attemptId}:failed`,
				type: "node.failed",
				at,
				nodeId: node.id,
				attemptId: attempt.attemptId,
				error: typeof metadata.error === "string"
					? metadata.error
					: exitCode === 0
						? "Detached child completed without a recoverable structured output path."
						: `Detached child exited with code ${exitCode}.`,
				...eventMetadata,
			});
		}
		return next;
	};
	const projectRun = (ctx: ExtensionContext, run: WorkflowRun, evaluation: WorkflowEvaluation): { projection: WorkflowTodoProjection; result?: WorkflowTodoAdapterResult } => {
		const projection = buildWorkflowTodoProjection(run, evaluation, ctx.sessionManager.getBranch(), options.hasTool?.("todo") === true);
		const result = options.applyTodoProjection?.(projection, ctx.sessionManager.getSessionId());
		options.onRunChanged?.(run);
		return { projection, ...(result ? { result } : {}) };
	};
	const resultFor = (
		ctx: ExtensionContext,
		run: WorkflowRun,
		evaluation: WorkflowEvaluation,
		text: string,
		extra: Omit<WorkflowControllerDetails, "run" | "evaluation" | "todoProjection" | "view"> = {},
	): WorkflowControllerResult => {
		const { projection: todoProjection, result: todoResult } = projectRun(ctx, run, evaluation);
		const projectionText = todoProjection.operations.length > 0 && todoResult?.supported !== true
			? `\n\nTodo projection operations: call the existing todo tool with each operation in order. Workflow state remains authoritative.\n${JSON.stringify(todoProjection.operations)}`
			: "";
		return {
			text: `${text}${projectionText}`,
			details: { run, evaluation, todoProjection, ...extra },
		};
	};
	const recoverOrphanedAttempts = (store: WorkflowStore, run: WorkflowRun): WorkflowRun => {
		if (activeRuns.has(run.id) || (run.status !== "active" && run.status !== "paused")) return run;
		let next = run;
		for (const node of Object.values(run.nodes)) {
			const attempt = node.attempts.at(-1);
			if (node.status !== "running" || !attempt || attempt.status !== "running") continue;
			next = store.append(next.id, {
				id: `recovery:${attempt.attemptId}`,
				type: "node.failed",
				at: now(),
				nodeId: node.id,
				attemptId: attempt.attemptId,
				error: "Parent Pi runtime restarted before the child returned a terminal result; retry is allowed.",
			});
		}
		return next;
	};
	const qualityDetails = (store: WorkflowStore, run: WorkflowRun): Pick<WorkflowControllerDetails, "qualityReport" | "qualityReportPath"> => {
		const artifactStore = createLocalWorkflowArtifactStore(store.paths(run.id).artifacts);
		const cwd = path.resolve(run.cwd);
		const artifactsDir = path.resolve(store.paths(run.id).artifacts);
		const validateLocalEvidence = (reference: string): boolean => {
			let candidate = reference;
			try {
				if (reference.startsWith("file:")) candidate = new URL(reference).pathname;
			} catch {
				return false;
			}
			const resolved = path.resolve(cwd, candidate);
			const inAllowedRoot = resolved === cwd
				|| resolved.startsWith(`${cwd}${path.sep}`)
				|| resolved === artifactsDir
				|| resolved.startsWith(`${artifactsDir}${path.sep}`);
			if (!inAllowedRoot) return false;
			try {
				return fs.statSync(resolved).isFile();
			} catch {
				return false;
			}
		};
		const qualityReport = assessWorkflowQuality(run, undefined, {
			readArtifact: (descriptor) => artifactStore.read(descriptor).toString("utf8"),
			validateLocalEvidence,
		});
		const qualityReportPath = path.join(store.paths(run.id).bundles, "quality-report.json");
		writeAtomicJson(qualityReportPath, qualityReport);
		return { qualityReport, qualityReportPath };
	};
	/** Persist the best available final draft so an auto-stopped run leaves a usable artifact. */
	const preserveDraft = (store: WorkflowStore, run: WorkflowRun): string | undefined => {
		const editor = finalAcceptedEditor(run)
			?? Object.values(run.nodes).filter((node) => node.kind === "editor").at(-1);
		if (!editor) return undefined;
		const resolved = editor.outputs?.document ?? editor.attempts.at(-1)?.outputs?.document;
		if (!resolved) return undefined;
		let markdown: string | undefined;
		try {
			if (resolved.kind === "artifact") {
				markdown = createLocalWorkflowArtifactStore(store.paths(run.id).artifacts).read(resolved.artifact).toString("utf8");
			} else if (resolved.kind === "inline" && typeof resolved.value === "string") {
				markdown = resolved.value;
			}
		} catch {
			return undefined;
		}
		if (!markdown || !markdown.trim()) return undefined;
		const draftPath = path.join(store.paths(run.id).delivery, "final.draft.md");
		writeAtomicTextFile(draftPath, markdown);
		return draftPath;
	};
	const resolveRun = (ctx: ExtensionContext, runId: string | undefined): { store: WorkflowStore; run: WorkflowRun } => {
		const binding = latestBinding(ctx);
		const resolvedRunId = runId ?? binding?.runId;
		if (!resolvedRunId) throw new Error("No workflow is bound to the current session. Start one with action='start'.");
		const store = storeFor(ctx.cwd);
		let run = store.load(resolvedRunId);
		const currentBinding: WorkflowBinding = {
			version: 0,
			runId: run.id,
			revision: run.revision,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			branch: resolveBranch(ctx.cwd),
		};
		assertWorkflowBinding(run, currentBinding);
		if (binding?.runId === run.id && binding.revision > run.revision) {
			throw new Error(`Session workflow binding revision ${binding.revision} is ahead of stored revision ${run.revision}.`);
		}
		const recovered = reconcileForegroundCompletions(store, recoverWaitingAttempts(store, recoverOrphanedAttempts(store, run)));
		if (recovered.revision !== run.revision) {
			run = recovered;
			persistBinding(run);
		}
		return { store, run };
	};

	return {
		current(ctx) {
			const binding = latestBinding(ctx);
			if (!binding) return undefined;
			const store = storeFor(ctx.cwd);
			let run = store.load(binding.runId);
			assertWorkflowBinding(run, binding);
			const currentIdentity = { ...binding, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, branch: resolveBranch(ctx.cwd) };
			assertWorkflowBinding(run, currentIdentity);
			const recovered = reconcileForegroundCompletions(store, recoverWaitingAttempts(store, recoverOrphanedAttempts(store, run)));
			if (recovered.revision !== run.revision) {
				run = recovered;
				persistBinding(run);
			}
			return run;
		},
		recover(ctx) {
			return this.current(ctx);
		},
		handleForegroundCompletion(ctx, value) {
			const completion = parseForegroundCompletion(value);
			if (!completion) return undefined;
			pendingForegroundCompletions.set(completion.runId, completion);
			while (pendingForegroundCompletions.size > 256) {
				const oldest = pendingForegroundCompletions.keys().next().value;
				if (typeof oldest !== "string") break;
				pendingForegroundCompletions.delete(oldest);
			}
			const binding = latestBinding(ctx);
			if (binding && activeRuns.has(binding.runId)) return undefined;
			return this.current(ctx);
		},
		requestContinuation(ctx, trigger) {
			const run = this.current(ctx) as WorkflowRun | undefined;
			if (!run || run.status !== "active") return undefined;
			const evaluation = evaluateWorkflow(run);
			if (evaluation.running > 0 || evaluation.waiting > 0 || evaluation.nextAction === "complete") return undefined;
			const signature = createHash("sha256").update(JSON.stringify({
				status: run.status,
				nodes: Object.values(run.nodes).sort((left, right) => left.id.localeCompare(right.id)).map((node) => ({
					id: node.id,
					status: node.status,
					attempt: node.attempts.at(-1)?.status ?? "none",
					decision: node.decision ?? null,
				})),
				decisions: run.decisions.map((decision) => decision.id),
				nextAction: evaluation.nextAction,
			})).digest("hex");
			const attempt = run.continuation?.signature === signature ? run.continuation.attempts + 1 : 1;
			if (attempt > 3) return { run, evaluation, attempt, suppressed: true };
			const store = storeFor(ctx.cwd);
			const next = store.append(run.id, {
				id: `continuation:${signature}:${attempt}`,
				type: "workflow.continuation_requested",
				at: now(),
				signature,
				attempt,
				trigger,
			});
			persistBinding(next);
			const nextEvaluation = evaluateWorkflow(next);
			const { projection: todoProjection, result: todoResult } = projectRun(ctx, next, nextEvaluation);
			return {
				run: next,
				evaluation: nextEvaluation,
				attempt,
				suppressed: false,
				prompt: [
					`Continue workflow ${next.id} as its Supervisor.`,
					`The durable run is active and its next action is '${evaluation.nextAction}'.`,
					workflowLanguageInstruction(workflowRunLanguage(next)),
					"Inspect workflow status/evaluation, execute only the next bounded transition, and preserve explicit acceptance, gaps, conflicts, and user decisions.",
					...(nextEvaluation.exhausted > 0 ? ["One or more nodes exhausted their persisted attempt ceiling. Do not call run_ready for them. Inspect retained output first, then adjudicate, supersede with one bounded replacement, or stop."] : []),
					formatWorkflowRepairGuidance(buildWorkflowRepairGuidance(next, nextEvaluation)),
					...(todoProjection.operations.length > 0 && todoResult?.supported !== true ? [`Synchronize these workflow projections through the existing todo tool before continuing: ${JSON.stringify(todoProjection.operations)}`] : []),
				].join("\n\n"),
			};
		},
		async execute(params, ctx, signal, onProgress?: (run: WorkflowRun) => void) {
			if (params.action === "start") {
				if (!params.goal.trim()) throw new Error("Workflow goal must not be blank.");
				const store = storeFor(ctx.cwd);
				const mode = params.mode ?? "general";
				const language = resolveWorkflowLanguage(params.goal, params.language ?? options.defaultLanguage ?? "auto");
				const policy = params.policy ? resolveWorkflowPolicy(mode, params.policy) : undefined;
				const codingContract = params.codingStage ? buildCodingContract(params.codingStage) : undefined;
				const run = store.create({
					id: createRunId(),
					mode,
					goal: params.goal,
					language,
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					branch: resolveBranch(ctx.cwd),
					at: now(),
					...(policy ? { policy } : {}),
					...(codingContract ? { codingContract } : {}),
					maxNodeAttempts,
					...(params.maxNodes !== undefined ? { maxNodes: params.maxNodes } : {}),
				});
				persistBinding(run);
				const evaluation = evaluateWorkflow(run);
				const guidance = run.mode === "deep-research"
					? `Started workflow ${run.id} in deep-research mode. Analyze the request first; use clarify for material ambiguity, then persist set_brief before planning.`
					: `Started workflow ${run.id} in ${run.mode} mode. Apply a plan before execution.`;
				return resultFor(ctx, run, evaluation, guidance);
			}

			const { store, run } = resolveRun(ctx, params.runId);
			switch (params.action) {
				case "clarify": {
					if (run.mode !== "deep-research") throw new Error("Interactive research clarification is only supported in deep-research mode.");
					if (!ctx.hasUI) throw new Error("Interactive clarification requires Pi TUI/RPC UI. Ask the questions in chat and stop until the user answers.");
					if (params.questions.length < 1 || params.questions.length > 5) throw new Error("Interactive clarification requires 1-5 questions.");
					const questionIds = new Set<string>();
					for (const question of params.questions) {
						if (!question.id.trim() || !question.prompt.trim()) throw new Error("Clarification question ids and prompts must not be blank.");
						if (questionIds.has(question.id)) throw new Error(`Duplicate clarification question '${question.id}'.`);
						questionIds.add(question.id);
						if (question.options.length < 2 || question.options.length > 6) throw new Error(`Clarification question '${question.id}' must provide 2-6 choices.`);
						const normalizedOptions = question.options.map((option) => option.label.trim());
						if (normalizedOptions.some((option) => !option) || new Set(normalizedOptions).size !== normalizedOptions.length) {
							throw new Error(`Clarification question '${question.id}' choices must be non-blank and unique.`);
						}
					}
					if (signal?.aborted) throw signal.reason ?? new Error("Clarification aborted.");
					const clarification = await collectWorkflowClarification(ctx, params.questions, workflowRunLanguage(run));
					if (!clarification || clarification.cancelled || clarification.answers.length !== params.questions.length) {
						return {
							text: "Clarification cancelled. Do not apply a plan; wait for the user to restart or clarify the request.",
							details: { run, evaluation: evaluateWorkflow(run), clarification: { cancelled: true } },
						};
					}
					const answers: WorkflowClarificationRound["answers"] = clarification.answers;
					const round: WorkflowClarificationRound = { version: 0, answers };
					const next = store.append(run.id, { id: createEventId(), type: "workflow.clarification_recorded", at: now(), round });
					persistBinding(next);
					return {
						text: [
							"Human clarification completed through Pi's native UI.",
							...answers.map((answer) => `- ${answer.prompt}: ${answer.answer}`),
							"Now call set_brief with clarification=confirmed. Do not call apply_plan before set_brief succeeds.",
						].join("\n"),
						details: { run: next, evaluation: evaluateWorkflow(next), clarification: { cancelled: false, round } },
					};
				}
				case "set_brief": {
					if (run.mode !== "deep-research") throw new Error("Research briefs are only supported in deep-research mode.");
					const next = store.append(run.id, { id: createEventId(), type: "workflow.brief_set", at: now(), brief: params.brief });
					persistBinding(next);
					return resultFor(ctx, next, evaluateWorkflow(next), `Research brief recorded for ${next.id}. Build and confirm the detailed outline next.`);
				}
				case "set_outline": {
					if (run.mode !== "deep-research") throw new Error("Document outlines are only supported in deep-research mode.");
					if (!run.researchBrief) throw new Error("Record the research brief before setting the document outline.");
					if (params.outline.approval === "user") {
						if (!ctx.hasUI) {
							return {
								text: "Outline not recorded. User approval requires Pi TUI/RPC UI; present the outline in chat and stop until the user explicitly approves or requests changes.",
								details: { run, evaluation: evaluateWorkflow(run), outlineReview: { cancelled: false, approved: false } },
							};
						}
						if (signal?.aborted) throw signal.reason ?? new Error("Outline review aborted.");
						const review = await collectWorkflowOutlineReview(ctx, params.outline, workflowRunLanguage(run));
						if (!review || review.cancelled) {
							return {
								text: "Outline review cancelled. The outline was not recorded and document-production planning remains blocked.",
								details: { run, evaluation: evaluateWorkflow(run), outlineReview: { cancelled: true, approved: false } },
							};
						}
						if (!review.approved) {
							return {
								text: [
									"Outline changes requested. The outline was not recorded.",
									`User feedback: ${review.feedback ?? "Revise the outline."}`,
									"Revise the detailed outline, then call set_outline with approval=user again. Do not apply document-production nodes yet.",
								].join("\n"),
								details: { run, evaluation: evaluateWorkflow(run), outlineReview: review },
							};
						}
					}
					const next = store.append(run.id, { id: createEventId(), type: "workflow.outline_set", at: now(), outline: params.outline });
					persistBinding(next);
					return resultFor(ctx, next, evaluateWorkflow(next), `Document outline recorded for ${next.id}: ${params.outline.sections.length} sections across ${new Set(params.outline.sections.map((section) => section.writerNodeId)).size} Writer nodes.`);
				}
				case "apply_plan": {
					assertDeepResearchCompletionContracts(run.mode, params.workUnits);
					assertDeepResearchEditorLineage(run, params.workUnits);
					const persistedCodingContract = codingWorkflowContract(run);
					const codingContract = persistedCodingContract
						?? params.workUnits.map((node) => ({ ...run, nodes: { ...run.nodes, [node.id]: { ...node, status: "pending" as const, attempts: [] } } })).map(codingWorkflowContract).find((value) => value !== undefined);
					if (codingContract?.approvalGateNodeId && !dependencyIsAccepted(run.nodes, codingContract.approvalGateNodeId)) {
						const combinedNodes = Object.fromEntries([
							...Object.entries(run.nodes),
							...params.workUnits.map((node) => [node.id, node] as const),
						]);
						const isInitialPlan = Object.keys(run.nodes).length === 0;
						for (const node of params.workUnits) {
							if (codingContract.preApprovalAgents.includes(node.agentSpec.baseAgent)) {
								const denied = new Set(node.agentSpec.denyTools ?? []);
								if (
									node.agentSpec.extraTools?.length
									|| !denied.has("bash")
									|| !denied.has("edit")
									|| !denied.has("write")
									|| !node.dataContract.annotations?.[CODING_PREAPPROVAL_READONLY_ANNOTATION]
								) {
									throw new Error(`Pre-approval Coding work unit '${node.id}' must deny bash/edit/write, grant no extra tools, and require effective read-only preflight.`);
								}
								continue;
							}
							if (isInitialPlan) continue;
							if (persistedCodingContract) {
								throw new Error(`Coding work unit '${node.id}' cannot be added before approval; only read-only planning repair is allowed.`);
							}
							if (!dependsOnGate(node.id, codingContract.approvalGateNodeId, combinedNodes)) {
								throw new Error(`Coding work unit '${node.id}' must depend on approval gate '${codingContract.approvalGateNodeId}' before it can be added.`);
							}
						}
					}
					if (run.mode === "deep-research" && !run.researchBrief) {
						const evaluation = evaluateWorkflow(run);
						return resultFor(
							ctx,
							run,
							evaluation,
							"Plan not applied. Collect ambiguous requirements with clarify, then persist them with set_brief before planning.",
						);
					}
					const includesDocumentProduction = params.workUnits.some((node) => node.kind === "section-writer" || node.kind === "writer" || node.kind === "editor" || node.kind === "reviewer");
					if (run.mode === "deep-research" && includesDocumentProduction && !run.documentOutline) {
						const evaluation = evaluateWorkflow(run);
						return resultFor(
							ctx,
							run,
							evaluation,
							"Plan not applied. Confirm and persist the detailed outline with set_outline before planning section writing, editing, or review nodes.",
						);
					}
					const next = store.append(run.id, { id: createEventId(), type: "workflow.plan_applied", at: now(), tasks: params.tasks, workUnits: params.workUnits });
					persistBinding(next);
					const evaluation = evaluateWorkflow(next);
					return resultFor(ctx, next, evaluation, statusText(next, evaluation));
				}
				case "run_ready": {
					if (run.status !== "active") throw new Error(`Workflow '${run.id}' is ${run.status}; only active workflows can schedule nodes.`);
					const codingContract = codingWorkflowContract(run);
					if (codingContract?.approvalGateNodeId && !dependencyIsAccepted(run.nodes, codingContract.approvalGateNodeId)) {
						for (const node of Object.values(run.nodes).filter((candidate) => candidate.status === "ready")) {
							if (codingContract.preApprovalAgents.includes(node.agentSpec.baseAgent)) {
								const denied = new Set(node.agentSpec.denyTools ?? []);
								if (
									node.agentSpec.extraTools?.length
									|| !denied.has("bash")
									|| !denied.has("edit")
									|| !denied.has("write")
									|| !node.dataContract.annotations?.[CODING_PREAPPROVAL_READONLY_ANNOTATION]
								) throw new Error(`Coding planning work unit '${node.id}' cannot run without effective read-only preflight.`);
								continue;
							}
							if (!dependsOnGate(node.id, codingContract.approvalGateNodeId, run.nodes)) {
								throw new Error(`Coding work unit '${node.id}' cannot run before approval gate '${codingContract.approvalGateNodeId}' is accepted.`);
							}
						}
					}
					const persistedMaxNodeAttempts = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
					const requestedNode = params.nodeId ? run.nodes[params.nodeId] : undefined;
					if (params.nodeId && !requestedNode) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (requestedNode && requestedNode.status !== "failed" && requestedNode.status !== "cancelled") {
						throw new Error(`Workflow node '${requestedNode.id}' is ${requestedNode.status}; nodeId on run_ready is only for explicit failed/cancelled retries.`);
					}
					if (requestedNode && workflowNodeAttemptsExhausted(requestedNode, persistedMaxNodeAttempts)) {
						throw new Error(`Workflow node '${requestedNode.id}' reached its ${persistedMaxNodeAttempts}-attempt ceiling. Inspect retained output, then reopen it (action=reopen) to grant more attempts, replace it (add a work unit with replaces='${requestedNode.id}'), or reject it.`);
					}
					const requestedFailure = requestedNode?.attempts.at(-1)?.failure;
					if (requestedNode && requestedFailure?.retryable === false) {
						throw new Error(`Workflow node '${requestedNode.id}' failed with ${requestedFailure.failureClass} and cannot be retried in place. ${requestedFailure.suggestedAction} To change model/provider, add a same-kind work unit with replaces='${requestedNode.id}' and an explicit agentSpec.model; the old node remains pinned to its recorded model.`);
					}
					const readyNodes = Object.values(run.nodes).filter((node) => node.status === "ready");
					const exhaustedNodes = Object.values(run.nodes).filter((node) => workflowNodeAttemptsExhausted(node, persistedMaxNodeAttempts));
					if (!requestedNode && readyNodes.length === 0 && exhaustedNodes.length > 0) {
						throw new Error(`Workflow node attempt ceiling ${persistedMaxNodeAttempts} reached for: ${exhaustedNodes.map((node) => node.id).join(", ")}. Supervisor intervention required: inspect retained structured output/artifacts first, then reopen (grant more attempts), replace (add a work unit with replaces=<id>), or reject each exhausted node. The exhausted nodes will not be retried automatically.`);
					}
					if (!requestedNode && readyNodes.length === 0) {
						const retryable = Object.values(run.nodes).filter((node) => (node.status === "failed" || node.status === "cancelled") && node.attempts.at(-1)?.failure?.retryable !== false && !workflowNodeAttemptsExhausted(node, persistedMaxNodeAttempts));
						if (retryable.length > 0) throw new Error(`No ready workflow nodes. Retry one failed/cancelled node explicitly with nodeId: ${retryable.map((node) => node.id).join(", ")}.`);
						const nonRetryable = Object.values(run.nodes).filter((node) => node.status === "failed" && node.attempts.at(-1)?.failure?.retryable === false);
						if (nonRetryable.length > 0) throw new Error(`No ready workflow nodes. Non-retryable failures require replacement or provider remediation: ${nonRetryable.map((node) => `${node.id} (${node.attempts.at(-1)?.failure?.failureClass})`).join(", ")}.`);
					}
					const scheduler = createWorkflowScheduler({
						store,
						adapter: options.adapter,
						now,
						maxConcurrency,
						runtime: {
							parentModel: normalizeParentModel(ctx.model),
							availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
						},
						onTransition: (transitioned) => {
							persistBinding(transitioned);
							projectRun(ctx, transitioned, evaluateWorkflow(transitioned));
							onProgress?.(transitioned);
						},
					});
					if (activeRuns.has(run.id)) throw new Error(`Workflow '${run.id}' is already scheduling nodes.`);
					const runController = new AbortController();
					const abortFromCaller = (): void => runController.abort(signal?.reason);
					signal?.addEventListener("abort", abortFromCaller, { once: true });
					activeRuns.set(run.id, runController);
					activeSchedulers.set(run.id, scheduler);
					let next: WorkflowRun;
					try {
						next = await scheduler.runReady(run.id, {
							concurrency: params.concurrency,
							signal: runController.signal,
							...(params.nodeId ? { nodeIds: [params.nodeId], retryNodeIds: [params.nodeId] } : run.repairPlanNodeIdsAfterStop?.length ? { nodeIds: run.repairPlanNodeIdsAfterStop } : {}),
						});
					} finally {
						signal?.removeEventListener("abort", abortFromCaller);
						activeRuns.delete(run.id);
						activeSchedulers.delete(run.id);
					}
					next = reconcileForegroundCompletions(store, next);
					persistBinding(next);
					const evaluation = evaluateWorkflow(next);
					return resultFor(ctx, next, evaluation, statusText(next, evaluation, true));
				}
				case "evaluate": {
					const evaluation = evaluateWorkflow(run);
					const bundle = {};
					const quality = qualityDetails(store, run);
					const guidance = guidanceDetails(run, evaluation);
					return resultFor(
						ctx,
						run,
						evaluation,
						[
							statusText(run, evaluation, true),
											`Quality: ${quality.qualityReport?.score}/100 (${quality.qualityReport?.releaseReady ? "ready" : "blocked"})`,
							quality.qualityReport?.searchBenchmark
								? `Search benchmark: ${quality.qualityReport.searchBenchmark.score}/100 (support ${quality.qualityReport.searchBenchmark.claimSupportRate.toFixed(2)}, unsupported ${quality.qualityReport.searchBenchmark.unsupportedClaimRate.toFixed(2)}, diversity ${quality.qualityReport.searchBenchmark.sourceDiversity.toFixed(2)})`
								: undefined,
							guidance.guidanceText,
						].filter(Boolean).join("\n\n"),
						{ ...quality, repairGuidance: guidance.repairGuidance },
					);
				}
				case "quality": {
					const evaluation = evaluateWorkflow(run);
					const quality = qualityDetails(store, run);
					const guidance = guidanceDetails(run, evaluation);
					return resultFor(ctx, run, evaluation, `${formatWorkflowQualityReport(quality.qualityReport!, quality.qualityReportPath)}\n\n${guidance.guidanceText}`, { ...quality, repairGuidance: guidance.repairGuidance });
				}
				case "get_result": {
					const node = run.nodes[params.nodeId];
					if (!node) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (!node.result) throw new Error(`Workflow node '${params.nodeId}' has no completed result.`);
					const evaluation = evaluateWorkflow(run);
					return resultFor(ctx, run, evaluation, JSON.stringify({ nodeId: node.id, status: node.status, decision: node.decision, result: node.result, attempts: node.attempts }, null, 2));
				}
				case "cancel_node": {
					const node = run.nodes[params.nodeId];
					if (!node) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (run.status !== "active" && run.status !== "paused") throw new Error(`Workflow '${run.id}' is ${run.status}; node cancellation requires an active or paused workflow.`);
					if (node.status === "accepted" || node.status === "superseded" || node.status === "rejected") {
						throw new Error(`Workflow node '${node.id}' is ${node.status}; already adjudicated nodes cannot be cancelled.`);
					}
					if (node.status === "running") {
						if (!activeSchedulers.get(run.id)?.cancelNode(node.id)) throw new Error(`Workflow node '${node.id}' is running but has no cancellable scheduler attempt.`);
						const evaluation = evaluateWorkflow(run);
						return resultFor(ctx, run, evaluation, `Cancellation requested for workflow node '${node.id}'. The node will remain in its attempt history as cancelled.`);
					}
					const attempt = node.attempts.at(-1);
					// Waiting node with a live detached child: try to deliver an interrupt.
					if (node.status === "waiting" && attempt && attempt.status === "waiting") {
						let cancelDelivered = false;
						try {
							cancelDelivered = Boolean(attempt.childRunId && options.cancelWaitingChild?.(attempt.childRunId));
						} catch {
							cancelDelivered = false;
						}
						const next = store.append(run.id, {
							id: createEventId(),
							type: "node.cancelled",
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: cancelDelivered
								? "Node cancelled; interrupt delivered to the detached child."
								: "Node cancelled; detached child was no longer interruptible in this runtime.",
							...(attempt.childRunId ? { childRunId: attempt.childRunId } : {}),
							...(attempt.launchContractDigest ? { launchContractDigest: attempt.launchContractDigest } : {}),
							...(attempt.model ? { model: attempt.model } : {}),
							...(attempt.usage ? { usage: attempt.usage } : {}),
						});
						persistBinding(next);
						const evaluation = evaluateWorkflow(next);
						return resultFor(ctx, next, evaluation, statusText(next, evaluation));
					}
					// Pending/ready/failed/cancelled nodes: record a new cancelled attempt
					// so the node reaches a terminal state and becomes eligible for replaces
					// or supersession. This resolves the pending-blocked deadlock where a
					// dependency was rejected but the downstream node could not transition.
					if (node.status === "pending" || node.status === "ready" || node.status === "failed" || node.status === "cancelled") {
						const syntheticAttemptId = `${node.id}:cancel-${node.attempts.length + 1}`;
						const next = store.append(run.id, {
							id: createEventId(),
							type: "node.cancelled",
							at: now(),
							nodeId: node.id,
							attemptId: syntheticAttemptId,
							error: `Supervisor cancelled ${node.status} node to unblock workflow.`,
						});
						persistBinding(next);
						const evaluation = evaluateWorkflow(next);
						return resultFor(ctx, next, evaluation, statusText(next, evaluation));
					}
					throw new Error(`Workflow node '${node.id}' is ${node.status}; cannot cancel.`);
				}
				case "update_node": {
					if (run.status !== "active" && run.status !== "paused") throw new Error(`Workflow '${run.id}' is ${run.status}; node updates require an active or paused workflow.`);
					const node = run.nodes[params.nodeId];
					if (!node) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (node.status !== "pending" && node.status !== "ready") {
						throw new Error(`Workflow node '${node.id}' is ${node.status}; only pending or ready nodes can be updated.`);
					}
					const patch: Partial<{ label: string; objective: string; instructions: string; acceptance: string }> = {};
					if (params.label !== undefined) patch.label = params.label;
					if (params.objective !== undefined) patch.objective = params.objective;
					if (params.instructions !== undefined) patch.instructions = params.instructions;
					if (params.acceptance !== undefined) patch.acceptance = params.acceptance;
					if (Object.keys(patch).length === 0) throw new Error("update_node requires at least one of: label, objective, instructions, acceptance.");
					const next = store.append(run.id, { id: createEventId(), type: "workflow.node_updated", at: now(), nodeId: node.id, patch });
					const evaluation = evaluateWorkflow(next);
					return resultFor(ctx, next, evaluation, `Node '${node.id}' updated: ${Object.keys(patch).join(", ")}.`);
				}
				case "accept":
				case "reject": {
					if (!params.decision.trim()) throw new Error("Workflow decision must not be blank.");
					const node = run.nodes[params.nodeId];
					if (!node) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (params.action === "accept") await requireCodingImplementationApproval(run, node.id, ctx);
					const next = store.append(run.id, {
						id: createEventId(),
						type: params.action === "accept" ? "node.accepted" : "node.rejected",
						at: now(),
						nodeId: params.nodeId,
						decision: params.decision,
					});
					persistBinding(next);
					const evaluation = evaluateWorkflow(next);
					return resultFor(ctx, next, evaluation, statusText(next, evaluation));
				}
				case "supersede": {
					if (!params.decision.trim()) throw new Error("Workflow supersession decision must not be blank.");
					await requireCodingImplementationApproval(run, params.nodeId, ctx, { replacementNodeId: params.replacementNodeId });
					const next = store.append(run.id, {
						id: createEventId(),
						type: "node.superseded",
						at: now(),
						nodeId: params.nodeId,
						replacementNodeId: params.replacementNodeId,
						decision: params.decision,
					});
					fs.rmSync(path.join(store.paths(run.id).bundles, "quality-gate-failures.json"), { force: true });
					const repaired = run.status === "stopped"
						? store.append(run.id, { id: createEventId(), type: "workflow.status_changed", at: now(), status: "active" })
						: next;
					persistBinding(repaired);
					const evaluation = evaluateWorkflow(repaired);
					return resultFor(ctx, repaired, evaluation, statusText(repaired, evaluation));
				}
				case "reopen": {
					if (!params.decision.trim()) throw new Error("Workflow reopen decision must not be blank.");
					const node = run.nodes[params.nodeId];
					if (!node) throw new Error(`Unknown workflow node '${params.nodeId}'.`);
					if (node.status !== "failed" && node.status !== "cancelled") {
						throw new Error(`Workflow node '${params.nodeId}' is ${node.status}; only failed or cancelled nodes can be reopened.`);
					}
					const reopened = store.append(run.id, {
						id: createEventId(),
						type: "node.reopened",
						at: now(),
						nodeId: params.nodeId,
						...(params.additionalAttempts !== undefined ? { additionalAttempts: params.additionalAttempts } : {}),
						decision: params.decision,
					});
					// Mirror supersede: a run stopped after exhaustion becomes active again so the
					// reopened node can be retried with run_ready nodeId=<node>.
					const repaired = run.status === "stopped"
						? store.append(run.id, { id: createEventId(), type: "workflow.status_changed", at: now(), status: "active" })
						: reopened;
					fs.rmSync(path.join(store.paths(run.id).bundles, "quality-gate-failures.json"), { force: true });
					persistBinding(repaired);
					const evaluation = evaluateWorkflow(repaired);
					return resultFor(ctx, repaired, evaluation, statusText(repaired, evaluation));
				}
				case "record_decision": {
					const next = store.append(run.id, {
						id: createEventId(),
						type: "workflow.decision_recorded",
						at: now(),
						decision: {
							id: createEventId(),
							kind: params.decisionKind,
							target: params.target,
							rationale: params.rationale,
						},
					});
					persistBinding(next);
					const evaluation = evaluateWorkflow(next);
					return resultFor(ctx, next, evaluation, statusText(next, evaluation));
				}
				case "complete": {
					const evaluation = evaluateWorkflow(run);
					const codingContract = codingWorkflowContract(run);
					const codingCompletionNodeId = codingContract ? effectiveWorkflowNodeId(run, codingContract.completionNodeId) : undefined;
					if (codingContract && (params.nodeId !== codingCompletionNodeId || params.port !== codingContract.completionPort)) {
						throw new Error(`Coding stage '${codingContract.stage}' must complete from '${codingCompletionNodeId}.${codingContract.completionPort}', not '${params.nodeId}.${params.port}'.`);
					}
					if (run.mode === "deep-research" && (!evaluation.acceptedKinds.includes("editor") || !evaluation.acceptedKinds.includes("reviewer"))) {
						throw new Error("Deep Research requires accepted editor and reviewer nodes before completion.");
					}
					if (!evaluation.readyToComplete) {
						throw new Error(`Workflow cannot complete; next action is '${evaluation.nextAction}'. Blockers: ${evaluation.completionBlockers.join("; ") || "completion policy is not satisfied"}.`);
					}
					const quality = qualityDetails(store, run);
					if (run.mode === "deep-research" && !quality.qualityReport?.releaseReady) {
						const failureMarker = path.join(store.paths(run.id).bundles, "quality-gate-failures.json");
						const priorFailures = (() => {
							try {
								const record = readJsonRecord(failureMarker) as { count: number; lastBlockers: string[] } | undefined;
								return record?.count ?? 0;
							} catch {
								return 0;
							}
						})();
						const count = priorFailures + 1;
						writeAtomicJson(failureMarker, { count, at: now(), blockers: quality.qualityReport?.blockers ?? [] });
						if (count >= 3) {
							// Preserve the best available draft before auto-stopping so the user has
							// a usable artifact rather than a hard failure with no deliverable.
							const draftPath = preserveDraft(store, run);
							const stopped = store.append(run.id, { id: createEventId(), type: "workflow.status_changed", at: now(), status: "stopped" });
							persistBinding(stopped);
							throw new Error(`Deep Research quality gates failed 3 consecutive times without release. Workflow auto-stopped to avoid burning budget. Last blockers: ${quality.qualityReport?.blockers.join(" ")}${draftPath ? ` Draft preserved at: ${draftPath}` : ""}`);
						}
						throw new Error(`Deep Research quality gates failed (attempt ${count}/3): ${quality.qualityReport?.blockers.join(" ")}`);
					}
					if (!params.nodeId || !params.port || !params.digest) throw new Error("Completion requires nodeId, port, and digest from an accepted output artifact.");
					const sourceNode = run.nodes[params.nodeId];
					if (!sourceNode || sourceNode.status !== "accepted") throw new Error(`Completion source node '${params.nodeId}' must be accepted.`);
					const output = sourceNode.outputs?.[params.port];
					if (!output || output.kind !== "artifact") throw new Error(`Completion source port '${params.nodeId}.${params.port}' must be an artifact output.`);
					if (output.artifact.sha256 !== params.digest) throw new Error(`Completion digest does not match '${params.nodeId}.${params.port}'.`);
					if (output.artifact.encoding !== "utf-8") throw new Error("Completion artifact must be UTF-8 text.");
					const finalMarkdown = createLocalWorkflowArtifactStore(store.paths(run.id).artifacts).read(output.artifact).toString("utf8");
					if (run.mode === "deep-research") {
						const acceptedEditor = evaluation.finalEditorNodeId ? run.nodes[evaluation.finalEditorNodeId] : undefined;
						if (!acceptedEditor?.result) throw new Error("Accepted Deep Research editor returned no result.");
						if (params.nodeId !== acceptedEditor.id) throw new Error("Deep Research completion artifact must come from the final accepted editor node.");
						if (params.port !== "document") throw new Error("Deep Research completion must use the editor's 'document' output port.");
						const editorDocument = acceptedEditor.outputs?.document;
						if (!editorDocument || editorDocument.kind !== "artifact") throw new Error("Deep Research final editor must expose a 'document' artifact output before completion.");
						if (output.artifact.sha256 !== editorDocument.artifact.sha256) {
							throw new Error("Completion artifact must be the accepted editor 'document' output. Repair and re-accept the editor node instead of bypassing it at completion.");
						}
					}
					const finalPath = path.join(store.paths(run.id).delivery, "final.md");
					writeAtomicTextFile(finalPath, finalMarkdown);
					const next = store.append(run.id, { id: createEventId(), type: "workflow.status_changed", at: now(), status: "completed" });
					persistBinding(next);
					return resultFor(ctx, next, evaluateWorkflow(next), `Workflow ${next.id} completed. Final artifact: ${finalPath}`, { finalPath, ...qualityDetails(store, next) });
				}
				case "status": {
					const evaluation = evaluateWorkflow(run);
					const guidance = guidanceDetails(run, evaluation);
					return resultFor(ctx, run, evaluation, `${statusText(run, evaluation)}\n\n${guidance.guidanceText}`, { repairGuidance: guidance.repairGuidance });
				}
				case "pause":
				case "resume":
				case "stop": {
					if (params.action === "pause" && run.status !== "active") throw new Error(`Workflow '${run.id}' is ${run.status}; only active workflows can pause.`);
					const repairPlanNodeIds = new Set(run.repairPlanNodeIdsAfterStop ?? []);
					const canRestartRepairPlan = run.status === "stopped"
						&& repairPlanNodeIds.size > 0
						&& Object.values(run.nodes).some((node) => repairPlanNodeIds.has(node.id) && node.status === "ready");
					if (params.action === "resume" && run.status !== "paused" && !canRestartRepairPlan) {
						throw new Error(`Workflow '${run.id}' is ${run.status}; only paused workflows or stopped workflows with a new ready repair plan can resume.`);
					}
					if (params.action === "stop" && run.status !== "active" && run.status !== "paused") throw new Error(`Workflow '${run.id}' is ${run.status}; only active or paused workflows can stop.`);
					if (params.action === "stop") {
						activeRuns.get(run.id)?.abort("workflow stopped");
						for (const node of Object.values(run.nodes)) {
							const attempt = node.attempts.at(-1);
							if (node.status !== "waiting" || attempt?.status !== "waiting") continue;
							let cancelDelivered = false;
							try {
								cancelDelivered = Boolean(attempt.childRunId && options.cancelWaitingChild?.(attempt.childRunId));
							} catch {
								cancelDelivered = false;
							}
							store.append(run.id, {
								id: createEventId(),
								type: "node.cancelled",
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: cancelDelivered
									? "Workflow stopped; interrupt delivered to the detached child."
									: "Workflow stopped; detached child was no longer interruptible in this runtime.",
								...(attempt.childRunId ? { childRunId: attempt.childRunId } : {}),
								...(attempt.launchContractDigest ? { launchContractDigest: attempt.launchContractDigest } : {}),
								...(attempt.model ? { model: attempt.model } : {}),
								...(attempt.usage ? { usage: attempt.usage } : {}),
							});
						}
					}
					const status = params.action === "pause" ? "paused" : params.action === "resume" ? "active" : "stopped";
					if (canRestartRepairPlan) {
						fs.rmSync(path.join(store.paths(run.id).bundles, "quality-gate-failures.json"), { force: true });
					}
					const pauseReason = params.action === "pause" && params.reason ? params.reason : undefined;
					const next = store.append(run.id, { id: createEventId(), type: "workflow.status_changed", at: now(), status, ...(pauseReason ? { reason: pauseReason } : {}) });
					persistBinding(next);
					const evaluation = evaluateWorkflow(next);
					if (params.action === "resume" && evaluation.ready > 0) {
						return this.execute({ action: "run_ready", runId: next.id }, ctx, signal);
					}
					return resultFor(ctx, next, evaluation, statusText(next, evaluation));
				}
				default: {
					const exhaustive: never = params;
					return exhaustive;
				}
			}
		},
	};
}
