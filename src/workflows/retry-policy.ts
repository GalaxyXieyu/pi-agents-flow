export const DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS = 3;
export const MAX_WORKFLOW_MAX_NODE_ATTEMPTS = 20;

export function resolveWorkflowMaxNodeAttempts(value: number | undefined): number {
	if (!Number.isInteger(value) || value === undefined || value < 1 || value > MAX_WORKFLOW_MAX_NODE_ATTEMPTS) {
		return DEFAULT_WORKFLOW_MAX_NODE_ATTEMPTS;
	}
	return value;
}

export function workflowNodeAttemptsExhausted(
	node: { status: string; attempts: readonly unknown[] },
	maxNodeAttempts: number,
): boolean {
	return (node.status === "failed" || node.status === "cancelled") && node.attempts.length >= maxNodeAttempts;
}
