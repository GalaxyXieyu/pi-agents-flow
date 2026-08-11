import { benchmarkResearchLanes, type SearchQualityBenchmarkResult } from "./benchmark.ts";
import { evaluateWorkflow } from "./gates.ts";
import { effectiveAcceptedResultNodes, acceptedReviewerRelease, finalAcceptedEditor } from "./effective-nodes.ts";
import { canonicalEvidenceUrl, canonicalFetchedUrl, claimSimilarity, evidenceHasLocalReference, evidenceRequiresWebFetch, findingHasCitation, type EvidenceRecord } from "./evidence.ts";
import { buildWorkflowRepairGuidance } from "./guidance.ts";
import { resolveWorkflowPolicy, type WorkflowEvidenceMode, type WorkflowPolicy } from "./policy.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import { outlineSectionWriterNodeIds } from "./section-ownership.ts";
import type { WorkflowArtifactDescriptor, WorkflowNode, WorkflowResidualCounts, WorkflowReviewerRelease, WorkflowRun } from "./types.ts";

export interface WorkflowQualityMetrics {
	claimCitationCoverage: number;
	primarySourceRatio: number;
	evidenceSpecificity: number;
	duplicateSourceRate: number;
	researchTraceCoverage: number;
	searchFetchCoverage: number;
	unsupportedWriterClaimRate: number;
	outlineCoverage: number;
	sectionWriterCoverage: number;
	finalCitationCoverage: number;
	finalDocumentLengthRatio: number;
	unsupportedFinalCitationRate: number;
	finalDocumentUnits: number;
	delegationProvenanceCoverage: number;
	lowConfidenceClaimRate: number;
	unresolvedGaps: number;
	unresolvedConflicts: number;
}

