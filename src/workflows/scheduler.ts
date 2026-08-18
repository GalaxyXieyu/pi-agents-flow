import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SubagentDelegationTerminalResponse } from "../api/delegation.ts";
import { DEFAULT_WORKFLOW_CONCURRENCY } from "../extension/config.ts";
import { classifyWorkflowFailure, type WorkflowFailureContext } from "../runs/shared/model-fallback.ts";
import { materializeWorkflowContextPack } from "./context-pack.ts";
import { effectiveAcceptedResultNodes } from "./effective-nodes.ts";
import { workflowLanguageInstruction, workflowRunLanguage } from "./language.ts";
import { createLocalWorkflowArtifactStore } from "./artifact-store.ts";
import type { WorkflowDelegationAdapter, WorkflowDelegationRuntimeContext } from "./delegation-adapter.ts";
import { resolveWorkflowPolicy } from "./policy.ts";
import { allocateWorkflowOutputSlots, outputRegistrationDiagnostic, registerWorkflowOutputs } from "./output-ports.ts";
import { sectionIsOwnedBy } from "./section-ownership.ts";
import { parseWorkflowResult } from "./result-contract.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import { buildResearchSearchPlan, formatResearchSearchPlan, type ResearchSourcePortfolio } from "./query-strategy.ts";
import type { WorkflowStore } from "./store.ts";
import type { WorkflowAttempt, WorkflowDataContract, WorkflowEvent, WorkflowFailure, WorkflowResult, WorkflowRun } from "./types.ts";

interface CreateWorkflowSchedulerOptions {
	store: WorkflowStore;
	adapter: WorkflowDelegationAdapter;
	now?: () => number;
	onTransition?: (run: WorkflowRun) => void;
	/** Ceiling on children running at once. Clamps whatever the Supervisor requests. */
	maxConcurrency?: number;
	/** Resolved parent session model + registry snapshot for workflow child preflight. */
	runtime?: WorkflowDelegationRuntimeContext;
}

interface RunReadyOptions {
	concurrency?: number;
	signal?: AbortSignal;
	/** Restrict scheduling to an explicit repair-plan subset. */
	nodeIds?: string[];
	/** Explicitly authorize retries for these failed/cancelled nodes. */
	retryNodeIds?: string[];
}

export interface WorkflowScheduler {
	runReady(runId: string, options?: RunReadyOptions): Promise<WorkflowRun>;
	cancelNode(nodeId: string): boolean;
}

function runnable(node: WorkflowRun["nodes"][string], maxNodeAttempts: number, retryRequested: boolean): boolean {
	if (node.status === "ready") return true;
	const lastFailure = node.attempts.at(-1)?.failure;
	return retryRequested
		&& (node.status === "failed" || node.status === "cancelled")
		&& lastFailure?.retryable !== false
		&& !workflowNodeAttemptsExhausted(node, maxNodeAttempts);
}

function outputRegistrationError(error: unknown, node: WorkflowRun["nodes"][string], result: WorkflowResult): string {
	return `Workflow output registration failed: ${JSON.stringify(outputRegistrationDiagnostic(node, result, error))}`;
}

function workflowFailure(error: string, context?: WorkflowFailureContext): WorkflowFailure {
	const classification = classifyWorkflowFailure(error, context);
	return {
		failureClass: classification.failureClass,
		retryable: classification.retryable,
		suggestedAction: classification.suggestedAction,
		...(classification.pauseWorkflow ? { pauseWorkflow: true } : {}),
	};
}

function requestId(runId: string, nodeId: string, attemptNumber: number): string {
	const digest = createHash("sha256").update(`${runId}\0${nodeId}\0${attemptNumber}`).digest("hex");
	return `workflow-${digest}`;
}

const DEFAULT_WAIT_DEADLINE_MS = 30 * 60 * 1000;

/** If the node has a timeoutMs, start a wait deadline from it; otherwise a generous default. */
function waitDeadlineFor(node: WorkflowRun["nodes"][string], at: number): number | undefined {
	const timeoutMs = node.agentSpec.timeoutMs;
	if (timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs > 0) {
		return at + Math.max(timeoutMs, 60_000);
	}
	return at + DEFAULT_WAIT_DEADLINE_MS;
}

