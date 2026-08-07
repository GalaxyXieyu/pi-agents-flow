import { normalizeWorkflowText, workflowTextJaccard } from "./text-normalize.ts";
import type { WorkflowEvidencePolicy } from "./policy.ts";
import type { WorkflowFinding } from "./types.ts";

export type EvidenceRecord = WorkflowFinding["evidence"][number];

export function confidenceRank(value: WorkflowFinding["confidence"]): number {
	return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

export function evidenceHasCitation(evidence: EvidenceRecord): boolean {
	return Boolean(evidence.url?.trim() || evidence.artifactPath?.trim());
}

/**
 * Only remote HTTP(S) evidence needs a fetch provenance record. Local files,
 * failed file probes, and already-materialized artifacts are not web fetches.
 */
export function evidenceRequiresWebFetch(evidence: EvidenceRecord): boolean {
	if (evidence.artifactPath?.trim()) return false;
	try {
		const protocol = new URL(evidence.url?.trim() ?? "").protocol.toLowerCase();
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function findingHasCitation(finding: WorkflowFinding): boolean {
	return finding.evidence.some(evidenceHasCitation);
}

export function evidenceIdentity(evidence: EvidenceRecord): string {
	const url = evidence.url?.trim().toLowerCase() ?? "";
	const artifact = evidence.artifactPath?.trim().toLowerCase() ?? "";
	const title = evidence.title?.trim().toLowerCase() ?? "";
	const quote = evidence.quote?.trim().toLowerCase() ?? "";
	return `${url}|${artifact}|${title}|${quote}`;
}

export function evidenceDomain(evidence: EvidenceRecord): string | undefined {
	const url = evidence.url?.trim();
	if (!url) return undefined;
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return undefined;
	}
}

export function scoreEvidence(evidence: EvidenceRecord, preferPrimary: boolean): number {
	let score = 0;
	if (evidence.url?.trim()) score += 2;
	if (evidence.artifactPath?.trim()) score += 2;
	if (evidence.quote?.trim()) score += 2;
	if (evidence.title?.trim()) score += 0.5;
	if (evidence.publishedAt?.trim()) score += 0.5;
	if (evidence.retrievedAt?.trim()) score += 0.25;
	if (preferPrimary) {
		if (evidence.kind === "primary") score += 3;
		else if (evidence.kind === "secondary") score += 1.5;
		else if (evidence.kind === "community") score += 0.5;
	} else if (evidence.kind) {
		score += 0.5;
	}
	return score;
}

export function rankEvidence(evidence: readonly EvidenceRecord[], preferPrimary: boolean): EvidenceRecord[] {
	return [...evidence].sort((left, right) => {
		const scoreDelta = scoreEvidence(right, preferPrimary) - scoreEvidence(left, preferPrimary);
		if (scoreDelta !== 0) return scoreDelta;
		return evidenceIdentity(left).localeCompare(evidenceIdentity(right));
	});
}

export function canonicalEvidenceUrl(url: string | undefined): string | undefined {
	if (!url?.trim()) return undefined;
	try {
		const parsed = new URL(url.trim());
		parsed.hash = "";
		// Drop common tracking params so syndicated copies collapse.
		for (const key of [...parsed.searchParams.keys()]) {
			if (key.toLowerCase().startsWith("utm_") || key.toLowerCase() === "ref" || key.toLowerCase() === "fbclid") {
				parsed.searchParams.delete(key);
			}
		}
		const search = parsed.searchParams.toString();
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}${search ? `?${search}` : ""}`.toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

export function canonicalFetchedUrl(url: string | undefined): string | undefined {
	if (!url?.trim()) return undefined;
	try {
		const parsed = new URL(url.trim());
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return canonicalEvidenceUrl(url);
	} catch {
		return undefined;
	}
}

export function dedupeEvidence(evidence: readonly EvidenceRecord[], preferPrimary: boolean, maxEvidence: number): EvidenceRecord[] {
	const ranked = rankEvidence(evidence, preferPrimary);
	const seenExact = new Set<string>();
	const seenCanonicalUrls = new Set<string>();
	const kept: EvidenceRecord[] = [];
	for (const item of ranked) {
		const identity = evidenceIdentity(item);
		if (seenExact.has(identity)) continue;
		const canonicalUrl = canonicalEvidenceUrl(item.url);
		if (canonicalUrl && seenCanonicalUrls.has(canonicalUrl)) continue;
		seenExact.add(identity);
		if (canonicalUrl) seenCanonicalUrls.add(canonicalUrl);
		kept.push(item);
		if (kept.length >= maxEvidence) break;
	}
	return kept;
}

function stemToken(token: string): string {
	let value = token;
	if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
	if (value.endsWith("ing") && value.length > 5) value = value.slice(0, -3);
	else if (value.endsWith("ed") && value.length > 4) value = value.slice(0, -2);
	else if (value.endsWith("es") && value.length > 4) value = value.slice(0, -2);
	else if (value.endsWith("s") && value.length > 3) value = value.slice(0, -1);
	return value;
}

function contentTokens(value: string): Set<string> {
	return new Set(
		normalizeWorkflowText(value)
			.split(/[^a-z0-9\u4e00-\u9fff]+/g)
			.filter((token) => token.length > 2)
			.map(stemToken),
	);
}

export function claimSimilarity(left: string, right: string): number {
	const leftNorm = normalizeWorkflowText(left);
	const rightNorm = normalizeWorkflowText(right);
	if (!leftNorm || !rightNorm) return 0;
	if (leftNorm === rightNorm) return 1;
	if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) {
		const shorter = Math.min(leftNorm.length, rightNorm.length);
		const longer = Math.max(leftNorm.length, rightNorm.length);
		return longer === 0 ? 1 : Math.max(0.85, shorter / longer);
	}
	const leftContent = contentTokens(leftNorm);
	const rightContent = contentTokens(rightNorm);
	if (leftContent.size === 0 || rightContent.size === 0) return workflowTextJaccard(leftNorm, rightNorm);
	let intersection = 0;
	for (const token of leftContent) if (rightContent.has(token)) intersection += 1;
	const union = leftContent.size + rightContent.size - intersection;
	const contentScore = union === 0 ? 0 : intersection / union;
	const lexicalScore = workflowTextJaccard(leftNorm, rightNorm);
	return Math.max(contentScore, lexicalScore);
}

export interface NormalizedAcceptedClaim {
	idSeed: string;
	claim: string;
	confidence: WorkflowFinding["confidence"];
	evidence: EvidenceRecord[];
	producerNodeIds: string[];
}

export function mergeFindingsIntoClaims(
	entries: Array<{ nodeId: string; finding: WorkflowFinding }>,
	policy: WorkflowEvidencePolicy,
): NormalizedAcceptedClaim[] {
	const claims: NormalizedAcceptedClaim[] = [];
	for (const entry of entries) {
		if (policy.dropUncitedClaims && !findingHasCitation(entry.finding)) continue;
		const existing = policy.mergeNearDuplicateClaims
			? claims.find((claim) => claimSimilarity(claim.claim, entry.finding.claim) >= policy.nearDuplicateSimilarity)
			: claims.find((claim) => normalizeWorkflowText(claim.claim) === normalizeWorkflowText(entry.finding.claim));
		if (!existing) {
			claims.push({
				idSeed: normalizeWorkflowText(entry.finding.claim),
				claim: entry.finding.claim.trim(),
				confidence: entry.finding.confidence,
				evidence: [...entry.finding.evidence],
				producerNodeIds: [entry.nodeId],
			});
			continue;
		}
		// Prefer the more specific claim wording when near-duplicate.
		if (entry.finding.claim.trim().length > existing.claim.length) existing.claim = entry.finding.claim.trim();
		if (confidenceRank(entry.finding.confidence) > confidenceRank(existing.confidence)) existing.confidence = entry.finding.confidence;
		existing.evidence.push(...entry.finding.evidence);
		if (!existing.producerNodeIds.includes(entry.nodeId)) existing.producerNodeIds.push(entry.nodeId);
	}
	return claims.map((claim) => ({
		...claim,
		evidence: dedupeEvidence(claim.evidence, policy.preferPrimaryEvidence, policy.maxEvidencePerClaim),
	}));
}

/** Lightweight source ranking for research candidates before fetch. */
export function rankSourceCandidates<T extends { url?: string; title?: string; snippet?: string }>(
	candidates: readonly T[],
	options: { preferDomains?: string[]; queryTerms?: string[] } = {},
): T[] {
	const prefer = new Set((options.preferDomains ?? []).map((domain) => domain.toLowerCase()));
	const terms = (options.queryTerms ?? []).map((term) => term.toLowerCase()).filter(Boolean);
	return [...candidates].sort((left, right) => scoreCandidate(right, prefer, terms) - scoreCandidate(left, prefer, terms));
}

function scoreCandidate(
	candidate: { url?: string; title?: string; snippet?: string },
	prefer: Set<string>,
	terms: string[],
): number {
	let score = 0;
	const url = candidate.url?.toLowerCase() ?? "";
	const title = candidate.title?.toLowerCase() ?? "";
	const snippet = candidate.snippet?.toLowerCase() ?? "";
	try {
		const host = url ? new URL(candidate.url!).hostname.replace(/^www\./, "").toLowerCase() : "";
		if (prefer.has(host)) score += 5;
		if (host.endsWith(".gov") || host.endsWith(".edu") || host.includes("github.com") || host.includes("docs.")) score += 2;
	} catch {
		// ignore invalid URL
	}
	if (url.includes("docs") || url.includes("spec") || url.includes("rfc") || url.includes("readme")) score += 1.5;
	if (url.includes("medium.com") || url.includes("seo") || url.includes("listicle")) score -= 1;
	for (const term of terms) {
		if (title.includes(term)) score += 1;
		if (snippet.includes(term)) score += 0.5;
		if (url.includes(term.replace(/\s+/g, "-"))) score += 0.25;
	}
	return score;
}

export function suggestFollowUpQueries(input: {
	goal: string;
	gaps: Array<{ question: string }>;
	conflicts: Array<{ statement: string; alternatives?: string[] }>;
}): string[] {
	const queries: string[] = [];
	for (const gap of input.gaps) {
		queries.push(`${gap.question} primary source`);
		queries.push(`${gap.question} official documentation`);
	}
	for (const conflict of input.conflicts) {
		const alternatives = conflict.alternatives?.filter(Boolean).join(" vs ") ?? "";
		queries.push(`${conflict.statement} evidence`);
		if (alternatives) queries.push(`${alternatives} comparison primary source`);
	}
	if (queries.length === 0 && input.goal.trim()) {
		queries.push(`${input.goal} official documentation`);
		queries.push(`${input.goal} limitations OR caveats site:github.com OR site:docs`);
	}
	return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 8);
}