export interface WorkflowQualityReport {
	version: 0;
	workflowId: string;
	revision: number;
	score: number;
	releaseReady: boolean;
	policy: WorkflowPolicy;
	/** Actual evidence mode used for this report after auto-detection. */
	evidenceMode: Exclude<WorkflowEvidenceMode, "auto">;
	metrics: WorkflowQualityMetrics;
	/** Raw diagnostics are preserved, while explicit decisions and Reviewer release determine acceptance/blocking. */
	residuals: { gaps: WorkflowResidualCounts; conflicts: WorkflowResidualCounts };
	/** Workflow lineage and outline ownership problems that prevent automatic completion. */
	structuralBlockers: string[];
	/** Evidence and document-quality problems, separate from workflow structure. */
	contentBlockers: string[];
	blockers: string[];
	warnings: string[];
	searchBenchmark?: SearchQualityBenchmarkResult;
	recommendedFollowUpQueries?: string[];
	/** Deterministic first repair action so a Supervisor need not parse prose guidance. */
	recommendedAction?: { kind: string; target: string; reason: string };
	/** Present when an accepted reviewer declared a release that relaxed specific gates. */
	reviewerRelease?: WorkflowReviewerRelease;
	/** The document can be handed to a user, but structural audit gates still prevent automatic completion. */
	deliveryReadyButWorkflowIncomplete: boolean;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function formatWorkflowQualityReport(report: WorkflowQualityReport, reportPath?: string): string {
	const lines = [
		`Quality ${report.score}/100  ${report.releaseReady ? "READY" : "BLOCKED"}`,
		`Workflow ${report.workflowId} revision ${report.revision}`,
		`Evidence mode ${report.evidenceMode} (${report.policy.qualityEnforcement})`,
	];
	if (report.blockers.length > 0) lines.push("", "Blockers:");
	if (report.structuralBlockers.length > 0) lines.push("", "Structural integrity: BLOCKED", ...report.structuralBlockers.map((blocker) => `- ${blocker}`));
	else lines.push("", "Structural integrity: PASSED");
	if (report.contentBlockers.length > 0) lines.push("", "Content quality: BLOCKED", ...report.contentBlockers.map((blocker) => `- ${blocker}`));
	else lines.push("", "Content quality: PASSED");
	if (report.warnings.length > 0) lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
	if (report.deliveryReadyButWorkflowIncomplete) {
		lines.push("", "Delivery: READY FOR MANUAL HANDOFF", "- An accepted Editor artifact and Reviewer release exist; workflow structural gates still prevent automatic completion.");
	}
	if (report.reviewerRelease) {
		const r = report.reviewerRelease;
		const released = [
			r.gapsAccepted ? "gaps" : undefined,
			r.conflictsAccepted ? "conflicts" : undefined,
			r.citationShortfallAccepted ? "citation-shortfall" : undefined,
			r.lengthShortfallAccepted ? "length-shortfall" : undefined,
		].filter((value): value is string => Boolean(value));
		lines.push("", `Reviewer release: ${released.length ? released.join(", ") : "overall"}${r.rationale ? ` — ${r.rationale}` : ""}`);
	}
	lines.push(
		"",
		"Coverage:",
		`- citations ${percent(report.metrics.claimCitationCoverage)}`,
		`- primary sources ${percent(report.metrics.primarySourceRatio)}`,
		`- evidence specificity ${percent(report.metrics.evidenceSpecificity)}`,
		`- research trace ${percent(report.metrics.researchTraceCoverage)}`,
		`- search fetch ${percent(report.metrics.searchFetchCoverage)}`,
		`- unsupported writer claims ${percent(report.metrics.unsupportedWriterClaimRate)}`,
		`- outline ${percent(report.metrics.outlineCoverage)}; section Writers ${percent(report.metrics.sectionWriterCoverage)}`,
		`- final citations ${percent(report.metrics.finalCitationCoverage)}; unsupported final citations ${percent(report.metrics.unsupportedFinalCitationRate)}`,
		`- final length ${report.metrics.finalDocumentUnits} units (${percent(report.metrics.finalDocumentLengthRatio)} of minimum)`,
		`- delegation provenance ${percent(report.metrics.delegationProvenanceCoverage)}`,
		`- evidence residuals — gaps raw ${report.residuals.gaps.raw}; accepted ${report.residuals.gaps.accepted}; blocking ${report.residuals.gaps.blocking}`,
		`- evidence residuals — conflicts raw ${report.residuals.conflicts.raw}; accepted ${report.residuals.conflicts.accepted}; blocking ${report.residuals.conflicts.blocking}`,
	);
	if (report.searchBenchmark) {
		lines.push(
			"",
			"Search benchmark:",
			`- ${report.searchBenchmark.score}/100; support ${percent(report.searchBenchmark.claimSupportRate)}; diversity ${percent(report.searchBenchmark.sourceDiversity)}; fetch ${percent(report.searchBenchmark.fetchedCoverage)}; duplicates ${percent(report.searchBenchmark.duplicateSourceRate)}`,
		);
	}
	if (report.recommendedFollowUpQueries?.length) {
		lines.push("", "Recommended follow-up queries:", ...report.recommendedFollowUpQueries.map((query) => `- ${query}`));
	}
	if (reportPath) lines.push("", `Artifact: ${reportPath}`);
	return lines.join("\n");
}

function ratio(numerator: number, denominator: number, empty = 1): number {
	return denominator === 0 ? empty : numerator / denominator;
}

function documentUnits(markdown: string): number {
	const readable = markdown
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/[^\s)\]>]+/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
		.replace(/[`*_~]/g, " ");
	const cjk = readable.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
	const latin = readable.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
	return cjk + latin;
}

function markdownHeadings(markdown: string): Set<string> {
	return new Set(markdown.split(/\r?\n/).map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]).filter((value): value is string => Boolean(value)).map(normalizeWorkflowText));
}

function markdownReferences(markdown: string): string[] {
	const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!).filter((target) => !target.startsWith("#"));
	const urls = markdown.match(/https?:\/\/[^\s)\uFF09\]>]+/g) ?? [];
	return [...new Set([...links, ...urls].map((reference) => reference.replace(/[.,;:]+$/, "")))];
}

function substantiveParagraphs(markdown: string): string[] {
	return markdown
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph && !/^#{1,6}\s/.test(paragraph) && !/^```/.test(paragraph) && documentUnits(paragraph) >= 40);
}