/**
 * Read a child's persisted structured output and return it only if it is a valid
 * `WorkflowResult`.
 *
 * Returns undefined for a missing path, unreadable file, malformed JSON, or an
 * envelope that fails validation, so a partial or corrupt write can never be
 * mistaken for a finished result.
 */
function salvageEnvelope(structuredOutputPath: string | undefined, contract: WorkflowDataContract): WorkflowResult | undefined {
	if (!structuredOutputPath) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(structuredOutputPath, "utf-8"));
	} catch {
		return undefined;
	}
	try {
		return parseWorkflowResult(raw, contract);
	} catch {
		return undefined;
	}
}

function trustedSubmissionDirFor(structuredOutputPath: string | undefined): string | undefined {
	return structuredOutputPath ? path.join(path.dirname(structuredOutputPath), "submissions") : undefined;
}

function registeredCompletion(
	store: WorkflowStore,
	run: WorkflowRun,
	node: WorkflowRun["nodes"][string],
	attemptId: string,
	result: WorkflowResult,
	outputSlots?: Record<string, string>,
	trustedSubmissionDir?: string,
): Pick<Extract<WorkflowEvent, { type: "node.completed" }>, "result" | "resultArtifact" | "outputs"> {
	const registered = registerWorkflowOutputs({
		run,
		node,
		attemptId,
		result,
		contract: node.dataContract,
		artifactStore: createLocalWorkflowArtifactStore(store.paths(run.id).artifacts),
		...(outputSlots ? { outputSlots } : {}),
		...(trustedSubmissionDir ? { trustedSubmissionDir } : {}),
	});
	return { result: registered.eventResult, resultArtifact: registered.resultArtifact, outputs: registered.outputs };
}

function terminalMetadata(
	response: SubagentDelegationTerminalResponse,
	launchContractDigest: string | undefined,
): Pick<Extract<WorkflowEvent, { type: "node.completed" }>, "childRunId" | "launchContractDigest" | "model" | "usage" | "structuredOutputPath" | "metadataPath"> {
	return {
		...(response.runId ? { childRunId: response.runId } : {}),
		...(response.launchContractDigest ?? launchContractDigest ? { launchContractDigest: response.launchContractDigest ?? launchContractDigest } : {}),
		...(response.model ? { model: response.model } : {}),
		...(response.usage ? { usage: response.usage } : {}),
		// Recorded on every terminal outcome, including failures. A child that wrote a
		// valid envelope and then lost its connection on a later turn used to have that
		// path dropped here, which made the completed work unrecoverable.
		...(response.structuredOutputPath ? { structuredOutputPath: response.structuredOutputPath } : {}),
		...(response.metadataPath ? { metadataPath: response.metadataPath } : {}),
	};
}

function compactRunContext(run: WorkflowRun): string {
	return [
		`Goal: ${run.goal}`,
		...(run.researchBrief
			? [
					`Audience: ${run.researchBrief.audience}`,
					`Purpose: ${run.researchBrief.purpose}`,
					`Scope: ${run.researchBrief.scope}`,
					`Required topics: ${run.researchBrief.requiredTopics.join("; ") || "none"}`,
					`Excluded topics: ${run.researchBrief.excludedTopics.join("; ") || "none"}`,
					`Constraints: ${run.researchBrief.constraints.join("; ") || "none"}`,
				]
			: []),
		...(run.documentOutline
			? [
					`Title: ${run.documentOutline.title}`,
					`Thesis: ${run.documentOutline.thesis}`,
					...run.documentOutline.sections.map((section) => `- ${section.id} (${section.title}; ~${section.targetWords} words): ${section.objective}`),
				]
			: []),
		...(run.decisions.length > 0 ? ["Supervisor decisions:", ...run.decisions.map((decision) => `- ${decision.kind}: ${decision.target} — ${decision.rationale}`)] : []),
	].join("\n");
}

