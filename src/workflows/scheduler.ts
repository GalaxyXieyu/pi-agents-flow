import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SubagentDelegationTerminalResponse } from "../api/delegation.ts";
import { DEFAULT_WORKFLOW_CONCURRENCY } from "../extension/config.ts";
import { materializeWorkflowContextPack } from "./context-pack.ts";
import { effectiveAcceptedResultNodes } from "./effective-nodes.ts";
import { workflowLanguageInstruction, workflowRunLanguage } from "./language.ts";
import { createLocalWorkflowArtifactStore } from "./artifact-store.ts";
import type { WorkflowDelegationAdapter } from "./delegation-adapter.ts";
import { resolveWorkflowPolicy } from "./policy.ts";
import { registerWorkflowOutputs } from "./output-ports.ts";
import { parseWorkflowResult } from "./result-contract.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import { buildResearchSearchPlan, formatResearchSearchPlan, type ResearchSourcePortfolio } from "./query-strategy.ts";
import type { WorkflowStore } from "./store.ts";
import type { WorkflowAttempt, WorkflowDataContract, WorkflowEvent, WorkflowResult, WorkflowRun } from "./types.ts";

interface CreateWorkflowSchedulerOptions {
	store: WorkflowStore;
	adapter: WorkflowDelegationAdapter;
	now?: () => number;
	onTransition?: (run: WorkflowRun) => void;
	/** Ceiling on children running at once. Clamps whatever the Supervisor requests. */
	maxConcurrency?: number;
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
	return retryRequested && (node.status === "failed" || node.status === "cancelled") && !workflowNodeAttemptsExhausted(node, maxNodeAttempts);
}

function requestId(runId: string, nodeId: string, attemptNumber: number): string {
	const digest = createHash("sha256").update(`${runId}\0${nodeId}\0${attemptNumber}`).digest("hex");
	return `workflow-${digest}`;
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

function registeredCompletion(
	store: WorkflowStore,
	run: WorkflowRun,
	node: WorkflowRun["nodes"][string],
	attemptId: string,
	result: WorkflowResult,
): Pick<Extract<WorkflowEvent, { type: "node.completed" }>, "result" | "resultArtifact" | "outputs"> {
	const registered = registerWorkflowOutputs({
		run,
		node,
		attemptId,
		result,
		contract: node.dataContract,
		artifactStore: createLocalWorkflowArtifactStore(store.paths(run.id).artifacts),
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
		});
		nodes[dependencyId] = { ...dependency, resultArtifact: registered.resultArtifact, outputs: registered.outputs };
		changed = true;
	}
	return changed ? { ...run, nodes } : run;
}

function withWorkflowContext(store: WorkflowStore, run: WorkflowRun, node: WorkflowRun["nodes"][string]): WorkflowRun["nodes"][string] {
	const contextRun = withLegacyDependencyOutputs(store, run, node);
	const contextNode = contextRun.nodes[node.id] ?? node;
	const contract = contextNode.dataContract;
	const policy = resolveWorkflowPolicy(run.mode, run.policy);
	const assignedSections = run.documentOutline?.sections.filter((section) => section.writerNodeId === node.id) ?? [];
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
		...(node.kind === "reviewer" ? ["Review only the authorized final editor input. Do not broaden the research scope or call web/search tools by default."] : []),
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
						result = await options.adapter.run(startedRun, withWorkflowContext(options.store, startedRun, startedNode), attempt, combinedController.signal);
					} catch (error) {
						adapterError = error;
					} finally {
						runOptions.signal?.removeEventListener("abort", abortParent);
						nodeController.signal.removeEventListener("abort", abortNode);
						nodeControllers.delete(node.id);
					}
					const nodeAborted = combinedController.signal.aborted;
					if (adapterError !== undefined || !result) {
						append(runId, {
							id: `${attempt.requestId}:${nodeAborted ? "cancelled" : "failed"}`,
							type: nodeAborted ? "node.cancelled" : "node.failed",
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: adapterError instanceof Error ? adapterError.message : String(adapterError ?? "Workflow adapter returned no result."),
						});
						continue;
					}
					if (result.ok === false) {
						append(runId, {
							id: `${attempt.requestId}:${nodeAborted ? "cancelled" : "failed"}`,
							type: nodeAborted ? "node.cancelled" : "node.failed",
							at: now(),
							nodeId: node.id,
							attemptId: attempt.attemptId,
							error: result.error,
						});
						continue;
					}
					const response = result.response;
					if (response.status === "detached") {
						if (!response.runId) {
							append(runId, {
								id: `${attempt.requestId}:failed`,
								type: "node.failed",
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
						append(runId, {
							id: `${attempt.requestId}:failed`,
								type: "node.failed",
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: `Invalid structured result: ${error instanceof Error ? error.message : String(error)}`,
								...terminalMetadata(response, result.launchContractDigest),
							});
							continue;
					}
					try {
						append(runId, {
								id: `${attempt.requestId}:completed`,
									type: "node.completed",
									at: now(),
									nodeId: node.id,
									attemptId: attempt.attemptId,
									...registeredCompletion(options.store, startedRun, startedNode, attempt.attemptId, parsed),
									...terminalMetadata(response, result.launchContractDigest),
								});
					} catch (error) {
						append(runId, {
								id: `${attempt.requestId}:failed`,
									type: "node.failed",
									at: now(),
									nodeId: node.id,
									attemptId: attempt.attemptId,
									error: `Workflow output registration failed: ${error instanceof Error ? error.message : String(error)}`,
									...terminalMetadata(response, result.launchContractDigest),
								});
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
								...registeredCompletion(options.store, startedRun, startedNode, attempt.attemptId, salvaged),
								recoveredFromError: error,
								...terminalMetadata(terminal, result.launchContractDigest),
							});
						} catch (registrationError) {
							append(runId, {
								id: `${attempt.requestId}:failed`,
								type: "node.failed",
								at: now(),
								nodeId: node.id,
								attemptId: attempt.attemptId,
								error: `Workflow output registration failed: ${registrationError instanceof Error ? registrationError.message : String(registrationError)}`,
								...terminalMetadata(terminal, result.launchContractDigest),
							});
						}
						continue;
					}
					append(runId, {
						id: `${attempt.requestId}:failed`,
						type: "node.failed",
						at: now(),
						nodeId: node.id,
						attemptId: attempt.attemptId,
						error,
						...(terminal ? terminalMetadata(terminal, result.launchContractDigest) : {}),
					});
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, readyNodeIds.length) }, () => worker()));
			return options.store.load(runId);
		},
	};
}
