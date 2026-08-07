import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import type { WorkflowContinuationDecision, WorkflowController } from "./controller.ts";
import type { WorkflowRun } from "./types.ts";

export interface WorkflowRuntime {
	handleAgentSettled(ctx: ExtensionContext): void;
	handleSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
	dispose(): void;
}

interface CreateWorkflowRuntimeOptions {
	pi: Pick<ExtensionAPI, "sendMessage">;
	controller: WorkflowController;
}

export function createWorkflowRuntime(options: CreateWorkflowRuntimeOptions): WorkflowRuntime {
	const warnedSignatures = new Set<string>();

	const deliver = (decision: WorkflowContinuationDecision | undefined): void => {
		if (!decision) return;
		const signature = decision.run.continuation?.signature;
		if (decision.suppressed) {
			const warningKey = `${decision.run.id}:${signature ?? "unrecorded"}`;
			if (warnedSignatures.has(warningKey)) return;
			warnedSignatures.add(warningKey);
			options.pi.sendMessage({
				customType: "workflow-status",
				content: `Workflow ${decision.run.id} made no durable progress after 3 automatic continuations. Automatic continuation is paused; inspect /workflow status and provide a decision or a narrower plan.`,
				display: true,
			});
			return;
		}
		if (!decision.prompt) return;
		for (const key of [...warnedSignatures]) {
			if (key.startsWith(`${decision.run.id}:`)) warnedSignatures.delete(key);
		}
		options.pi.sendMessage({
			customType: "workflow-continuation-context",
			content: `${decision.prompt}\n\nContinue with the next workflow tool call directly. Do not narrate routine workflow transitions before acting.`,
			display: false,
			details: { runId: decision.run.id, attempt: decision.attempt },
		}, { triggerTurn: true, deliverAs: "followUp" });
	};

	const run = (ctx: ExtensionContext, trigger: "agent_settled" | "session_recovery"): void => {
		try {
			deliver(options.controller.requestContinuation(ctx, trigger));
		} catch (error) {
			options.pi.sendMessage({
				customType: "workflow-status",
				content: `Workflow continuation stopped: ${error instanceof Error ? error.message : String(error)}`,
				display: true,
			});
		}
	};

	return {
		handleAgentSettled(ctx) {
			run(ctx, "agent_settled");
		},
		async handleSessionStart(event, ctx) {
			if (event.reason !== "startup" && event.reason !== "reload" && event.reason !== "resume") return;
			let recovered: WorkflowRun | undefined;
			try {
				recovered = options.controller.recover(ctx);
			} catch (error) {
				options.pi.sendMessage({
					customType: "workflow-status",
					content: `Workflow recovery stopped: ${error instanceof Error ? error.message : String(error)}`,
					display: true,
				});
				return;
			}
			if (recovered?.status === "active" && Object.values(recovered.nodes).some((node) => node.status === "ready")) {
				try {
					await options.controller.execute({ action: "run_ready" }, ctx);
				} catch (error) {
					options.pi.sendMessage({
						customType: "workflow-status",
						content: `Workflow restart scheduling stopped: ${error instanceof Error ? error.message : String(error)}`,
						display: true,
					});
				}
			}
			run(ctx, "session_recovery");
		},
		dispose() {
			warnedSignatures.clear();
		},
	};
}