export interface WorkflowQualityContext {
	/** Reads a resolved output artifact as UTF-8 text. Enables reading full deliverables that exceed the summary cap. */
	readArtifact?: (descriptor: WorkflowArtifactDescriptor) => string;
	/** Optional runtime validation for child-reported local source paths. */
	validateLocalEvidence?: (reference: string) => boolean;
}

function isLocalFetchedReference(reference: string): boolean {
	try {
		return new URL(reference).protocol.toLowerCase() === "file:";
	} catch {
		return false;
	}
}

function nodeHasLocalTrace(node: WorkflowNode, context?: WorkflowQualityContext): boolean {
	const localFinding = node.result?.evidence?.findings.some((finding) => finding.evidence.some((evidence) => {
		if (!evidenceHasLocalReference(evidence)) return false;
		const reference = evidence.artifactPath?.trim() || evidence.url?.trim();
		return Boolean(reference && (context?.validateLocalEvidence?.(reference) ?? true));
	}));
	return Boolean(localFinding || node.result?.evidence?.search?.fetchedUrls.some(isLocalFetchedReference));
}

function residualCounts(raw: number, unresolved: number, limit: number, released: boolean): WorkflowResidualCounts {
	const accepted = raw - unresolved + (released ? unresolved : 0);
	return { raw, accepted, blocking: released ? 0 : Math.max(0, unresolved - limit) };
}

function resolvedEvidenceMode(policy: WorkflowPolicy, sourceEvidence: EvidenceRecord[], sourceNodes: WorkflowNode[]): Exclude<WorkflowEvidenceMode, "auto"> {
	if (policy.evidenceMode !== "auto") return policy.evidenceMode;
	const hasWeb = sourceEvidence.some((evidence) => evidenceRequiresWebFetch(evidence))
		|| sourceNodes.some((node) => node.result?.evidence?.search?.fetchedUrls.some((url) => Boolean(canonicalFetchedUrl(url))));
	const hasLocal = sourceEvidence.some((evidence) => evidenceHasLocalReference(evidence))
		|| sourceNodes.some((node) => nodeHasLocalTrace(node));
	if (hasWeb && hasLocal) return "mixed";
	if (hasLocal) return "local";
	return "web";
}