function withLegacyDependencyOutputs(store: WorkflowStore, run: WorkflowRun, node: WorkflowRun["nodes"][string]): WorkflowRun {
	const artifactStore = createLocalWorkflowArtifactStore(store.paths(run.id).artifacts);
	let changed = false;
	const nodes = { ...run.nodes };
	for (const dependencyId of node.dependsOn) {
		const dependency = nodes[dependencyId];
		if (!dependency?.result || dependency.outputs) continue;
		const attemptId = dependency.attempts.at(-1)?.attemptId ?? `${dependency.id}:legacy`;
		const registered = registerWorkflowOutputs({
			run,
			node: dependency,
			attemptId,
			result: dependency.result,
			contract: dependency.dataContract,
			artifactStore,
			...(trustedSubmissionDirFor(dependency.attempts.at(-1)?.structuredOutputPath) ? { trustedSubmissionDir: trustedSubmissionDirFor(dependency.attempts.at(-1)?.structuredOutputPath) } : {}),
		});
		nodes[dependencyId] = { ...dependency, resultArtifact: registered.resultArtifact, outputs: registered.outputs };
		changed = true;
	}
	return changed ? { ...run, nodes } : run;
}

function withWorkflowContext(store: WorkflowStore, run: WorkflowRun, node: WorkflowRun["nodes"][string], outputSlots: Record<string, string> = {}): WorkflowRun["nodes"][string] {
	const contextRun = withLegacyDependencyOutputs(store, run, node);
	const contextNode = contextRun.nodes[node.id] ?? node;
	const contract = contextNode.dataContract;
	const policy = resolveWorkflowPolicy(run.mode, run.policy);
	const assignedSections = run.documentOutline?.sections.filter((section) => sectionIsOwnedBy(section, node.id)) ?? [];
	const qualityContract = run.mode === "deep-research" && (node.kind === "editor" || node.kind === "reviewer")
		? [
				"Final-document quality contract (satisfy before returning):",
				...(run.documentOutline?.sections.map((section) => `- Include the exact Markdown heading: ${section.title}`) ?? []),
				`- Final Markdown must meet the approved minimum length of ${run.researchBrief?.targetWords.min ?? 1} words/units without padding.`,
				`- At least ${Math.round(policy.quality.minFinalCitationCoverage * 100)}% of substantive paragraphs must contain an inline Markdown citation.`,
				"- Every final citation URL must already appear in an authorized direct-dependency input; do not invent or substitute URLs.",
				"- Preserve the final editor -> reviewer dependency: the reviewer must review this exact editor draft.",
			]
		: [];
	const accepted = effectiveAcceptedResultNodes(contextRun);
	const searchPlan = run.mode === "deep-research" && (node.kind === "research" || node.kind === "verification")
		? (() => {
				const researchNodes = Object.values(run.nodes).filter((candidate) => candidate.kind === "research");
				const researchIndex = researchNodes.findIndex((candidate) => candidate.id === node.id);
				const portfolios: ResearchSourcePortfolio[] = ["mechanism", "implementation", "operations", "alternatives"];
				return formatResearchSearchPlan(buildResearchSearchPlan({
					goal: run.goal,
					focus: node.agentSpec.objective,
					timeSensitive: /current|latest|recent|version|release|202\d/i.test(`${run.goal} ${node.agentSpec.objective}`),
					gaps: accepted.flatMap((candidate) => candidate.result?.diagnostics.gaps.map((gap) => gap.question) ?? []),
					conflicts: accepted.flatMap((candidate) => candidate.result?.diagnostics.conflicts.map((conflict) => ({ statement: conflict.statement, alternatives: conflict.alternatives })) ?? []),
					sourcePortfolio: node.kind === "research" ? portfolios[Math.max(0, researchIndex) % portfolios.length] : "operations",
				}));
			})()
		: undefined;
	const taskContext = [
		compactRunContext(run),
		workflowLanguageInstruction(workflowRunLanguage(run)),
		...(searchPlan ? [searchPlan] : []),
		...(node.kind === "section-writer"
			? [
					"Assigned outline sections:",
					...assignedSections.map((section) => `- ${section.id} ${section.title}: ${section.objective} (target ${section.targetWords} words; questions: ${section.questions.join("; ")})`),
					"Write only these sections. Preserve their exact Markdown headings so outline coverage can be measured.",
				]
			: []),
		...(node.kind === "editor" ? ["Act as lead editor. Merge only the authorized direct-dependency inputs into one complete document."] : []),
		...(node.kind === "reviewer" ? ["Review only the authorized final editor input. Do not broaden the research scope or call web/search tools by default.", "Always return a valid review result even when the document verdict is fail: the Supervisor should accept a sound review result, then repair or supersede the Editor draft based on its blockers. Reviewer node acceptance means the review was valid, not that the document passed.", "Your structured WorkflowResult MUST contain top-level review:{verdict:'pass'|'fail'}. When review.verdict is pass, it MUST also contain top-level extensions.release={release:true, gapsAccepted?, conflictsAccepted?, citationShortfallAccepted?, lengthShortfallAccepted?, rationale:'non-empty'}; when review.verdict is fail, omit extensions.release. These fields are control data inside the outer structured-output value, never prose or an outputs.result file. The release declaration both approves the final document and relaxes only the explicitly accepted residual gates. Be conservative: only release a gate when you have independently concluded the residual issue does not undermine the deliverable."] : []),
		...qualityContract,
	].join("\n\n");
	const attemptId = node.attempts.at(-1)?.attemptId ?? `${node.id}:pending`;
	const pack = materializeWorkflowContextPack({
		run: contextRun,
		node: contextNode,
		contract,
		outputDir: path.join(store.paths(run.id).bundles, "context-packs", node.id, attemptId.replace(/[^a-zA-Z0-9._-]/g, "_")),
		artifactStore: createLocalWorkflowArtifactStore(store.paths(run.id).artifacts),
		taskContext,
		outputSlots,
	});
	return {
		...node,
		dataContract: contract,
		agentSpec: {
			...node.agentSpec,
			...(run.mode === "deep-research" && (node.kind === "editor" || node.kind === "reviewer") ? { context: "fresh" as const } : {}),
			...(run.mode === "deep-research" && node.kind === "reviewer"
				? { denyTools: [...new Set([...(node.agentSpec.denyTools ?? []), "web_search", "source_check", "fetch_content", "get_search_content"])] }
				: {}),
			instructions: [
				node.agentSpec.instructions,
				`Workflow Context Pack V1: ${pack.instructionsPath}`,
				`Workflow input manifest: ${pack.manifestPath}`,
				"Read the context pack and only the authorized references it names. Do not inspect the workflow directory, global bundles, result envelopes, or parent-session history.",
				...(Object.keys(outputSlots).length
					? [
							"Preallocated output slots (inner outputs[port].kind=file destinations only). Small results stay inline in structured_output.value. For a large port: write the file to the slot first, then report that exact path. Never pass a slot path as the outer tool path, and never report a path you did not write:",
							...Object.entries(outputSlots).map(([port, slotPath]) => `- ${port}: ${slotPath}`),
						]
					: []),
			].join("\n\n"),
			...(run.mode === "deep-research" && node.kind === "reviewer" && node.agentSpec.timeoutMs === undefined ? { timeoutMs: 600_000 } : {}),
			...(run.mode === "deep-research" && node.kind === "reviewer" && !node.agentSpec.turnBudget ? { turnBudget: { maxTurns: 8, graceTurns: 2 } } : {}),
			...(run.mode === "deep-research" && node.kind === "reviewer" && !node.agentSpec.toolBudget ? { toolBudget: { soft: 4, hard: 6, block: "*" as const } } : {}),
		},
	};
}

