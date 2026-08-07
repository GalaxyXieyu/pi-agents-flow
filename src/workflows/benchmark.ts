import { canonicalEvidenceUrl, canonicalFetchedUrl, evidenceDomain, evidenceRequiresWebFetch, findingHasCitation } from "./evidence.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import type { WorkflowFinding, WorkflowResult, WorkflowSearchTrace } from "./types.ts";

export interface ResearchLaneBenchmarkInput {
	id?: string;
	findings: WorkflowFinding[];
	search?: WorkflowSearchTrace;
}

export interface SearchQualityBenchmarkResult {
	version: 0;
	lanes: number;
	claims: number;
	sourceDiversity: number;
	claimSupportRate: number;
	unsupportedClaimRate: number;
	duplicateSourceRate: number;
	primarySourceRatio: number;
	averageEvidencePerClaim: number;
	fetchedCoverage: number;
	uniqueDomains: number;
	score: number;
	details: {
		domains: string[];
		unsupportedClaims: string[];
		duplicateReferences: string[];
	};
}

function ratio(numerator: number, denominator: number, empty = 1): number {
	return denominator === 0 ? empty : numerator / denominator;
}

function evidenceReference(evidence: WorkflowFinding["evidence"][number]): string | undefined {
	return canonicalEvidenceUrl(evidence.url) ?? evidence.artifactPath?.trim();
}

export function benchmarkResearchLanes(lanes: readonly ResearchLaneBenchmarkInput[]): SearchQualityBenchmarkResult {
	const findings = lanes.flatMap((lane) => lane.findings);
	const evidence = findings.flatMap((finding) => finding.evidence);
	const laneReferences = lanes.map((lane, index) => ({
		id: lane.id ?? `lane-${index + 1}`,
		references: new Set(lane.findings.flatMap((finding) => finding.evidence.map(evidenceReference).filter((value): value is string => Boolean(value)).map((value) => normalizeWorkflowText(value)))),
	}));
	const references = laneReferences.flatMap((lane) => [...lane.references]);
	const uniqueReferences = new Set(references);
	const domains = evidence.map(evidenceDomain).filter((value): value is string => Boolean(value));
	const uniqueDomains = [...new Set(domains)].sort();
	const fetched = new Set(lanes
		.flatMap((lane) => lane.search?.fetchedUrls ?? [])
		.map(canonicalFetchedUrl)
		.filter((url): url is string => Boolean(url)));
	const urlEvidence = evidence.filter(evidenceRequiresWebFetch);
	const fetchedEvidence = urlEvidence.filter((item) => {
		const canonical = canonicalFetchedUrl(item.url);
		return Boolean(canonical && fetched.has(canonical));
	});
	const unsupportedClaims = findings.filter((finding) => !findingHasCitation(finding)).map((finding) => finding.claim);
	const referenceOwners = new Map<string, Set<string>>();
	for (const lane of laneReferences) {
		for (const reference of lane.references) {
			const owners = referenceOwners.get(reference) ?? new Set<string>();
			owners.add(lane.id);
			referenceOwners.set(reference, owners);
		}
	}
	const duplicateReferences = [...referenceOwners.entries()]
		.filter(([, owners]) => owners.size > 1)
		.map(([reference]) => reference);
	const duplicateAssociations = [...referenceOwners.values()].reduce((sum, owners) => sum + Math.max(0, owners.size - 1), 0);
	const uniqueLaneReferences = laneReferences.reduce((sum, lane) => sum + lane.references.size, 0);
	const metrics = {
		sourceDiversity: ratio(uniqueDomains.length, Math.max(uniqueReferences.size, 1), 1),
		claimSupportRate: ratio(findings.filter(findingHasCitation).length, findings.length),
		unsupportedClaimRate: ratio(unsupportedClaims.length, findings.length, 0),
		duplicateSourceRate: ratio(duplicateAssociations, uniqueLaneReferences, 0),
		primarySourceRatio: ratio(evidence.filter((item) => item.kind === "primary").length, evidence.length, 0),
		averageEvidencePerClaim: findings.length === 0 ? 0 : evidence.length / findings.length,
		fetchedCoverage: ratio(fetchedEvidence.length, urlEvidence.length, 1),
	};
	const scoreSignals = [
		metrics.claimSupportRate,
		1 - metrics.unsupportedClaimRate,
		1 - Math.min(1, metrics.duplicateSourceRate),
		metrics.fetchedCoverage,
		Math.min(1, metrics.sourceDiversity + 0.25),
		metrics.primarySourceRatio,
	];
	const score = Math.round(ratio(scoreSignals.reduce((sum, value) => sum + value, 0), scoreSignals.length, 0) * 100);
	return {
		version: 0,
		lanes: lanes.length,
		claims: findings.length,
		...metrics,
		uniqueDomains: uniqueDomains.length,
		score,
		details: {
			domains: uniqueDomains,
			unsupportedClaims,
			duplicateReferences: [...new Set(duplicateReferences)],
		},
	};
}

export function benchmarkEnvelopes(results: readonly WorkflowResult[]): SearchQualityBenchmarkResult {
	return benchmarkResearchLanes(results.map((result, index) => ({
		id: `lane-${index + 1}`,
		findings: result.evidence?.findings ?? [],
		search: result.evidence?.search,
	})));
}

export interface SearchBenchmarkRun {
	questionId: string;
	variant: string;
	provider: string;
	result: SearchQualityBenchmarkResult;
}

export interface SearchBenchmarkGroupSummary {
	questionId: string;
	variant: string;
	provider: string;
	runs: number;
	meanScore: number;
	scoreStdDev: number;
	meanClaimSupportRate: number;
	meanUnsupportedClaimRate: number;
	meanSourceDiversity: number;
	meanFetchedCoverage: number;
}

export interface SearchBenchmarkSuiteSummary {
	version: 0;
	runs: number;
	groups: SearchBenchmarkGroupSummary[];
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
	const average = mean(values);
	return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function summarizeSearchBenchmarkRuns(runs: readonly SearchBenchmarkRun[]): SearchBenchmarkSuiteSummary {
	const groups = new Map<string, SearchBenchmarkRun[]>();
	for (const run of runs) {
		const key = `${run.questionId}\0${run.variant}\0${run.provider}`;
		const group = groups.get(key) ?? [];
		group.push(run);
		groups.set(key, group);
	}
	const summaries = [...groups.values()].map((group): SearchBenchmarkGroupSummary => {
		const first = group[0]!;
		const scores = group.map((run) => run.result.score);
		return {
			questionId: first.questionId,
			variant: first.variant,
			provider: first.provider,
			runs: group.length,
			meanScore: mean(scores),
			scoreStdDev: standardDeviation(scores),
			meanClaimSupportRate: mean(group.map((run) => run.result.claimSupportRate)),
			meanUnsupportedClaimRate: mean(group.map((run) => run.result.unsupportedClaimRate)),
			meanSourceDiversity: mean(group.map((run) => run.result.sourceDiversity)),
			meanFetchedCoverage: mean(group.map((run) => run.result.fetchedCoverage)),
		};
	});
	summaries.sort((left, right) => right.meanScore - left.meanScore || left.variant.localeCompare(right.variant));
	return { version: 0, runs: runs.length, groups: summaries };
}
