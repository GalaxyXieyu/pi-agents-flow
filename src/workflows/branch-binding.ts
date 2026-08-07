import * as path from "node:path";

import type { WorkflowRun } from "./types.ts";

export interface WorkflowBinding {
	version: 0;
	runId: string;
	revision: number;
	sessionId: string;
	cwd: string;
	branch: string;
}

export function createWorkflowBinding(run: WorkflowRun): WorkflowBinding {
	return {
		version: 0,
		runId: run.id,
		revision: run.revision,
		sessionId: run.sessionId,
		cwd: run.cwd,
		branch: run.branch,
	};
}

export function assertWorkflowBinding(run: WorkflowRun, binding: WorkflowBinding): void {
	if (binding.version !== 0) throw new Error(`Unsupported workflow binding version '${binding.version}'.`);
	if (binding.runId !== run.id) throw new Error(`Workflow binding run id '${binding.runId}' does not match '${run.id}'.`);
	if (binding.revision !== run.revision) {
		throw new Error(`Workflow binding revision ${binding.revision} is stale; current revision is ${run.revision}.`);
	}
	if (binding.sessionId !== run.sessionId) throw new Error("Workflow binding belongs to a different session.");
	if (path.resolve(binding.cwd) !== path.resolve(run.cwd)) {
		throw new Error("Workflow binding belongs to a different working directory.");
	}
	if (binding.branch !== run.branch) throw new Error("Workflow binding belongs to a different branch.");
}