export function createWorkflowScheduler(options: CreateWorkflowSchedulerOptions): WorkflowScheduler {
	const now = options.now ?? Date.now;
	const nodeControllers = new Map<string, AbortController>();
	const append = (runId: string, event: WorkflowEvent): WorkflowRun => {
		const run = options.store.append(runId, event);
		options.onTransition?.(run);
		return run;
	};
	const fail = (runId: string, event: Omit<Extract<WorkflowEvent, { type: "node.failed" }>, "type" | "failure">, context?: WorkflowFailureContext): WorkflowRun => {
		const failure = workflowFailure(event.error, context);
		let run = append(runId, { ...event, type: "node.failed", failure });
		if (failure.pauseWorkflow && run.status === "active") {
			run = append(runId, {
				id: `${event.id}:pause`,
				type: "workflow.status_changed",
				at: event.at,
				status: "paused",
				reason: `${failure.failureClass} at node '${event.nodeId}'. ${failure.suggestedAction}`,
			});
		}
		return run;
	};
	return {
		cancelNode(nodeId) {
			const controller = nodeControllers.get(nodeId);
			if (!controller) return false;
			controller.abort(`workflow node '${nodeId}' cancelled`);
			return true;
		},
		async runReady(runId, runOptions = {}) {
			const requested = runOptions.concurrency;
			if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
				throw new Error("Workflow concurrency must be an integer >= 1.");
			}
			// The ceiling wins over the Supervisor's request. A plan asking for more
			// parallel children than the provider or machine can absorb otherwise
			// bursts and fails most of them; the extra ready nodes simply queue here.
			const ceiling = options.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY;
			const concurrency = Math.max(1, Math.min(requested ?? ceiling, ceiling));
			const initial = options.store.load(runId);
			if (initial.status !== "active") throw new Error(`Workflow '${runId}' is ${initial.status}; only active workflows can schedule nodes.`);
			const allowedNodeIds = runOptions.nodeIds ? new Set(runOptions.nodeIds) : undefined;
			const retryNodeIds = new Set(runOptions.retryNodeIds ?? []);
			const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(initial.maxNodeAttempts);
			const readyNodeIds = Object.values(initial.nodes)
				.filter((node) => runnable(node, maxNodeAttempts, retryNodeIds.has(node.id)) && (!allowedNodeIds || allowedNodeIds.has(node.id)))
				.map((node) => node.id);
			let cursor = 0;
			const worker = async (): Promise<void> => {
				while (cursor < readyNodeIds.length) {
					if (runOptions.signal?.aborted) return;
					const nodeId = readyNodeIds[cursor++];
					if (!nodeId) return;
					const current = options.store.load(runId);
					if (current.status !== "active") return;
					const node = current.nodes[nodeId];
					if (!node || !runnable(node, maxNodeAttempts, retryNodeIds.has(node.id))) continue;
					const attemptNumber = node.attempts.length + 1;
					const attempt: WorkflowAttempt = {
						attemptId: `${node.id}:${attemptNumber}`,
						requestId: requestId(runId, node.id, attemptNumber),
						number: attemptNumber,
						startedAt: now(),
						status: "running",
					};
					const startedRun = append(runId, {
						id: `${attempt.requestId}:started`,
						type: "node.started",
						at: attempt.startedAt,
						nodeId: node.id,
						attempt: {
							attemptId: attempt.attemptId,
							requestId: attempt.requestId,
							number: attempt.number,
							startedAt: attempt.startedAt,
						},
					});
					const startedNode = startedRun.nodes[node.id];
					if (!startedNode) throw new Error(`Workflow node '${node.id}' disappeared after start.`);
					const outputSlots = allocateWorkflowOutputSlots({
						run: startedRun,
						node: startedNode,
						attemptId: attempt.attemptId,
						contract: startedNode.dataContract,
						artifactStore: createLocalWorkflowArtifactStore(options.store.paths(runId).artifacts),
					});
					const nodeController = new AbortController();
					nodeControllers.set(node.id, nodeController);
					const combinedController = new AbortController();
					const abortCombined = (reason: unknown): void => {
						if (!combinedController.signal.aborted) combinedController.abort(reason);
					};
					const abortParent = (): void => abortCombined(runOptions.signal?.reason);
					const abortNode = (): void => abortCombined(nodeController.signal.reason);
					if (runOptions.signal?.aborted) abortParent();
					else runOptions.signal?.addEventListener("abort", abortParent, { once: true });
					nodeController.signal.addEventListener("abort", abortNode, { once: true });
					let result: Awaited<ReturnType<WorkflowDelegationAdapter["run"]>> | undefined;
					let adapterError: unknown;
					try {
						result = await options.adapter.run(startedRun, withWorkflowContext(options.store, startedRun, startedNode, outputSlots), attempt, combinedController.signal, options.runtime);
					} catch (error) {
						adapterError = error;
					} finally {
						runOptions.signal?.removeEventListener("abort", abortParent);
						nodeController.signal.removeEventListener("abort", abortNode);
						nodeControllers.delete(node.id);
					}
					const nodeAborted = combinedController.signal.aborted;
					if (adapterError !== undefined || !result) {
						const terminalError = adapterError instanceof Error ? adapterError.message : String(adapterError ?? "Workflow adapter returned no result.");
						const failureEvent = {
							id: `${attempt.requestId}:${nodeAborted ? "cancelled" : "failed"}`,
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: terminalError,
						};
						if (nodeAborted) append(runId, { ...failureEvent, type: "node.cancelled" });
						else fail(runId, failureEvent, { stage: "transport" });
						continue;
					}
					if (result.ok === false) {
						const failureEvent = {
							id: `${attempt.requestId}:${nodeAborted ? "cancelled" : "failed"}`,
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: result.error,
						};
						if (nodeAborted) append(runId, { ...failureEvent, type: "node.cancelled" });
						else fail(runId, failureEvent, { stage: result.stage });
						continue;
					}
					const response = result.response;
					if (response.status === "detached") {
						if (!response.runId) {
							fail(runId, {
								id: `${attempt.requestId}:failed`,
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: "Detached delegated child did not report its child run id.",
							});
							continue;
						}
						append(runId, {
							id: `${attempt.requestId}:waiting`,
							type: "node.waiting",
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							reason: response.error ?? "Detached for supervisor coordination; the original child is still running.",
							childRunId: response.runId,
							...(response.structuredOutputPath ? { structuredOutputPath: response.structuredOutputPath } : {}),
							...(response.metadataPath ? { metadataPath: response.metadataPath } : {}),
							...terminalMetadata(response, result.launchContractDigest),
							...(waitDeadlineFor(startedNode, now()) !== undefined ? { waitDeadline: waitDeadlineFor(startedNode, now()) } : {}),
						});
						continue;
					}
					if (nodeAborted || response.status === "cancelled" || response.status === "interrupted") {
						append(runId, {
							id: `${attempt.requestId}:cancelled`,
							type: "node.cancelled",
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: response.error ?? "Workflow execution was cancelled.",
							...(response.status !== "invalid_request" ? terminalMetadata(response, result.launchContractDigest) : {}),
						});
						continue;
					}
					if (response.status === "completed" && response.result?.kind === "structured") {
					let parsed: WorkflowResult;
					try {
						parsed = parseWorkflowResult(response.result.value, startedNode.dataContract);
					} catch (error) {
						fail(runId, {
							id: `${attempt.requestId}:failed`,
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: `Invalid structured result: ${error instanceof Error ? error.message : String(error)}`,
							...terminalMetadata(response, result.launchContractDigest),
						}, { failureClass: "invalid_result" });
							continue;
					}
					try {
						append(runId, {
								id: `${attempt.requestId}:completed`,
									type: "node.completed",
									at: now(),
									nodeId: node.id,
									attemptId: attempt.attemptId,
									...registeredCompletion(options.store, startedRun, startedNode, attempt.attemptId, parsed, outputSlots, trustedSubmissionDirFor(response.structuredOutputPath)),
									...terminalMetadata(response, result.launchContractDigest),
								});
					} catch (error) {
						fail(runId, {
								id: `${attempt.requestId}:failed`,
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: outputRegistrationError(error, startedNode, parsed),
								...terminalMetadata(response, result.launchContractDigest),
							}, { failureClass: "output_registration_failed" });
					}
					continue;
					}
					const error = response.error
						?? (response.status === "completed" ? "Delegated child did not return a structured result." : `Delegated child ended with status '${response.status}'.`);
					// A child that already wrote a valid envelope and then lost its provider
					// connection on a later turn has finished the actual work. Recover that
					// result instead of discarding it: the judgement is whether the envelope
					// is valid, not whether the process exited cleanly.
					const terminal = response.status === "invalid_request" ? undefined : response;
					const salvaged = terminal ? salvageEnvelope(terminal.structuredOutputPath, startedNode.dataContract) : undefined;
					if (salvaged && terminal) {
						try {
							append(runId, {
								id: `${attempt.requestId}:completed`,
								type: "node.completed",
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								...registeredCompletion(options.store, startedRun, startedNode, attempt.attemptId, salvaged, outputSlots, trustedSubmissionDirFor(terminal.structuredOutputPath)),
								recoveredFromError: error,
								...terminalMetadata(terminal, result.launchContractDigest),
							});
						} catch (registrationError) {
							fail(runId, {
								id: `${attempt.requestId}:failed`,
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: outputRegistrationError(registrationError, startedNode, salvaged),
								...terminalMetadata(terminal, result.launchContractDigest),
							}, { failureClass: "output_registration_failed" });
						}
						continue;
					}
					fail(runId, {
						id: `${attempt.requestId}:failed`,
						at: now(),
						nodeId: node.id,
						attemptId: attempt.attemptId,
						error,
						...(terminal ? terminalMetadata(terminal, result.launchContractDigest) : {}),
					}, { status: response.status });
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, readyNodeIds.length) }, () => worker()));
			return options.store.load(runId);
		},
	};
}
