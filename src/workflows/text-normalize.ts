export function normalizeWorkflowText(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\u2010-\u2015]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, " ")
		.replace(/[.!?。！？]+$/g, "");
}

export function workflowTextTokens(value: string): string[] {
	const normalized = normalizeWorkflowText(value);
	const parts = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/g).filter((token) => token.length > 1);
	if (parts.length > 0) return parts;
	// Fallback for very short or CJK-only fragments that the splitter flattened.
	return normalized.length > 0 ? [...normalized].filter((char) => /[a-z0-9\u4e00-\u9fff]/i.test(char)) : [];
}

export function workflowTextJaccard(left: string, right: string): number {
	const leftTokens = new Set(workflowTextTokens(left));
	const rightTokens = new Set(workflowTextTokens(right));
	if (leftTokens.size === 0 || rightTokens.size === 0) return leftTokens.size === 0 && rightTokens.size === 0 ? 1 : 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
	const union = leftTokens.size + rightTokens.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
