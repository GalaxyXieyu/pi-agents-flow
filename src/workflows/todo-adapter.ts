import { randomUUID } from "node:crypto";

import type { WorkflowTodoOperation, WorkflowTodoProjection } from "./todo-projection.ts";

export const WORKFLOW_TODO_APPLY_EVENT = "pi-swarm:workflow-todo-apply:v0";
export const WORKFLOW_TODO_RESULT_EVENT = "pi-swarm:workflow-todo-result:v0";
export const WORKFLOW_TODO_SNAPSHOT_ENTRY_TYPE = "pi-swarm-workflow-todo-snapshot";

export interface WorkflowTodoSnapshotTask {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	metadata?: Record<string, unknown>;
}

export interface WorkflowTodoApplyRequest {
	version: 0;
	requestId: string;
	sessionId: string;
	operations: WorkflowTodoOperation[];
}

export interface WorkflowTodoApplyResponse {
	requestId: string;
	applied: number;
	error?: string;
	tasks?: WorkflowTodoSnapshotTask[];
	nextId?: number;
}

interface WorkflowTodoEventBus {
	on(event: string, handler: (payload: unknown) => void): () => void;
	emit(event: string, payload: unknown): void;
}

export interface WorkflowTodoAdapterResult {
	supported: boolean;
	applied: number;
	error?: string;
}

export interface WorkflowTodoAdapter {
	apply(projection: WorkflowTodoProjection, sessionId: string): WorkflowTodoAdapterResult;
	dispose(): void;
}

interface CreateWorkflowTodoAdapterOptions {
	events: WorkflowTodoEventBus;
	createRequestId?: () => string;
	persistSnapshot?: (data: { version: 0; sessionId: string; tasks: WorkflowTodoSnapshotTask[]; nextId: number }) => void;
}

function response(value: unknown): WorkflowTodoApplyResponse | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<WorkflowTodoApplyResponse>;
	if (typeof candidate.requestId !== "string" || typeof candidate.applied !== "number") return undefined;
	return candidate as WorkflowTodoApplyResponse;
}

export function createWorkflowTodoAdapter(options: CreateWorkflowTodoAdapterOptions): WorkflowTodoAdapter {
	const pending = new Map<string, WorkflowTodoApplyResponse>();
	const unsubscribe = options.events.on(WORKFLOW_TODO_RESULT_EVENT, (payload) => {
		const result = response(payload);
		if (result) pending.set(result.requestId, result);
	});

	return {
		apply(projection, sessionId) {
			if (projection.operations.length === 0) return { supported: true, applied: 0 };
			const requestId = options.createRequestId?.() ?? randomUUID();
			const request: WorkflowTodoApplyRequest = {
				version: 0,
				requestId,
				sessionId,
				operations: projection.operations,
			};
			options.events.emit(WORKFLOW_TODO_APPLY_EVENT, request);
			const result = pending.get(requestId);
			pending.delete(requestId);
			if (!result) return { supported: false, applied: 0 };
			if (result.tasks && typeof result.nextId === "number") {
				options.persistSnapshot?.({ version: 0, sessionId, tasks: result.tasks, nextId: result.nextId });
			}
			return {
				supported: true,
				applied: result.applied,
				...(result.error ? { error: result.error } : {}),
			};
		},
		dispose() {
			unsubscribe();
			pending.clear();
		},
	};
}
