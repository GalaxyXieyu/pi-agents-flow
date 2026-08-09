import { DEEP_RESEARCH_BASE_AGENT_BY_KIND } from "./plan-rules.ts";
import { resolveWorkflowPolicy } from "./policy.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted, resolveWorkflowMaxNodes } from "./retry-policy.ts";
import { assertWorkflowDataContract, assertWorkflowDataFlow } from "./data-contract.ts";
import { dependencyIsAccepted } from "./effective-nodes.ts";
import { resolveWorkflowLanguage } from "./language.ts";
import type {
	WorkflowAttempt,
	DocumentOutline,
	ResearchBrief,
	WorkflowClarificationRound,
	WorkflowEvent,
	WorkflowNode,
	WorkflowTaskPlan,
	WorkflowWorkUnitPlan,
	WorkflowRun,
} from "./types.ts";

function assertNonBlank(value: string, field: string): void {
	if (!value.trim()) throw new Error(`${field} must not be blank.`);
}

function assertPlan(nodes: Record<string, WorkflowNode>): void {
	for (const node of Object.values(nodes)) {
		for (const dependency of node.dependsOn) {
			if (!nodes[dependency]) throw new Error(`Unknown dependency '${dependency}' for node '${node.id}'.`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (nodeId: string): void => {
		if (visiting.has(nodeId)) throw new Error(`Dependency cycle detected at node '${nodeId}'.`);
		if (visited.has(nodeId)) return;
		visiting.add(nodeId);
		for (const dependency of nodes[nodeId]?.dependsOn ?? []) visit(dependency);
		visiting.delete(nodeId);
		visited.add(nodeId);
	};
	for (const nodeId of Object.keys(nodes)) visit(nodeId);
}

function assertStringList(values: string[], field: string): void {
	for (const [index, value] of values.entries()) assertNonBlank(value, `${field}[${index}]`);
}

function assertBrief(brief: ResearchBrief): void {
	assertNonBlank(brief.audience, "brief.audience");
	assertNonBlank(brief.purpose, "brief.purpose");
	assertNonBlank(brief.scope, "brief.scope");
	if (!Number.isInteger(brief.targetWords.min) || !Number.isInteger(brief.targetWords.max) || brief.targetWords.min < 1 || brief.targetWords.max < brief.targetWords.min) {
		throw new Error("brief.targetWords must contain positive integer min/max values with max >= min.");
	}
	assertStringList(brief.requiredTopics, "brief.requiredTopics");
	assertStringList(brief.excludedTopics, "brief.excludedTopics");
	assertStringList(brief.constraints, "brief.constraints");
	assertStringList(brief.assumptions, "brief.assumptions");
}

function assertClarificationRound(round: WorkflowClarificationRound): void {
	if (round.answers.length === 0) throw new Error("A clarification round must contain at least one answer.");
	const ids = new Set<string>();
	for (const [index, answer] of round.answers.entries()) {
		assertNonBlank(answer.id, `clarification.answers[${index}].id`);
		assertNonBlank(answer.prompt, `clarification.answers[${index}].prompt`);
		assertNonBlank(answer.answer, `clarification.answers[${index}].answer`);
		if (ids.has(answer.id)) throw new Error(`Duplicate clarification answer '${answer.id}'.`);
		ids.add(answer.id);
	}
}

function assertOutline(outline: DocumentOutline): void {
	assertNonBlank(outline.title, "outline.title");
	assertNonBlank(outline.thesis, "outline.thesis");
	if (outline.sections.length < 2) throw new Error("Deep Research outline must contain at least two sections.");
	const ids = new Set<string>();
	const writers = new Set<string>();
	for (const [index, section] of outline.sections.entries()) {
		assertNonBlank(section.id, `outline.sections[${index}].id`);
		assertNonBlank(section.title, `outline.sections[${index}].title`);
		assertNonBlank(section.objective, `outline.sections[${index}].objective`);
		assertNonBlank(section.writerNodeId, `outline.sections[${index}].writerNodeId`);
		if (ids.has(section.id)) throw new Error(`Duplicate outline section '${section.id}'.`);
		ids.add(section.id);
		writers.add(section.writerNodeId);
		if (!Number.isInteger(section.targetWords) || section.targetWords < 100) throw new Error(`Outline section '${section.id}' targetWords must be an integer >= 100.`);
		assertStringList(section.questions, `outline.sections[${index}].questions`);
		assertStringList(section.evidenceRequirements, `outline.sections[${index}].evidenceRequirements`);
	}
	if (writers.size < 2) throw new Error("Deep Research outline must assign sections to at least two Writer nodes.");
}

function documentProductionStarted(run: WorkflowRun): boolean {
	return Object.values(run.nodes).some((node) => (node.kind === "section-writer" || node.kind === "writer" || node.kind === "editor" || node.kind === "reviewer") && node.attempts.length > 0);
}

function assertDocumentPlanMutable(run: WorkflowRun): void {
	if (documentProductionStarted(run)) {
		throw new Error("Research brief and outline cannot change after document writing or review starts.");
	}
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isViableSectionWriter(run: WorkflowRun, nodeId: string): boolean {
	const node = run.nodes[nodeId];
	return node?.kind === "section-writer" && node.status !== "failed" && node.status !== "cancelled" && node.status !== "rejected";
}

function isUserApprovedWriterOwnershipRepair(run: WorkflowRun, outline: DocumentOutline): boolean {
	const current = run.documentOutline;
	if (!current || outline.approval !== "user" || outline.title !== current.title || outline.thesis !== current.thesis || outline.sections.length !== current.sections.length) return false;

	let changed = false;
	for (const [index, section] of outline.sections.entries()) {
		const previous = current.sections[index];
		if (!previous
			|| section.id !== previous.id
			|| section.title !== previous.title
			|| section.objective !== previous.objective
			|| section.targetWords !== previous.targetWords
			|| !sameStringList(section.questions, previous.questions)
			|| !sameStringList(section.evidenceRequirements, previous.evidenceRequirements)
			|| !isViableSectionWriter(run, section.writerNodeId)) return false;
		if (section.writerNodeId === previous.writerNodeId) continue;

		const obsoleteWriter = run.nodes[previous.writerNodeId];
		if (obsoleteWriter?.kind !== "section-writer" || obsoleteWriter.status !== "rejected") return false;
		changed = true;
	}
	return changed;
}

function assertOutlineMutable(run: WorkflowRun, outline: DocumentOutline): void {
	if (!documentProductionStarted(run) || isUserApprovedWriterOwnershipRepair(run, outline)) return;
	throw new Error("Research outline cannot change after document writing or review starts. Only a user-approved ownership repair from rejected Section Writer nodes to replacement Section Writer nodes is allowed.");
}

function assertDeepResearchAgentRoles(run: WorkflowRun, plans: WorkflowWorkUnitPlan[]): void {
	if (run.mode !== "deep-research") return;
	for (const plan of plans) {
		const required = DEEP_RESEARCH_BASE_AGENT_BY_KIND[plan.kind];
		if (required && plan.agentSpec.baseAgent !== required) {
			throw new Error(`Deep Research node '${plan.id}' with kind '${plan.kind}' must use baseAgent '${required}', not '${plan.agentSpec.baseAgent}'.`);
		}
	}
}

function refreshReadiness(nodes: Record<string, WorkflowNode>): Record<string, WorkflowNode> {
	const next = { ...nodes };
	for (const [nodeId, node] of Object.entries(next)) {
		if (node.status !== "pending" && node.status !== "ready") continue;
		const ready = node.dependsOn.every((dependency) => dependencyIsAccepted(next, dependency));
		next[nodeId] = { ...node, status: ready ? "ready" : "pending" };
	}
	return next;
}

function applyTasks(run: WorkflowRun, plans: WorkflowTaskPlan[]): Record<string, WorkflowTaskPlan> {
	const next = { ...run.tasks };
	const seen = new Set<string>();
	for (const plan of plans) {
		assertNonBlank(plan.id, "task.id");
		assertNonBlank(plan.label, `task '${plan.id}' label`);
		if (!Number.isInteger(plan.order) || plan.order < 0) throw new Error(`Task '${plan.id}' order must be an integer >= 0.`);
		if (seen.has(plan.id)) throw new Error(`Duplicate workflow task '${plan.id}'.`);
		seen.add(plan.id);
		next[plan.id] = { ...plan };
	}
	for (const task of Object.values(next)) {
		if (task.parentId && !next[task.parentId]) throw new Error(`Unknown parent task '${task.parentId}' for task '${task.id}'.`);
		const ancestors = new Set<string>([task.id]);
		let parentId = task.parentId;
		while (parentId) {
			if (ancestors.has(parentId)) throw new Error(`Task hierarchy cycle detected at '${task.id}'.`);
			ancestors.add(parentId);
			parentId = next[parentId]?.parentId;
		}
	}
	return next;
}

function applyPlan(run: WorkflowRun, tasks: Record<string, WorkflowTaskPlan>, plans: WorkflowWorkUnitPlan[]): Record<string, WorkflowNode> {
	assertDeepResearchAgentRoles(run, plans);
	assertWorkflowDataFlow([...Object.values(run.nodes), ...plans]);
	const next = { ...run.nodes };
	const seen = new Set<string>();
	const existingNodeIds = new Set(Object.keys(next));
	const addedCount = plans.filter((plan) => !existingNodeIds.has(plan.id)).length;
	const maxNodes = resolveWorkflowMaxNodes(run.maxNodes);
	if (existingNodeIds.size + addedCount > maxNodes) {
		throw new Error(`Workflow work-unit budget exceeded: ${existingNodeIds.size} existing + ${addedCount} new exceeds the ${maxNodes}-node cap. Reject or supersede obsolete nodes before adding more, or start a new workflow.`);
	}
	for (const plan of plans) {
		assertNonBlank(plan.id, "workUnit.id");
		assertNonBlank(plan.label, `work unit '${plan.id}' label`);
		if (!tasks[plan.taskId]) throw new Error(`Unknown task '${plan.taskId}' for work unit '${plan.id}'.`);
		if (!Number.isInteger(plan.order) || plan.order < 0) throw new Error(`Work unit '${plan.id}' order must be an integer >= 0.`);
		if (seen.has(plan.id)) throw new Error(`Duplicate workflow work unit '${plan.id}'.`);
		seen.add(plan.id);
		assertWorkflowDataContract(plan);
		if (plan.replaces !== undefined) {
			if (plan.replaces === plan.id) throw new Error(`Work unit '${plan.id}' cannot replace itself.`);
			const target = run.nodes[plan.replaces];
			if (!target) throw new Error(`Work unit '${plan.id}' replaces unknown node '${plan.replaces}'.`);
			if (target.status !== "failed" && target.status !== "cancelled" && target.status !== "rejected" && target.status !== "pending" && target.status !== "ready") {
				const acceptedReviewHint = target.status === "accepted" && target.kind === "reviewer"
					? " The accepted review is immutable audit history. If it found document defects, add a new editor revision depending on that editor and review, then a new reviewer depending on the new editor; neither uses replaces. If residual risk is acceptable, add a new reviewer of the final editor with the explicit release flags instead."
					: " Accepted nodes are immutable audit history; add a new follow-up node with explicit dependencies instead of replaces.";
				throw new Error(`Work unit '${plan.id}' can only replace a failed, cancelled, rejected, pending, or ready node; '${plan.replaces}' is ${target.status}.${acceptedReviewHint}`);
			}
			if (target.kind !== plan.kind) {
				throw new Error(`Work unit '${plan.id}' must have kind '${target.kind}' to replace '${plan.replaces}', not '${plan.kind}'.`);
			}
		}
		const existing = next[plan.id];
		if (existing && existing.attempts.length > 0) {
			throw new Error(`Cannot replace workflow work unit '${plan.id}' after execution has started.`);
		}
		next[plan.id] = {
			...plan,
			dependsOn: [...plan.dependsOn],
			agentSpec: { ...plan.agentSpec, skills: plan.agentSpec.skills ? [...plan.agentSpec.skills] : undefined },
			...(plan.dataContract ? { dataContract: structuredClone(plan.dataContract) } : {}),
			status: "pending",
			attempts: [],
		};
	}
	assertPlan(next);
	return refreshReadiness(next);
}

function nodeFor(run: WorkflowRun, nodeId: string): WorkflowNode {
	const node = run.nodes[nodeId];
	if (!node) throw new Error(`Unknown workflow node '${nodeId}'.`);
	return node;
}

function replaceAttempt(
	node: WorkflowNode,
	attemptId: string,
	terminal: Omit<WorkflowAttempt, "attemptId" | "requestId" | "number" | "startedAt">,
): WorkflowNode {
	const index = node.attempts.findIndex((attempt) => attempt.attemptId === attemptId);
	if (index < 0) throw new Error(`Unknown attempt '${attemptId}' for node '${node.id}'.`);
	const attempt = node.attempts[index]!;
	if (attempt.status !== "running" && attempt.status !== "waiting") throw new Error(`Node '${node.id}' attempt is already terminal.`);
	const attempts = [...node.attempts];
	attempts[index] = { ...attempt, ...terminal };
	if (terminal.status === "completed") delete attempts[index].error;
	return { ...node, attempts };
}

function withEvent(run: WorkflowRun, event: WorkflowEvent, nodes = run.nodes): WorkflowRun {
	return {
		...run,
		revision: run.revision + 1,
		updatedAt: event.at,
		nodes,
		appliedEventIds: [...run.appliedEventIds, event.id],
	};
}

export function reduceWorkflowEvent(run: WorkflowRun | undefined, event: WorkflowEvent): WorkflowRun {
	assertNonBlank(event.id, "event.id");
	if (run?.appliedEventIds.includes(event.id)) return run;

	if (event.type === "workflow.started") {
		if (run) throw new Error("workflow.started can only be the first event.");
		assertNonBlank(event.runId, "runId");
		assertNonBlank(event.goal, "goal");
		assertNonBlank(event.cwd, "cwd");
		assertNonBlank(event.sessionId, "sessionId");
		assertNonBlank(event.branch, "branch");
		return {
			version: 1,
			id: event.runId,
			mode: event.mode,
			goal: event.goal,
			language: event.language ?? resolveWorkflowLanguage(event.goal),
			cwd: event.cwd,
			sessionId: event.sessionId,
			branch: event.branch,
			status: "active",
			revision: 1,
			createdAt: event.at,
			updatedAt: event.at,
			tasks: {},
			nodes: {},
			decisions: [],
			policy: resolveWorkflowPolicy(event.mode, event.policy),
			maxNodeAttempts: resolveWorkflowMaxNodeAttempts(event.maxNodeAttempts),
			maxNodes: resolveWorkflowMaxNodes(event.maxNodes),
			appliedEventIds: [event.id],
			...(event.codingContract ? { codingContract: event.codingContract } : {}),
		};
	}

	if (!run) throw new Error("The first workflow event must be workflow.started.");
	switch (event.type) {
		case "workflow.clarification_recorded":
			assertDocumentPlanMutable(run);
			assertClarificationRound(event.round);
			return { ...withEvent(run, event), clarifications: [...(run.clarifications ?? []), structuredClone(event.round)] };
		case "workflow.brief_set":
			assertDocumentPlanMutable(run);
			assertBrief(event.brief);
			return { ...withEvent(run, event), researchBrief: structuredClone(event.brief) };
		case "workflow.outline_set":
			assertOutline(event.outline);
			assertOutlineMutable(run, event.outline);
			return { ...withEvent(run, event), documentOutline: structuredClone(event.outline) };
		case "workflow.node_updated": {
			const node = nodeFor(run, event.nodeId);
			if (node.status !== "pending") {
				throw new Error(`Workflow node '${event.nodeId}' is ${node.status}; only pending nodes can be updated.`);
			}
			const patch = event.patch;
			const updatedNode: WorkflowNode = {
				...node,
				...(patch.label !== undefined ? { label: patch.label } : {}),
				agentSpec: {
					...node.agentSpec,
					...(patch.objective !== undefined ? { objective: patch.objective } : {}),
					...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
				},
				...(patch.acceptance !== undefined ? { acceptance: patch.acceptance } : {}),
			};
			return withEvent(run, event, { ...run.nodes, [node.id]: updatedNode });
		}
		case "workflow.plan_applied": {
			const tasks = applyTasks(run, event.tasks);
			const next = { ...withEvent(run, event, applyPlan(run, tasks, event.workUnits)), tasks };
			return run.status === "stopped" || (run.repairPlanNodeIdsAfterStop?.length ?? 0) > 0
				? { ...next, repairPlanNodeIdsAfterStop: [...new Set([...(run.repairPlanNodeIdsAfterStop ?? []), ...event.workUnits.map((node) => node.id)])] }
				: next;
		}
		case "node.started": {
			const node = nodeFor(run, event.nodeId);
			const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
			if (workflowNodeAttemptsExhausted(node, maxNodeAttempts)) {
				throw new Error(`Workflow node '${node.id}' reached its ${maxNodeAttempts}-attempt ceiling; Supervisor intervention is required before replacement or rejection.`);
			}
			if (node.status !== "ready" && node.status !== "failed" && node.status !== "cancelled") {
				throw new Error(`Workflow node '${node.id}' is not ready to start.`);
			}
			if (event.attempt.number !== node.attempts.length + 1) {
				throw new Error(`Workflow node '${node.id}' attempt number must be ${node.attempts.length + 1}.`);
			}
			if (node.attempts.some((attempt) => attempt.attemptId === event.attempt.attemptId)) {
				throw new Error(`Duplicate workflow attempt '${event.attempt.attemptId}'.`);
			}
			const updated: WorkflowNode = {
				...node,
				status: "running",
				attempts: [...node.attempts, { ...event.attempt, status: "running" }],
			};
			return withEvent(run, event, { ...run.nodes, [node.id]: updated });
		}
		case "node.waiting": {
			const node = nodeFor(run, event.nodeId);
			const updated = replaceAttempt(node, event.attemptId, {
				status: "waiting",
				error: event.reason,
				childRunId: event.childRunId,
				...(event.waitDeadline !== undefined ? { waitDeadline: event.waitDeadline } : {}),
				...(event.launchContractDigest ? { launchContractDigest: event.launchContractDigest } : {}),
				...(event.structuredOutputPath ? { structuredOutputPath: event.structuredOutputPath } : {}),
				...(event.metadataPath ? { metadataPath: event.metadataPath } : {}),
				...(event.model ? { model: event.model } : {}),
				...(event.usage ? { usage: event.usage } : {}),
			});
			return withEvent(run, event, { ...run.nodes, [node.id]: { ...updated, status: "waiting" } });
		}
		case "node.completed": {
			const node = nodeFor(run, event.nodeId);
			const updated = replaceAttempt(node, event.attemptId, {
				status: "completed",
				completedAt: event.at,
				result: event.result,
				...(event.resultArtifact ? { resultArtifact: structuredClone(event.resultArtifact) } : {}),
				...(event.outputs ? { outputs: structuredClone(event.outputs) } : {}),
				...(event.childRunId ? { childRunId: event.childRunId } : {}),
				...(event.launchContractDigest ? { launchContractDigest: event.launchContractDigest } : {}),
				...(event.structuredOutputPath ? { structuredOutputPath: event.structuredOutputPath } : {}),
				...(event.metadataPath ? { metadataPath: event.metadataPath } : {}),
				...(event.artifactPaths?.length ? { artifactPaths: [...event.artifactPaths] } : {}),
				...(event.recoveredFromError ? { recoveredFromError: event.recoveredFromError } : {}),
				...(event.model ? { model: event.model } : {}),
				...(event.usage ? { usage: event.usage } : {}),
			});
			return withEvent(run, event, {
				...run.nodes,
				[node.id]: {
					...updated,
					status: "completed",
					result: event.result,
					...(event.resultArtifact ? { resultArtifact: structuredClone(event.resultArtifact) } : {}),
					...(event.outputs ? { outputs: structuredClone(event.outputs) } : {}),
				},
			});
		}
		case "node.failed": {
			const node = nodeFor(run, event.nodeId);
			const updated = replaceAttempt(node, event.attemptId, {
				status: "failed",
				completedAt: event.at,
				error: event.error,
				...(event.failure ? { failure: structuredClone(event.failure) } : {}),
				...(event.childRunId ? { childRunId: event.childRunId } : {}),
				...(event.launchContractDigest ? { launchContractDigest: event.launchContractDigest } : {}),
				// Retained so a later recovery pass can still find a child's persisted
				// envelope or useful artifact after a transport failure.
				...(event.structuredOutputPath ? { structuredOutputPath: event.structuredOutputPath } : {}),
				...(event.metadataPath ? { metadataPath: event.metadataPath } : {}),
				...(event.artifactPaths?.length ? { artifactPaths: [...event.artifactPaths] } : {}),
				...(event.model ? { model: event.model } : {}),
				...(event.usage ? { usage: event.usage } : {}),
			});
			return withEvent(run, event, { ...run.nodes, [node.id]: { ...updated, status: "failed" } });
		}
		case "node.cancelled": {
			const node = nodeFor(run, event.nodeId);
			// When cancelling a node that never started (pending/ready with no attempts),
			// there is no attempt to replace — just flip the node status to cancelled.
			const hasMatchingAttempt = node.attempts.some((a) => a.attemptId === event.attemptId);
			const updated = hasMatchingAttempt
				? replaceAttempt(node, event.attemptId, {
					status: "cancelled",
					completedAt: event.at,
					error: event.error,
					...(event.childRunId ? { childRunId: event.childRunId } : {}),
					...(event.launchContractDigest ? { launchContractDigest: event.launchContractDigest } : {}),
					...(event.structuredOutputPath ? { structuredOutputPath: event.structuredOutputPath } : {}),
					...(event.metadataPath ? { metadataPath: event.metadataPath } : {}),
					...(event.artifactPaths?.length ? { artifactPaths: [...event.artifactPaths] } : {}),
					...(event.model ? { model: event.model } : {}),
					...(event.usage ? { usage: event.usage } : {}),
				})
				: node;
			return withEvent(run, event, { ...run.nodes, [node.id]: { ...updated, status: "cancelled" } });
		}
		case "node.accepted": {
			const node = nodeFor(run, event.nodeId);
			if (node.status !== "completed") throw new Error(`Workflow node '${node.id}' must be completed before acceptance.`);
			const accepted: Record<string, WorkflowNode> = {
				...run.nodes,
				[node.id]: { ...node, status: "accepted", decision: event.decision },
			};
			// Declarative replacement: accepting a node that declares `replaces` retires the
			// target it was built to supersede, so the supervisor's intent (expressed at
			// creation) resolves the failure without a separate supersede call. Supports
			// failed, cancelled, rejected, pending, and ready targets so that dependency-
			// blocked chains can be repaired declaratively.
			if (node.replaces) {
				const target = run.nodes[node.replaces];
				if (target && target.status !== "accepted" && target.status !== "superseded") {
					accepted[target.id] = {
						...target,
						status: "superseded",
						decision: `Superseded by accepted replacement '${node.id}'.`,
						supersededBy: node.id,
					};
				}
			}
			return withEvent(run, event, refreshReadiness(accepted));
		}
		case "node.superseded": {
			if (run.status === "completed") throw new Error("Completed workflows cannot change node supersession.");
			const node = nodeFor(run, event.nodeId);
			const replacement = nodeFor(run, event.replacementNodeId);
			if (node.id === replacement.id) throw new Error("A workflow node cannot supersede itself.");
			// Allow superseding pending/ready nodes (typically dependency-blocked) and
			// rejected nodes in addition to the original failed/cancelled/completed targets.
			if (node.status === "running" || node.status === "waiting") {
				throw new Error(`Workflow node '${node.id}' is ${node.status}; stop the running attempt before supersession.`);
			}
			if (node.status === "superseded") throw new Error(`Workflow node '${node.id}' is already superseded.`);
			if (replacement.status !== "accepted" || !replacement.result) {
				throw new Error(`Replacement workflow node '${replacement.id}' must be accepted before supersession.`);
			}
			if (node.kind !== replacement.kind) {
				throw new Error(`Replacement workflow node '${replacement.id}' must have kind '${node.kind}', not '${replacement.kind}'.`);
			}
			const nodes = refreshReadiness({
				...run.nodes,
				[node.id]: { ...node, status: "superseded", decision: event.decision, supersededBy: replacement.id },
			});
			return withEvent(run, event, nodes);
		}
		case "node.reopened": {
			if (run.status === "completed") throw new Error("Completed workflows cannot reopen nodes.");
			const node = nodeFor(run, event.nodeId);
			if (node.status !== "failed" && node.status !== "cancelled") {
				throw new Error(`Workflow node '${node.id}' is ${node.status}; only failed or cancelled nodes can be reopened for another attempt.`);
			}
			const runMax = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
			const additional = event.additionalAttempts !== undefined && Number.isInteger(event.additionalAttempts) && event.additionalAttempts > 0
				? event.additionalAttempts
				: runMax;
			// Lift only this node's ceiling so a subsequent run_ready nodeId=<node> can retry it
			// in place. Its status stays failed/cancelled until the retry runs; identity, history,
			// and plan position are preserved (no new node, no supersession bookkeeping).
			return withEvent(run, event, {
				...run.nodes,
				[node.id]: { ...node, maxAttempts: node.attempts.length + additional, decision: event.decision },
			});
		}
		case "node.rejected": {
			const node = nodeFor(run, event.nodeId);
			if (node.status === "running" || node.status === "waiting") throw new Error(`Workflow node '${node.id}' must stop running before rejection.`);
			if (node.status === "accepted" || node.status === "superseded" || node.status === "rejected") throw new Error(`Workflow node '${node.id}' is already adjudicated.`);
			return withEvent(run, event, {
				...run.nodes,
				[node.id]: { ...node, status: "rejected", decision: event.decision },
			});
		}
		case "workflow.decision_recorded": {
			assertNonBlank(event.decision.id, "decision.id");
			assertNonBlank(event.decision.target, "decision.target");
			assertNonBlank(event.decision.rationale, "decision.rationale");
			if (run.decisions.some((decision) => decision.id === event.decision.id)) {
				throw new Error(`Duplicate workflow decision '${event.decision.id}'.`);
			}
			return {
				...withEvent(run, event),
				decisions: [...run.decisions, { ...event.decision, at: event.at }],
			};
		}
		case "workflow.continuation_requested":
			return {
				...withEvent(run, event),
				continuation: {
					signature: event.signature,
					attempts: event.attempt,
					lastRequestedAt: event.at,
					trigger: event.trigger,
				},
			};
		case "workflow.status_changed":
			return {
				...withEvent(run, event),
				status: event.status,
				...(event.status === "paused" && event.reason ? { pauseReason: event.reason } : {}),
				...(event.status === "completed" ? { repairPlanNodeIdsAfterStop: [] } : {}),
			};
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

export function reduceWorkflowEvents(events: WorkflowEvent[]): WorkflowRun {
	let run: WorkflowRun | undefined;
	for (const event of events) run = reduceWorkflowEvent(run, event);
	if (!run) throw new Error("Cannot reduce an empty workflow event stream.");
	return run;
}