export function assessWorkflowQuality(run: WorkflowRun, policyOverride?: WorkflowPolicy, context?: WorkflowQualityContext): WorkflowQualityReport {
	const policy = policyOverride ?? resolveWorkflowPolicy(run.mode, run.policy);
	const accepted = effectiveAcceptedResultNodes(run);
	const researchNodes = accepted.filter((node) => node.kind === "research");
	const writerNodes = accepted.filter((node) => node.kind === "section-writer" || node.kind === "writer" || node.kind === "editor");
	const evaluation = evaluateWorkflow(run, policy);
	const reviewerRelease = acceptedReviewerRelease(run);
	const gapsReleased = reviewerRelease?.gapsAccepted === true;
	const conflictsReleased = reviewerRelease?.conflictsAccepted === true;
	const rawGaps = new Set(accepted.flatMap((node) => node.result?.diagnostics.gaps.map((gap) => normalizeWorkflowText(gap.question)) ?? [])).size;
	const rawConflicts = new Set(accepted.flatMap((node) => node.result?.diagnostics.conflicts.map((conflict) => normalizeWorkflowText(conflict.statement)) ?? [])).size;
	const residuals = {
		gaps: residualCounts(rawGaps, evaluation.gaps, policy.gates.maxUnresolvedGaps, gapsReleased),
		conflicts: residualCounts(rawConflicts, evaluation.conflicts, policy.gates.maxUnresolvedConflicts, conflictsReleased),
	};
	// Manual delivery can use the terminal accepted Editor even when a structural
	// lineage gate prevents it from becoming the auto-completion candidate.
	const editorNode = finalAcceptedEditor(run);
	const legacyWriterNode = accepted.filter((node) => node.kind === "writer").at(-1);
	const editorResolvedOutput = editorNode?.outputs?.document;
	const editorRawOutput = editorNode?.result?.outputs?.document;
	// Deep Research plans are preflighted to expose `document` as an artifact. Keep
	// the raw-value fallback for pure unit fixtures and legacy event hydration, but
	// never inspect arbitrary output names: completion and quality must agree.
	const finalMarkdown = editorResolvedOutput?.kind === "artifact" && context?.readArtifact ? context.readArtifact(editorResolvedOutput.artifact)
		: editorResolvedOutput?.kind === "inline" ? String(editorResolvedOutput.value)
		: editorRawOutput?.kind === "value" && typeof editorRawOutput.value === "string" ? String(editorRawOutput.value)
		: editorNode?.result?.summary.text ?? "";
	const sourceNodes = accepted.filter((node) => node.kind === "research" || node.kind === "verification");
	const sourceFindings = sourceNodes.flatMap((node) => node.result?.evidence?.findings ?? []);
	const sourceEvidence = sourceFindings.flatMap((finding) => finding.evidence);
	const evidenceMode = resolvedEvidenceMode(policy, sourceEvidence, sourceNodes);
	const researchLanes = researchNodes.map((node) => ({
		id: node.id,
		findings: node.result?.evidence?.findings ?? [],
		search: node.result?.evidence?.search,
	}));
	const searchBenchmark = researchLanes.length > 0 ? benchmarkResearchLanes(researchLanes) : undefined;
	const fetchedUrls = new Set(sourceNodes
		.flatMap((node) => node.result?.evidence?.search?.fetchedUrls ?? [])
		.map(canonicalFetchedUrl)
		.filter((url): url is string => Boolean(url)));
	const webSourceFindings = sourceFindings.filter((finding) => finding.evidence.some(evidenceRequiresWebFetch));
	const fetchedSourceFindings = webSourceFindings.filter((finding) => finding.evidence.some((evidence) => {
		if (!evidenceRequiresWebFetch(evidence)) return false;
		const canonical = canonicalFetchedUrl(evidence.url);
		return Boolean(canonical && fetchedUrls.has(canonical));
	}));
	const sourceClaimList = sourceFindings.map((finding) => finding.claim);
	const sourceEvidenceReferences = new Set(sourceEvidence.flatMap((evidence) => [
		canonicalEvidenceUrl(evidence.url),
		evidence.artifactPath ? normalizeWorkflowText(evidence.artifactPath) : undefined,
	]).filter((reference): reference is string => Boolean(reference)));
	const writerFindings = writerNodes.flatMap((node) => node.result?.evidence?.findings ?? []);
	const materialWriterFindings = writerFindings.filter((finding) => normalizeWorkflowText(finding.claim ?? "") !== "");
	const writerClaimThreshold = policy.evidence.nearDuplicateSimilarity;
	const unsupportedWriterClaims = materialWriterFindings.filter((finding) => {
		const claim = finding.claim ?? "";
		if (sourceClaimList.some((sourceClaim) => claimSimilarity(claim, sourceClaim) >= writerClaimThreshold)) return false;
		return !finding.evidence.some((evidence) => {
			const references = [
				canonicalEvidenceUrl(evidence.url),
				evidence.artifactPath ? normalizeWorkflowText(evidence.artifactPath) : undefined,
			].filter((reference): reference is string => Boolean(reference));
			return references.some((reference) => sourceEvidenceReferences.has(reference));
		});
	});
	const delegatedNodes = accepted.filter((node) => node.kind !== "custom");
	const delegatedWithProvenance = delegatedNodes.filter((node) => {
		const attempt = node.attempts.at(-1);
		return attempt?.status === "completed" && Boolean(attempt.childRunId && attempt.launchContractDigest);
	});
	const headings = markdownHeadings(finalMarkdown);
	const outlineSections = run.documentOutline?.sections ?? [];
	const expectedWriterIds = outlineSectionWriterNodeIds(run.documentOutline);
	const acceptedSectionWriterIds = new Set(accepted.filter((node) => node.kind === "section-writer").map((node) => node.id));
	// Follow supersededBy chains so that replacing a rejected/pending writer via
	// `replaces` still counts toward outline section-writer coverage.
	const isWriterCovered = (writerId: string): boolean => {
		if (acceptedSectionWriterIds.has(writerId)) return true;
		const visited = new Set<string>();
		let current = run.nodes[writerId];
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (current.status === "accepted") return true;
			if (current.status !== "superseded" || !current.supersededBy) break;
			current = run.nodes[current.supersededBy];
		}
		return false;
	};
	const paragraphs = substantiveParagraphs(finalMarkdown);
	const citedParagraphs = paragraphs.filter((paragraph) => markdownReferences(paragraph).length > 0);
	const acceptedSourceReferences = new Set(sourceEvidence.flatMap((evidence) => [evidence.url, evidence.artifactPath]).filter((reference): reference is string => Boolean(reference)).map(normalizeWorkflowText));
	const finalReferences = markdownReferences(finalMarkdown);
	const unsupportedFinalReferences = finalReferences.filter((reference) => !acceptedSourceReferences.has(normalizeWorkflowText(reference)));
	const finalDocumentUnits = documentUnits(finalMarkdown);
	const minimumDocumentUnits = run.researchBrief?.targetWords.min ?? 0;
	const metrics: WorkflowQualityMetrics = {
		claimCitationCoverage: ratio(sourceFindings.filter(findingHasCitation).length, sourceFindings.length),
		primarySourceRatio: ratio(sourceEvidence.filter((evidence) => evidence.kind === "primary").length, sourceEvidence.length, 0),
		evidenceSpecificity: ratio(sourceEvidence.filter((evidence) => Boolean(evidence.quote?.trim())).length, sourceEvidence.length, 0),
		duplicateSourceRate: searchBenchmark?.duplicateSourceRate ?? 0,
		researchTraceCoverage: ratio(
			researchNodes.filter((node) => {
				const search = node.result?.evidence?.search;
				const hasWebTrace = Boolean(search?.queries.length && search.fetchedUrls.some((url) => Boolean(canonicalFetchedUrl(url))));
				const hasLocalTrace = nodeHasLocalTrace(node, context);
				return hasWebTrace || hasLocalTrace;
			}).length,
			researchNodes.length,
		),
		searchFetchCoverage: ratio(fetchedSourceFindings.length, webSourceFindings.length),
		unsupportedWriterClaimRate: ratio(unsupportedWriterClaims.length, materialWriterFindings.length, 0),
		outlineCoverage: run.mode === "deep-research" ? ratio(outlineSections.filter((section) => headings.has(normalizeWorkflowText(section.title))).length, outlineSections.length, 0) : 1,
		sectionWriterCoverage: run.mode === "deep-research" ? ratio([...expectedWriterIds].filter((id) => isWriterCovered(id)).length, expectedWriterIds.size, 0) : 1,
		finalCitationCoverage: run.mode === "deep-research" ? ratio(citedParagraphs.length, paragraphs.length, 0) : 1,
		finalDocumentLengthRatio: run.mode === "deep-research" ? Math.min(1, ratio(finalDocumentUnits, minimumDocumentUnits, 0)) : 1,
		unsupportedFinalCitationRate: run.mode === "deep-research" ? ratio(unsupportedFinalReferences.length, finalReferences.length, finalReferences.length === 0 ? 0 : 1) : 0,
		finalDocumentUnits,
		delegationProvenanceCoverage: ratio(delegatedWithProvenance.length, delegatedNodes.length),
		lowConfidenceClaimRate: ratio(sourceFindings.filter((finding) => finding.confidence === "low").length, sourceFindings.length, 0),
		unresolvedGaps: evaluation.gaps,
		unresolvedConflicts: evaluation.conflicts,
	};
	const blockers: string[] = [];
	const strictQuality = policy.qualityEnforcement === "strict";
	const requiresWebEvidence = evidenceMode === "web" || evidenceMode === "mixed";
	const requiresLocalEvidence = evidenceMode === "local" || evidenceMode === "mixed";
	const hasWebEvidence = sourceEvidence.some((evidence) => evidenceRequiresWebFetch(evidence))
		|| sourceNodes.some((node) => node.result?.evidence?.search?.fetchedUrls.some((url) => Boolean(canonicalFetchedUrl(url))));
	const hasLocalEvidence = sourceEvidence.some((evidence) => evidenceHasLocalReference(evidence))
		|| sourceNodes.some((node) => nodeHasLocalTrace(node, context));
	if (strictQuality && requiresWebEvidence && !hasWebEvidence) {
		blockers.push("Strict web evidence mode requires at least one accepted HTTP(S) source.");
	}
	if (strictQuality && requiresLocalEvidence && !hasLocalEvidence) {
		blockers.push("Strict local evidence mode requires at least one accepted local artifact or file source.");
	}
	if (strictQuality && (requiresWebEvidence || requiresLocalEvidence) && metrics.claimCitationCoverage < policy.quality.minClaimCitationCoverage) {
		blockers.push(`Claim citation coverage ${metrics.claimCitationCoverage.toFixed(2)} is below strict ${evidenceMode} evidence minimum ${policy.quality.minClaimCitationCoverage}.`);
	}
	if (strictQuality && (requiresWebEvidence || requiresLocalEvidence) && researchNodes.length > 0 && metrics.researchTraceCoverage < policy.quality.minResearchTraceCoverage) {
		blockers.push(`Research trace coverage ${metrics.researchTraceCoverage.toFixed(2)} is below strict ${evidenceMode} evidence minimum ${policy.quality.minResearchTraceCoverage}.`);
	}
	if (strictQuality && requiresWebEvidence && metrics.searchFetchCoverage < policy.quality.minSearchFetchCoverage) {
		blockers.push(`Search fetch coverage ${metrics.searchFetchCoverage.toFixed(2)} is below strict web evidence minimum ${policy.quality.minSearchFetchCoverage}.`);
	}
	if (strictQuality && metrics.unsupportedWriterClaimRate > policy.quality.maxUnsupportedWriterClaimRate) {
		blockers.push(`Unsupported writer claim rate ${metrics.unsupportedWriterClaimRate.toFixed(2)} exceeds strict policy maximum ${policy.quality.maxUnsupportedWriterClaimRate}.`);
	}
	if (researchNodes.length < policy.gates.minAcceptedResearchLanes) {
		blockers.push(`Policy requires at least ${policy.gates.minAcceptedResearchLanes} accepted research lanes.`);
	}
	if (run.mode === "deep-research" && policy.gates.requireEditor && !evaluation.finalEditorCoversOutline) {
		blockers.push("Deep Research final editor must depend on every approved Section Writer.");
	}
	if (run.mode === "deep-research" && policy.gates.requireReviewer && !evaluation.reviewedFinalEditor) {
		blockers.push("Deep Research final reviewer must depend on the accepted final editor.");
	}
	if (run.mode === "deep-research" && !finalMarkdown.trim()) blockers.push("Deep Research has no accepted final editor document.");
	if (metrics.outlineCoverage < policy.quality.minOutlineCoverage) {
		blockers.push(`Final outline coverage ${metrics.outlineCoverage.toFixed(2)} is below policy minimum ${policy.quality.minOutlineCoverage}.`);
	}
	if (metrics.sectionWriterCoverage < policy.quality.minSectionWriterCoverage) {
		blockers.push(`Section Writer coverage ${metrics.sectionWriterCoverage.toFixed(2)} is below policy minimum ${policy.quality.minSectionWriterCoverage}.`);
	}
	if (strictQuality && requiresWebEvidence && metrics.finalCitationCoverage < policy.quality.minFinalCitationCoverage) {
		blockers.push(`Final document citation coverage ${metrics.finalCitationCoverage.toFixed(2)} is below strict web evidence minimum ${policy.quality.minFinalCitationCoverage}.`);
	}
	if (strictQuality && metrics.finalDocumentLengthRatio < policy.quality.minFinalDocumentLengthRatio) {
		blockers.push(`Final document length ${finalDocumentUnits} is below strict research brief minimum ${minimumDocumentUnits}.`);
	}
	if (strictQuality && requiresWebEvidence && metrics.unsupportedFinalCitationRate > policy.quality.maxUnsupportedFinalCitationRate) {
		blockers.push(`Unsupported final citation rate ${metrics.unsupportedFinalCitationRate.toFixed(2)} exceeds strict policy maximum ${policy.quality.maxUnsupportedFinalCitationRate}.`);
	}
	if (metrics.delegationProvenanceCoverage < policy.quality.minDelegationProvenanceCoverage) {
		blockers.push(`Delegation provenance coverage ${metrics.delegationProvenanceCoverage.toFixed(2)} is below policy minimum ${policy.quality.minDelegationProvenanceCoverage}.`);
	}
	if (!gapsReleased && metrics.unresolvedGaps > policy.gates.maxUnresolvedGaps) {
		blockers.push(`${metrics.unresolvedGaps} evidence gap(s) remain unresolved (policy max ${policy.gates.maxUnresolvedGaps}).`);
	}
	if (!conflictsReleased && metrics.unresolvedConflicts > policy.gates.maxUnresolvedConflicts) {
		blockers.push(`${metrics.unresolvedConflicts} evidence conflict(s) remain unresolved (policy max ${policy.gates.maxUnresolvedConflicts}).`);
	}
	const structuralBlockers = blockers.filter((blocker) =>
		blocker.startsWith("Deep Research final editor")
		|| blocker.startsWith("Deep Research final reviewer")
		|| blocker.startsWith("Section Writer coverage")
		|| blocker === "Deep Research has no accepted final editor document.",
	);
	const contentBlockers = blockers.filter((blocker) => !structuralBlockers.includes(blocker));
	const warnings: string[] = [];
	if (run.mode === "deep-research" && sourceFindings.length === 0) {
		warnings.push("Deep Research has no accepted source findings; local-codebase analysis may rely on the final document and artifact paths instead.");
	}
	if (sourceFindings.length > 0 && metrics.claimCitationCoverage < 1) {
		warnings.push(`Claim citation coverage ${metrics.claimCitationCoverage.toFixed(2)} is incomplete; review the evidence trace before relying on the conclusion.`);
	}
	if (researchNodes.length > 0 && metrics.researchTraceCoverage < 1) {
		warnings.push(`Research trace coverage ${metrics.researchTraceCoverage.toFixed(2)} is incomplete; some accepted research claims cannot be traced to a validated source.`);
	}
	if (webSourceFindings.length > 0 && metrics.searchFetchCoverage < 1) {
		warnings.push(`Search fetch coverage ${metrics.searchFetchCoverage.toFixed(2)} is incomplete; some cited web sources were not fetched.`);
	}
	if (materialWriterFindings.length > 0 && metrics.unsupportedWriterClaimRate > 0) {
		warnings.push(`Unsupported writer claim rate ${metrics.unsupportedWriterClaimRate.toFixed(2)} is nonzero; review synthesis claims against available evidence.`);
	}
	if (finalMarkdown.trim() && metrics.finalCitationCoverage < 1) {
		warnings.push(`Final document citation coverage ${metrics.finalCitationCoverage.toFixed(2)} is incomplete; local-codebase deliverables may intentionally omit web citations.`);
	}
	if (finalMarkdown.trim() && metrics.finalDocumentLengthRatio < 1) {
		warnings.push(`Final document length ${finalDocumentUnits} is below the research brief target ${minimumDocumentUnits}; assess whether the delivered scope remains adequate.`);
	}
	if (metrics.unsupportedFinalCitationRate > 0) {
		warnings.push(`Unsupported final citation rate ${metrics.unsupportedFinalCitationRate.toFixed(2)} is nonzero; verify document references before publication.`);
	}
	if (sourceEvidence.length > 0 && metrics.primarySourceRatio < policy.quality.warnPrimarySourceRatioBelow) {
		warnings.push(`Primary source ratio ${metrics.primarySourceRatio.toFixed(2)} is below warning threshold ${policy.quality.warnPrimarySourceRatioBelow}.`);
	}
	if (sourceEvidence.length > 0 && metrics.evidenceSpecificity < policy.quality.warnEvidenceSpecificityBelow) {
		warnings.push(`Evidence specificity ${metrics.evidenceSpecificity.toFixed(2)} is below warning threshold ${policy.quality.warnEvidenceSpecificityBelow}.`);
	}
	if (metrics.duplicateSourceRate > policy.quality.warnDuplicateSourceRateAbove) {
		warnings.push(`Duplicate source rate ${metrics.duplicateSourceRate.toFixed(2)} exceeds warning threshold ${policy.quality.warnDuplicateSourceRateAbove}.`);
	}
	if (metrics.lowConfidenceClaimRate > policy.quality.warnLowConfidenceClaimRateAbove) {
		warnings.push(`Low-confidence claim rate ${metrics.lowConfidenceClaimRate.toFixed(2)} exceeds warning threshold ${policy.quality.warnLowConfidenceClaimRateAbove}.`);
	}
	const scoreSignals = [
		metrics.claimCitationCoverage,
		metrics.researchTraceCoverage,
		metrics.searchFetchCoverage,
		1 - metrics.unsupportedWriterClaimRate,
		metrics.outlineCoverage,
		metrics.sectionWriterCoverage,
		metrics.finalCitationCoverage,
		metrics.finalDocumentLengthRatio,
		1 - metrics.unsupportedFinalCitationRate,
		metrics.delegationProvenanceCoverage,
		1 - Math.min(1, metrics.duplicateSourceRate),
		1 - Math.min(1, metrics.lowConfidenceClaimRate),
	];
	const score = Math.round(ratio(scoreSignals.reduce((sum, value) => sum + value, 0), scoreSignals.length, 0) * 100);
	const guidance = buildWorkflowRepairGuidance(run, evaluation, policy);
	const followUps = !blockers.length ? [] : guidance.followUpQueries;
	const deliveryReadyButWorkflowIncomplete = Boolean(
		editorNode
		&& reviewerRelease?.release === true
		&& structuralBlockers.length > 0
		&& contentBlockers.length === 0,
	);
	return {
		version: 0,
		workflowId: run.id,
		revision: run.revision,
		score,
		releaseReady: blockers.length === 0,
		policy,
		evidenceMode,
		metrics,
		residuals,
		structuralBlockers,
		contentBlockers,
		blockers,
		warnings,
		deliveryReadyButWorkflowIncomplete,
		...(reviewerRelease ? { reviewerRelease } : {}),
		...(searchBenchmark ? { searchBenchmark } : {}),
		...(followUps.length > 0 ? { recommendedFollowUpQueries: followUps } : {}),
		...(guidance.recommendedAction ? { recommendedAction: guidance.recommendedAction } : {}),
	};
}
