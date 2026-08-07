import { isAdjudicatedStatus } from "./effective-nodes.ts";
import type { WorkflowEvaluation } from "./gates.ts";
import { nodeKindSemantics, type WorkflowPhase } from "./node-kind.ts";
import type { WorkflowNode, WorkflowRun } from "./types.ts";

export type WorkflowTodoPhase = WorkflowPhase;
export type WorkflowTodoStatus = "pending" | "in_progress" | "completed";

export interface WorkflowTodoItem {
	phase?: WorkflowTodoPhase;
	/**
	 * Subagent currently carrying this phase, when one is running.
	 *
	 * This is metadata about the phase, not a list entry of its own: the todo list
	 * stays phase-level so a task and the workers executing it never appear as
	 * siblings, while the child run identity remains projected for observability.
	 */
	activeNodeId?: string;
	subject: string;
	activeForm: string;
	status: WorkflowTodoStatus;
}

export type WorkflowTodoOperation =
	| {
		action: "create";
		subject: string;
		description: string;
		activeForm: string;
		owner: "workflow-supervisor";
		metadata: {
			workflowId: string;
			workflowRevision: number;
			workflowPhase?: WorkflowTodoPhase;
			workflowNodeId?: string;
			childRunId?: string;
			attemptNumber?: number;
		};
	}
	| {
		action: "update";
		id: number;
		status: WorkflowTodoStatus;
		activeForm?: string;
		metadata: { workflowRevision: number };
	}
	| {
		action: "delete";
		id: number;
	};

export interface WorkflowTodoProjection {
	version: 0;
	toolAvailable: boolean;
	items: WorkflowTodoItem[];
	operations: WorkflowTodoOperation[];
}

