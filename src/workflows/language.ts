export type WorkflowLanguage = "zh" | "en";

export type WorkflowLanguageMode = "auto" | WorkflowLanguage;

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function resolveWorkflowLanguage(text: string, mode: WorkflowLanguageMode = "auto"): WorkflowLanguage {
	if (mode !== "auto") return mode;
	return CJK_PATTERN.test(text) ? "zh" : "en";
}

export function workflowRunLanguage(run: { goal: string; language?: WorkflowLanguage }): WorkflowLanguage {
	return run.language ?? resolveWorkflowLanguage(run.goal);
}

export function workflowLanguageName(language: WorkflowLanguage): string {
	return language === "zh" ? "Simplified Chinese" : "English";
}

export function workflowLanguageInstruction(language: WorkflowLanguage): string {
	return language === "zh"
		? "Language contract: use Simplified Chinese for user-facing labels, reasoning summaries, findings, recommendations, review feedback, and final Markdown. Keep code, commands, identifiers, product names, and source titles unchanged when translation would reduce precision."
		: "Language contract: use English for user-facing labels, reasoning summaries, findings, recommendations, review feedback, and final Markdown. Keep code, commands, identifiers, product names, and source titles unchanged when translation would reduce precision.";
}
