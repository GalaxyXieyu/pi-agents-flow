import type { WorkflowEvent, WorkflowTaskPlan, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

export function task(id: string, label = id, order = 0, parentId?: string): WorkflowTaskPlan {
	return { id, label, order, ...(parentId ? { parentId } : {}) };
}

export function workUnit(
	input: Omit<WorkflowWorkUnitPlan, "taskId" | "order"> & Partial<Pick<WorkflowWorkUnitPlan, "taskId" | "order">>,
): WorkflowWorkUnitPlan {
	return { ...input, taskId: input.taskId ?? "task-main", order: input.order ?? 0 };
}

export function planEvent(
	id: string,
	at: number,
	workUnits: WorkflowWorkUnitPlan[],
	tasks: WorkflowTaskPlan[] = [task("task-main", "Main work")],
): Extract<WorkflowEvent, { type: "workflow.plan_applied" }> {
	return { id, type: "workflow.plan_applied", at, tasks, workUnits };
}
