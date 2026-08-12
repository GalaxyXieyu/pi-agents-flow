import type { WorkflowInteraction } from "../workflows/interaction.ts";
import { collectWorkflowClarification } from "./workflow-clarify.ts";
import { collectWorkflowOutlineReview } from "./workflow-outline-review.ts";

export function createTuiWorkflowInteraction(): WorkflowInteraction {
	return {
		async clarify(input) {
			if (input.signal?.aborted) throw input.signal.reason ?? new Error("Clarification aborted.");
			const result = await collectWorkflowClarification(input.ctx, input.questions, input.language);
			return result ?? { cancelled: true, answers: [] };
		},
		async reviewOutline(input) {
			if (input.signal?.aborted) throw input.signal.reason ?? new Error("Outline review aborted.");
			const result = await collectWorkflowOutlineReview(input.ctx, input.outline, input.language);
			return result ?? { cancelled: true, approved: false };
		},
		async confirm(input) {
			if (input.signal?.aborted) throw input.signal.reason ?? new Error("Confirmation aborted.");
			const confirm = input.ctx.ui?.confirm;
			if (typeof confirm !== "function") return { approved: false, verdict: "pause", reason: "Native confirmation adapter is unavailable." };
			const approved = await confirm(input.title, input.message);
			return { approved, verdict: approved ? "approve" : "reject", reason: approved ? "User approved the plugin checkpoint." : "User declined the plugin checkpoint." };
		},
	};
}
