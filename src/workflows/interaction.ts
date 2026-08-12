import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	executeHeadlessDecision,
	type HeadlessDecisionProvider,
	type HeadlessDecisionRequest,
	type HeadlessDecisionVerdict,
} from "../headless/decision-contract.ts";
import type { DecisionAuditSink } from "../headless/decision-audit.ts";
import type {
	DocumentOutline,
	WorkflowClarificationAnswer,
	WorkflowClarificationQuestion,
} from "./types.ts";

export interface WorkflowClarificationResult {
	cancelled: boolean;
	answers: WorkflowClarificationAnswer[];
	verdict?: HeadlessDecisionVerdict;
	reason?: string;
}

export interface WorkflowOutlineReviewResult {
	cancelled: boolean;
	approved: boolean;
	feedback?: string;
	verdict?: HeadlessDecisionVerdict;
	reason?: string;
}

export interface WorkflowConfirmationRequest {
	title: string;
	message: string;
	kind: "checkpoint" | "confirmation";
	evidence: unknown;
	/** These remain platform-owned and cannot be changed by an interaction verdict. */
	forbiddenCapabilities: readonly string[];
}

export interface WorkflowConfirmationResult {
	approved: boolean;
	verdict?: HeadlessDecisionVerdict;
	reason?: string;
}

export interface WorkflowInteraction {
	clarify(input: {
		ctx: ExtensionContext;
		questions: WorkflowClarificationQuestion[];
		language: "zh" | "en";
		evidence: unknown;
		signal?: AbortSignal;
	}): Promise<WorkflowClarificationResult>;
	reviewOutline(input: {
		ctx: ExtensionContext;
		outline: DocumentOutline;
		language: "zh" | "en";
		evidence: unknown;
		signal?: AbortSignal;
	}): Promise<WorkflowOutlineReviewResult>;
	confirm(input: WorkflowConfirmationRequest & {
		ctx: ExtensionContext;
		signal?: AbortSignal;
	}): Promise<WorkflowConfirmationResult>;
}

export interface HeadlessWorkflowInteractionOptions {
	provider: HeadlessDecisionProvider;
	audit: DecisionAuditSink;
	policyVersion: string;
	approveThreshold: number;
	timeoutMs: number;
	traceId: (kind: HeadlessDecisionRequest["kind"]) => string;
	evidenceSufficient: (kind: HeadlessDecisionRequest["kind"], evidence: unknown) => boolean;
	policyAllowsApproval: (request: HeadlessDecisionRequest) => boolean;
	now?: () => Date;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clarificationAnswers(value: unknown, questions: WorkflowClarificationQuestion[]): WorkflowClarificationAnswer[] | undefined {
	if (!record(value) || !Array.isArray(value.answers) || value.answers.length !== questions.length) return undefined;
	const byId = new Map(questions.map((question) => [question.id, question]));
	const answers: WorkflowClarificationAnswer[] = [];
	for (const entry of value.answers) {
		if (!record(entry) || typeof entry.id !== "string" || typeof entry.answer !== "string" || !entry.answer.trim()) return undefined;
		const question = byId.get(entry.id);
		if (!question || answers.some((answer) => answer.id === entry.id)) return undefined;
		const selections = entry.selections;
		if (selections !== undefined && (!Array.isArray(selections) || !selections.every((selection) => typeof selection === "string" && selection.trim()))) return undefined;
		answers.push({
			id: question.id,
			prompt: question.prompt,
			answer: entry.answer.trim(),
			...(Array.isArray(selections) ? { selections: [...selections] as string[] } : {}),
			...(typeof entry.wasCustom === "boolean" ? { wasCustom: entry.wasCustom } : {}),
		});
	}
	return questions.map((question) => answers.find((answer) => answer.id === question.id)!);
}

export function createHeadlessWorkflowInteraction(options: HeadlessWorkflowInteractionOptions): WorkflowInteraction {
	const decide = async (
		kind: HeadlessDecisionRequest["kind"],
		evidence: unknown,
		forbiddenCapabilities: readonly string[],
		signal?: AbortSignal,
	) => {
		const request: HeadlessDecisionRequest = {
			kind,
			evidence,
			policyVersion: options.policyVersion,
			traceId: options.traceId(kind),
			forbiddenCapabilities: [...forbiddenCapabilities],
		};
		return executeHeadlessDecision({
			provider: options.provider,
			request,
			audit: options.audit,
			approveThreshold: options.approveThreshold,
			evidenceSufficient: options.evidenceSufficient(kind, evidence),
			policyAllowsApproval: options.policyAllowsApproval(request),
			timeoutMs: options.timeoutMs,
			...(signal ? { signal } : {}),
			...(options.now ? { now: options.now } : {}),
			...(kind === "clarify" ? {
				approvalEvidenceIssue: (decision) => clarificationAnswers(decision.structuredAnswer, (evidence as { questions?: WorkflowClarificationQuestion[] }).questions ?? [])
					? undefined
					: "Approved clarification did not contain complete structured answers.",
			} : {}),
		});
	};
	return {
		async clarify(input) {
			const decision = await decide("clarify", { questions: input.questions, context: input.evidence }, [], input.signal);
			const answers = decision.verdict === "approve" ? clarificationAnswers(decision.structuredAnswer, input.questions) : undefined;
			if (!answers) return { cancelled: true, answers: [], verdict: decision.verdict, reason: decision.reason };
			return { cancelled: false, answers, verdict: decision.verdict, reason: decision.reason };
		},
		async reviewOutline(input) {
			const decision = await decide("outline-review", { outline: input.outline, context: input.evidence }, [], input.signal);
			if (decision.verdict === "approve") return { cancelled: false, approved: true, verdict: decision.verdict, reason: decision.reason };
			const feedback = record(decision.structuredAnswer) && typeof decision.structuredAnswer.feedback === "string"
				? decision.structuredAnswer.feedback.trim()
				: decision.reason;
			return {
				cancelled: decision.verdict === "pause" || decision.verdict === "reject",
				approved: false,
				...(decision.verdict === "revise" && feedback ? { feedback } : {}),
				verdict: decision.verdict,
				reason: decision.reason,
			};
		},
		async confirm(input) {
			const decision = await decide(input.kind, input.evidence, input.forbiddenCapabilities, input.signal);
			return { approved: decision.verdict === "approve", verdict: decision.verdict, reason: decision.reason };
		},
	};
}
