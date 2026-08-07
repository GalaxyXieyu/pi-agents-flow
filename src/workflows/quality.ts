import { benchmarkResearchLanes, type SearchQualityBenchmarkResult } from "./benchmark.ts";
import { evaluateWorkflow } from "./gates.ts";
import { effectiveAcceptedResultNodes } from "./effective-nodes.ts";
import { canonicalEvidenceUrl, canonicalFetchedUrl, claimSimilarity, evidenceRequiresWebFetch, findingHasCitation } from "./evidence.ts";
import { buildWorkflowRepairGuidance } from "./guidance.ts";
import { resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import type { WorkflowArtifactDescriptor, WorkflowRun } from "./types.ts";

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
	metrics: WorkflowQualityMetrics;
	blockers: string[];
	warnings: string[];
	searchBenchmark?: SearchQualityBenchmarkResult;
	recommendedFollowUpQueries?: string[];
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function formatWorkflowQualityReport(report: WorkflowQualityReport, reportPath?: string): string {
	const lines = [
		`Quality ${report.score}/100  ${report.releaseReady ? "READY" : "BLOCKED"}`,
		`Workflow ${report.workflowId} revision ${report.revision}`,
	];
	if (report.blockers.length > 0) lines.push("", "Blockers:", ...report.blockers.map((blocker) => `- ${blocker}`));
	if (report.warnings.length > 0) lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
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
		`- unresolved gaps ${report.metrics.unresolvedGaps}; conflicts ${report.metrics.unresolvedConflicts}`,
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
}

export function assessWorkflowQuality(run: WorkflowRun, policyOverride?: WorkflowPolicy, context?: WorkflowQualityContext): WorkflowQualityReport {
	const policy = policyOverride ?? resolveWorkflowPolicy(run.mode, run.policy);
	const accepted = effectiveAcceptedResultNodes(run);
	const researchNodes = accepted.filter((node) => node.kind === "research");
	const writerNodes = accepted.filter((node) => node.kind === "section-writer" || node.kind === "writer" || node.kind === "editor");
	const evaluation = evaluateWorkflow(run, policy);
	const editorNode = evaluation.finalEditorNodeId ? accepted.find((node) => node.id === evaluation.finalEditorNodeId) : undefined;
	const legacyWriterNode = accepted.filter((node) => node.kind === "writer").at(-1);
	const editorResolvedOutput = editorNode?.outputs?.document;
	const editorRawOutput = editorNode?.result?.outputs?.document;
	// The deliverable is the editor's `document` output, not summary.text (a bounded abstract capped at
	// MAX_WORKFLOW_SUMMARY_BYTES). Prefer the registered artifact/inline value; only fall back to summary
	// when no resolved document is available.
	const finalMarkdown = editorResolvedOutput?.kind === "inline" ? String(editorResolvedOutput.value)
		: editorResolvedOutput?.kind === "artifact" && context?.readArtifact ? context.readArtifact(editorResolvedOutput.artifact)
		: editorRawOutput?.kind === "value" && typeof editorRawOutput.value === "string" ? String(editorRawOutput.value)
		: editorNode?.result?.summary.text ?? "";
	const sourceNodes = accepted.filter((node) => node.kind === "research" || node.kind === "verification");
	const sourceFindings = sourceNodes.flatMap((node) => node.result?.evidence?.findings ?? []);
	const sourceEvidence = sourceFindings.flatMap((finding) => finding.evidence);
	const tracedResearchNodes = researchNodes.filter((node) => node.agentSpec.baseAgent !== "local-researcher");
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
	const writerClaimThreshold = policy.evidence.nearDuplicateSimilarity;
	const unsupportedWriterClaims = writerFindings.filter((finding) => {
		const claim = finding.claim ?? "";
		if (normalizeWorkflowText(claim) === "") return false;
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
	const expectedWriterIds = new Set(outlineSections.map((section) => section.writerNodeId));
	const acceptedSectionWriterIds = new Set(accepted.filter((node) => node.kind === "section-writer").map((node) => node.id));
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
			tracedResearchNodes.filter((node) => node.result?.evidence?.search && node.result.evidence.search.queries.length > 0 && node.result.evidence.search.fetchedUrls.some((url) => Boolean(canonicalFetchedUrl(url)))).length,
			tracedResearchNodes.length,
		),
		searchFetchCoverage: ratio(fetchedSourceFindings.length, webSourceFindings.length),
		unsupportedWriterClaimRate: ratio(unsupportedWriterClaims.length, writerFindings.length, 0),
		outlineCoverage: run.mode === "deep-research" ? ratio(outlineSections.filter((section) => headings.has(normalizeWorkflowText(section.title))).length, outlineSections.length, 0) : 1,
		sectionWriterCoverage: run.mode === "deep-research" ? ratio([...expectedWriterIds].filter((id) => acceptedSectionWriterIds.has(id)).length, expectedWriterIds.size, 0) : 1,
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
	if (researchNodes.length < policy.gates.minAcceptedResearchLanes) {
		blockers.push(`Policy requires at least ${policy.gates.minAcceptedResearchLanes} accepted research lanes.`);
	}
	if (run.mode === "deep-research" && sourceFindings.length === 0) blockers.push("Deep Research has no accepted source findings.");
	if (metrics.claimCitationCoverage < policy.quality.minClaimCitationCoverage) {
		blockers.push(`Claim citation coverage ${metrics.claimCitationCoverage.toFixed(2)} is below policy minimum ${policy.quality.minClaimCitationCoverage}.`);
	}
	if (tracedResearchNodes.length > 0 && metrics.researchTraceCoverage < policy.quality.minResearchTraceCoverage) {
		blockers.push(`Research trace coverage ${metrics.researchTraceCoverage.toFixed(2)} is below policy minimum ${policy.quality.minResearchTraceCoverage}.`);
	}
	if (metrics.searchFetchCoverage < policy.quality.minSearchFetchCoverage) {
		blockers.push(`Search fetch coverage ${metrics.searchFetchCoverage.toFixed(2)} is below policy minimum ${policy.quality.minSearchFetchCoverage}.`);
	}
	if (metrics.unsupportedWriterClaimRate > policy.quality.maxUnsupportedWriterClaimRate) {
		blockers.push(`Unsupported writer claim rate ${metrics.unsupportedWriterClaimRate.toFixed(2)} exceeds policy maximum ${policy.quality.maxUnsupportedWriterClaimRate}.`);
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
	if (metrics.finalCitationCoverage < policy.quality.minFinalCitationCoverage) {
		blockers.push(`Final document citation coverage ${metrics.finalCitationCoverage.toFixed(2)} is below policy minimum ${policy.quality.minFinalCitationCoverage}.`);
	}
	if (metrics.finalDocumentLengthRatio < policy.quality.minFinalDocumentLengthRatio) {
		blockers.push(`Final document length ${finalDocumentUnits} is below the research brief minimum ${minimumDocumentUnits}.`);
	}
	if (metrics.unsupportedFinalCitationRate > policy.quality.maxUnsupportedFinalCitationRate) {
		blockers.push(`Unsupported final citation rate ${metrics.unsupportedFinalCitationRate.toFixed(2)} exceeds policy maximum ${policy.quality.maxUnsupportedFinalCitationRate}.`);
	}
	if (metrics.delegationProvenanceCoverage < policy.quality.minDelegationProvenanceCoverage) {
		blockers.push(`Delegation provenance coverage ${metrics.delegationProvenanceCoverage.toFixed(2)} is below policy minimum ${policy.quality.minDelegationProvenanceCoverage}.`);
	}
	if (metrics.unresolvedGaps > policy.gates.maxUnresolvedGaps) {
		blockers.push(`${metrics.unresolvedGaps} evidence gap(s) remain unresolved (policy max ${policy.gates.maxUnresolvedGaps}).`);
	}
	if (metrics.unresolvedConflicts > policy.gates.maxUnresolvedConflicts) {
		blockers.push(`${metrics.unresolvedConflicts} evidence conflict(s) remain unresolved (policy max ${policy.gates.maxUnresolvedConflicts}).`);
	}
	const warnings: string[] = [];
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
	return {
		version: 0,
		workflowId: run.id,
		revision: run.revision,
		score,
		releaseReady: blockers.length === 0,
		policy,
		metrics,
		blockers,
		warnings,
		...(searchBenchmark ? { searchBenchmark } : {}),
		...(followUps.length > 0 ? { recommendedFollowUpQueries: followUps } : {}),
	};
}
