/**
 * Single source of truth for what a node kind *means*.
 *
 * Everything that has to turn a `WorkflowNodeKind` into human-facing words or
 * into a workflow phase reads this table: the cockpit headline, the phase rail,
 * and the todo projection. Before this existed each of those carried its own
 * ad-hoc mapping, and they drifted apart as soon as the kind union grew — the
 * `outline`, `section-writer`, and `editor` kinds added for Deep Research were
 * missing from the projection's verb table and from its phase grouping, which
 * produced `undefined` activeForm strings and a synthesis phase that could
 * never complete.
 *
 * Because the table is typed as a total `Record` over the kind union, adding a
 * kind without describing it is a compile error rather than a silent gap.
 */
import type { WorkflowNodeKind } from "./types.ts";

/** Coarse workflow stage a node contributes to. */
export type WorkflowPhase =
	| "planning"
	| "execution"
	| "research"
	| "verification"
	| "synthesis"
	| "review"
	| "delivery";

export interface WorkflowNodeKindSemantics {
	/** Phase this kind rolls up into. */
	phase: WorkflowPhase;
	/** Present-participle verb for an in-progress item, e.g. todo `activeForm`. */
	activeVerb: string;
	/** Short noun used as a display prefix, e.g. a cockpit task row. */
	label: string;
	/** Simplified Chinese counterpart of `label`, used when the run language is zh. */
	labelZh: string;
}

export const WORKFLOW_NODE_KIND_SEMANTICS: Record<WorkflowNodeKind, WorkflowNodeKindSemantics> = {
	research: { phase: "research", activeVerb: "researching", label: "Research", labelZh: "调研" },
	verification: { phase: "verification", activeVerb: "verifying", label: "Verify", labelZh: "验证" },
	outline: { phase: "planning", activeVerb: "outlining", label: "Outline", labelZh: "拟大纲" },
	"section-writer": { phase: "synthesis", activeVerb: "writing", label: "Write", labelZh: "撰写" },
	writer: { phase: "synthesis", activeVerb: "writing", label: "Write", labelZh: "撰写" },
	editor: { phase: "synthesis", activeVerb: "editing", label: "Edit", labelZh: "整合" },
	reviewer: { phase: "review", activeVerb: "reviewing", label: "Review", labelZh: "审核" },
	custom: { phase: "execution", activeVerb: "executing", label: "Execute", labelZh: "执行" },
};

export function nodeKindSemantics(kind: WorkflowNodeKind): WorkflowNodeKindSemantics {
	return WORKFLOW_NODE_KIND_SEMANTICS[kind];
}

/** Display label for a kind in the resolved run language. */
export function nodeKindLabel(kind: WorkflowNodeKind, language: "zh" | "en"): string {
	const semantics = WORKFLOW_NODE_KIND_SEMANTICS[kind];
	return language === "zh" ? semantics.labelZh : semantics.label;
}

/** Every kind that rolls up into the given phase. */
export function kindsForPhase(phase: WorkflowPhase): WorkflowNodeKind[] {
	return (Object.keys(WORKFLOW_NODE_KIND_SEMANTICS) as WorkflowNodeKind[])
		.filter((kind) => WORKFLOW_NODE_KIND_SEMANTICS[kind].phase === phase);
}