interface ExistingTodo {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	metadata?: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestTodos(branch: readonly unknown[]): ExistingTodo[] {
	for (const entry of [...branch].reverse()) {
		if (record(entry) && entry.type === "custom" && entry.customType === "pi-agents-flow-workflow-todo-snapshot" && record(entry.data) && Array.isArray(entry.data.tasks)) {
			return parseTodos(entry.data.tasks);
		}
		if (!record(entry) || entry.type !== "message" || !record(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo" || !record(message.details) || !Array.isArray(message.details.tasks)) continue;
		return parseTodos(message.details.tasks);
	}
	return [];
}

function parseTodos(tasks: unknown[]): ExistingTodo[] {
	return tasks.flatMap((task): ExistingTodo[] => {
		if (!record(task) || typeof task.id !== "number" || typeof task.subject !== "string") return [];
		if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "completed" && task.status !== "deleted") return [];
		return [{
			id: task.id,
			subject: task.subject,
			status: task.status,
			...(record(task.metadata) ? { metadata: task.metadata } : {}),
		}];
	});
}

function allAccepted(nodes: WorkflowNode[]): boolean {
	return nodes.length > 0 && nodes.every((node) => node.status === "accepted" || node.status === "superseded");
}

function allAdjudicated(nodes: WorkflowNode[]): boolean {
	return nodes.length > 0 && nodes.every((node) => isAdjudicatedStatus(node.status));
}

function acceptedAndAdjudicated(nodes: WorkflowNode[]): boolean {
	return nodes.some((node) => node.status === "accepted") && allAdjudicated(nodes);
}

function phaseDefinitions(run: WorkflowRun, evaluation: WorkflowEvaluation): Array<Omit<WorkflowTodoItem, "status"> & { complete: boolean }> {
	const nodes = Object.values(run.nodes);
	// Grouped through the shared kind table rather than hand-written kind filters,
	// so a newly added kind cannot silently belong to no phase.
	const byPhase = (phase: WorkflowPhase): WorkflowNode[] => nodes.filter((node) => nodeKindSemantics(node.kind).phase === phase);
	const research = byPhase("research");
	const execution = byPhase("execution");
	const verification = byPhase("verification");
	const outline = byPhase("planning");
	const writers = byPhase("synthesis");
	const reviewers = byPhase("review");
	const upstreamEvidenceComplete = research.length > 0 ? allAccepted(research) : execution.length > 0 ? allAccepted(execution) : false;
	const prefix = `[WF ${run.id.slice(0, 8)}]`;
	const phases: Array<Omit<WorkflowTodoItem, "status"> & { complete: boolean }> = [{
		phase: "planning",
		subject: `${prefix} Plan workflow`,
		activeForm: "planning workflow",
		complete: nodes.length > 0 && (outline.length === 0 || allAdjudicated(outline)),
	}];
	if (run.mode === "deep-research" || research.length > 0) phases.push({
		phase: "research",
		subject: `${prefix} Research evidence`,
		activeForm: "researching evidence",
		complete: acceptedAndAdjudicated(research),
	});
	if (execution.length > 0 || (run.mode === "general" && research.length === 0)) phases.push({
		phase: "execution",
		subject: `${prefix} Execute workflow`,
		activeForm: "executing workflow",
		complete: acceptedAndAdjudicated(execution.length > 0 ? execution : nodes.filter((node) => nodeKindSemantics(node.kind).phase === "execution" || nodeKindSemantics(node.kind).phase === "research")),
	});
	if (run.mode === "deep-research" || verification.length > 0) phases.push({
		phase: "verification",
		subject: `${prefix} Resolve evidence gaps`,
		activeForm: "verifying evidence",
		complete: upstreamEvidenceComplete
			&& evaluation.failed === 0
			&& evaluation.cancelled === 0
			&& evaluation.gaps === 0
			&& evaluation.conflicts === 0
			&& (verification.length === 0 || allAdjudicated(verification)),
	});
	if (run.mode === "deep-research" || writers.length > 0) phases.push({
		phase: "synthesis",
		subject: `${prefix} Synthesize accepted claims`,
		activeForm: "synthesizing accepted claims",
		complete: acceptedAndAdjudicated(writers),
	});
	if (run.mode === "deep-research" || reviewers.length > 0) phases.push({
		phase: "review",
		subject: `${prefix} Review final result`,
		activeForm: "reviewing final result",
		complete: acceptedAndAdjudicated(reviewers),
	});
	phases.push({
		phase: "delivery",
		subject: `${prefix} Deliver final artifact`,
		activeForm: "delivering final artifact",
		complete: run.status === "completed",
	});
	return phases;
}

export function buildWorkflowTodoProjection(
	run: WorkflowRun,
	evaluation: WorkflowEvaluation,
	branch: readonly unknown[],
	toolAvailable: boolean,
): WorkflowTodoProjection {
	const phases = phaseDefinitions(run, evaluation);
	const firstIncomplete = phases.findIndex((phase) => !phase.complete);
	const nodes = Object.values(run.nodes);
	const phaseItems: WorkflowTodoItem[] = phases.map((phase, index) => {
		const status = phase.complete ? "completed" : index === firstIncomplete && run.status === "active" ? "in_progress" : "pending";
		// Name the subagent actually carrying the phase, so an in-progress task reads
		// "researching 对比与上下文" instead of a static phrase.
		const active = status === "in_progress"
			? nodes.find((node) => nodeKindSemantics(node.kind).phase === phase.phase && (node.status === "running" || node.status === "waiting"))
			: undefined;
		return {
			phase: phase.phase,
			subject: phase.subject,
			activeForm: active ? `${nodeKindSemantics(active.kind).activeVerb} ${active.label}` : phase.activeForm,
			status,
			...(active ? { activeNodeId: active.id } : {}),
		};
	});
	// The todo list carries phase-level tasks only. A phase is the unit a human
	// tracks ("research evidence"); the individual subagents that carry it out are
	// an implementation detail of that task and belong in the workflow cockpit.
	// Projecting them as siblings put a task and its own workers on the same level
	// and made five section writers look like five independent commitments.
	const items = phaseItems;
	if (!toolAvailable) return { version: 0, toolAvailable, items, operations: [] };

	const existing = latestTodos(branch).filter((task) => task.status !== "deleted");
	const operations: WorkflowTodoOperation[] = [];
	for (const item of items) {
		const matching = existing
			.filter((task) => task.metadata?.workflowId === run.id && task.metadata.workflowPhase === item.phase)
			.sort((left, right) => right.id - left.id)[0];
		if (!matching || (matching.status === "completed" && item.status !== "completed")) {
			if (matching?.status === "completed") operations.push({ action: "delete", id: matching.id });
			const active = item.activeNodeId ? run.nodes[item.activeNodeId] : undefined;
			const attempt = active?.attempts.at(-1);
			operations.push({
				action: "create",
				subject: item.subject,
				description: `Projection of workflow ${run.id} phase '${item.phase}'. Workflow Store remains authoritative.`,
				activeForm: item.activeForm,
				owner: "workflow-supervisor",
				metadata: {
					workflowId: run.id,
					workflowRevision: run.revision,
					...(item.phase ? { workflowPhase: item.phase } : {}),
					...(item.activeNodeId ? { workflowNodeId: item.activeNodeId } : {}),
					...(attempt?.childRunId ? { childRunId: attempt.childRunId } : {}),
					...(attempt ? { attemptNumber: attempt.number } : {}),
				},
			});
			continue;
		}
		if (matching.status === item.status) continue;
		operations.push({
			action: "update",
			id: matching.id,
			status: item.status,
			...(item.status === "in_progress" ? { activeForm: item.activeForm } : {}),
			metadata: { workflowRevision: run.revision },
		});
	}
	const desiredPhases = new Set(items.map((item) => item.phase).filter((phase): phase is WorkflowTodoPhase => Boolean(phase)));
	const deletedIds = new Set(operations.filter((operation): operation is Extract<WorkflowTodoOperation, { action: "delete" }> => operation.action === "delete").map((operation) => operation.id));
	for (const task of existing) {
		if (task.metadata?.workflowId !== run.id || deletedIds.has(task.id)) continue;
		const phase = task.metadata.workflowPhase;
		// Any workflow-owned task without a live phase is obsolete. This also
		// tombstones per-node tasks created by earlier versions that projected
		// subagents as their own todo entries.
		const desired = typeof phase === "string" && desiredPhases.has(phase as WorkflowTodoPhase);
		if (!desired) operations.push({ action: "delete", id: task.id });
	}
	return { version: 0, toolAvailable, items, operations };
}
