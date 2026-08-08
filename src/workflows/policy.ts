import type { WorkflowMode } from "./types.ts";

export interface WorkflowGatePolicy {
	minAcceptedResearchLanes: number;
	minAcceptedSectionWriters: number;
	maxUnresolvedGaps: number;
	maxUnresolvedConflicts: number;
	requireBrief: boolean;
	requireOutline: boolean;
	requireWriter: boolean;
	requireEditor: boolean;
	requireReviewer: boolean;
}

export interface WorkflowEvidencePolicy {
	/** Drop accepted claims that have neither URL nor artifact evidence. */
	dropUncitedClaims: boolean;
	/** Merge near-duplicate claims into one accepted claim. */
	mergeNearDuplicateClaims: boolean;
	/** Jaccard threshold for claim near-duplicates. */
	nearDuplicateSimilarity: number;
	/** Keep at most this many evidence records per claim after ranking. */
	maxEvidencePerClaim: number;
	/** Prefer primary evidence when ranking/trimming. */
	preferPrimaryEvidence: boolean;
}

export interface WorkflowQualityThresholds {
	minClaimCitationCoverage: number;
	minSearchFetchCoverage: number;
	minResearchTraceCoverage: number;
	minDelegationProvenanceCoverage: number;
	maxUnsupportedWriterClaimRate: number;
	minOutlineCoverage: number;
	minSectionWriterCoverage: number;
	minFinalCitationCoverage: number;
	minFinalDocumentLengthRatio: number;
	maxUnsupportedFinalCitationRate: number;
	warnPrimarySourceRatioBelow: number;
	warnEvidenceSpecificityBelow: number;
	warnDuplicateSourceRateAbove: number;
	warnLowConfidenceClaimRateAbove: number;
}

export interface WorkflowPolicy {
	version: 0;
	gates: WorkflowGatePolicy;
	evidence: WorkflowEvidencePolicy;
	quality: WorkflowQualityThresholds;
}

const DEEP_RESEARCH_POLICY: WorkflowPolicy = {
	version: 0,
	gates: {
		minAcceptedResearchLanes: 3,
		minAcceptedSectionWriters: 2,
		maxUnresolvedGaps: 0,
		maxUnresolvedConflicts: 0,
		requireBrief: true,
		requireOutline: true,
		requireWriter: false,
		requireEditor: true,
		requireReviewer: true,
	},
	evidence: {
		dropUncitedClaims: true,
		mergeNearDuplicateClaims: true,
		nearDuplicateSimilarity: 0.82,
		maxEvidencePerClaim: 8,
		preferPrimaryEvidence: true,
	},
	quality: {
		minClaimCitationCoverage: 1,
		minSearchFetchCoverage: 1,
		minResearchTraceCoverage: 1,
		minDelegationProvenanceCoverage: 1,
		maxUnsupportedWriterClaimRate: 0,
		minOutlineCoverage: 1,
		minSectionWriterCoverage: 1,
		minFinalCitationCoverage: 0.5,
		minFinalDocumentLengthRatio: 1,
		maxUnsupportedFinalCitationRate: 0,
		warnPrimarySourceRatioBelow: 0.5,
		warnEvidenceSpecificityBelow: 0.5,
		warnDuplicateSourceRateAbove: 0.2,
		warnLowConfidenceClaimRateAbove: 0.25,
	},
};

const GENERAL_POLICY: WorkflowPolicy = {
	version: 0,
	gates: {
		minAcceptedResearchLanes: 0,
		minAcceptedSectionWriters: 0,
		maxUnresolvedGaps: Number.POSITIVE_INFINITY,
		maxUnresolvedConflicts: Number.POSITIVE_INFINITY,
		requireBrief: false,
		requireOutline: false,
		requireWriter: false,
		requireEditor: false,
		requireReviewer: false,
	},
	evidence: {
		dropUncitedClaims: false,
		mergeNearDuplicateClaims: true,
		nearDuplicateSimilarity: 0.9,
		maxEvidencePerClaim: 12,
		preferPrimaryEvidence: true,
	},
	quality: {
		minClaimCitationCoverage: 0,
		minSearchFetchCoverage: 0,
		minResearchTraceCoverage: 0,
		minDelegationProvenanceCoverage: 0,
		maxUnsupportedWriterClaimRate: 1,
		minOutlineCoverage: 0,
		minSectionWriterCoverage: 0,
		minFinalCitationCoverage: 0,
		minFinalDocumentLengthRatio: 0,
		maxUnsupportedFinalCitationRate: 1,
		warnPrimarySourceRatioBelow: 0.5,
		warnEvidenceSpecificityBelow: 0.5,
		warnDuplicateSourceRateAbove: 0.35,
		warnLowConfidenceClaimRateAbove: 0.4,
	},
};

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function nonNegative(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mergeGatePolicy(base: WorkflowGatePolicy, overrides?: Partial<WorkflowGatePolicy>): WorkflowGatePolicy {
	return {
		minAcceptedResearchLanes: Math.max(0, Math.floor(overrides?.minAcceptedResearchLanes ?? base.minAcceptedResearchLanes)),
		minAcceptedSectionWriters: Math.max(0, Math.floor(overrides?.minAcceptedSectionWriters ?? base.minAcceptedSectionWriters)),
		maxUnresolvedGaps: nonNegative(overrides?.maxUnresolvedGaps ?? base.maxUnresolvedGaps, base.maxUnresolvedGaps),
		maxUnresolvedConflicts: nonNegative(overrides?.maxUnresolvedConflicts ?? base.maxUnresolvedConflicts, base.maxUnresolvedConflicts),
		requireBrief: overrides?.requireBrief ?? base.requireBrief,
		requireOutline: overrides?.requireOutline ?? base.requireOutline,
		requireWriter: overrides?.requireWriter ?? base.requireWriter,
		requireEditor: overrides?.requireEditor ?? base.requireEditor,
		requireReviewer: overrides?.requireReviewer ?? base.requireReviewer,
	};
}

function mergeEvidencePolicy(base: WorkflowEvidencePolicy, overrides?: Partial<WorkflowEvidencePolicy>): WorkflowEvidencePolicy {
	return {
		dropUncitedClaims: overrides?.dropUncitedClaims ?? base.dropUncitedClaims,
		mergeNearDuplicateClaims: overrides?.mergeNearDuplicateClaims ?? base.mergeNearDuplicateClaims,
		nearDuplicateSimilarity: clamp01(overrides?.nearDuplicateSimilarity ?? base.nearDuplicateSimilarity),
		maxEvidencePerClaim: Math.max(1, Math.floor(overrides?.maxEvidencePerClaim ?? base.maxEvidencePerClaim)),
		preferPrimaryEvidence: overrides?.preferPrimaryEvidence ?? base.preferPrimaryEvidence,
	};
}

function mergeQualityThresholds(base: WorkflowQualityThresholds, overrides?: Partial<WorkflowQualityThresholds>): WorkflowQualityThresholds {
	return {
		minClaimCitationCoverage: clamp01(overrides?.minClaimCitationCoverage ?? base.minClaimCitationCoverage),
		minSearchFetchCoverage: clamp01(overrides?.minSearchFetchCoverage ?? base.minSearchFetchCoverage),
		minResearchTraceCoverage: clamp01(overrides?.minResearchTraceCoverage ?? base.minResearchTraceCoverage),
		minDelegationProvenanceCoverage: clamp01(overrides?.minDelegationProvenanceCoverage ?? base.minDelegationProvenanceCoverage),
		maxUnsupportedWriterClaimRate: clamp01(overrides?.maxUnsupportedWriterClaimRate ?? base.maxUnsupportedWriterClaimRate),
		minOutlineCoverage: clamp01(overrides?.minOutlineCoverage ?? base.minOutlineCoverage),
		minSectionWriterCoverage: clamp01(overrides?.minSectionWriterCoverage ?? base.minSectionWriterCoverage),
		minFinalCitationCoverage: clamp01(overrides?.minFinalCitationCoverage ?? base.minFinalCitationCoverage),
		minFinalDocumentLengthRatio: clamp01(overrides?.minFinalDocumentLengthRatio ?? base.minFinalDocumentLengthRatio),
		maxUnsupportedFinalCitationRate: clamp01(overrides?.maxUnsupportedFinalCitationRate ?? base.maxUnsupportedFinalCitationRate),
		warnPrimarySourceRatioBelow: clamp01(overrides?.warnPrimarySourceRatioBelow ?? base.warnPrimarySourceRatioBelow),
		warnEvidenceSpecificityBelow: clamp01(overrides?.warnEvidenceSpecificityBelow ?? base.warnEvidenceSpecificityBelow),
		warnDuplicateSourceRateAbove: clamp01(overrides?.warnDuplicateSourceRateAbove ?? base.warnDuplicateSourceRateAbove),
		warnLowConfidenceClaimRateAbove: clamp01(overrides?.warnLowConfidenceClaimRateAbove ?? base.warnLowConfidenceClaimRateAbove),
	};
}

export function defaultWorkflowPolicy(mode: WorkflowMode): WorkflowPolicy {
	return mode === "deep-research" ? structuredClone(DEEP_RESEARCH_POLICY) : structuredClone(GENERAL_POLICY);
}

export function resolveWorkflowPolicy(mode: WorkflowMode, overrides?: Partial<WorkflowPolicy> | WorkflowPolicy): WorkflowPolicy {
	const base = defaultWorkflowPolicy(mode);
	if (!overrides) return base;
	return {
		version: 0,
		gates: mergeGatePolicy(base.gates, overrides.gates),
		evidence: mergeEvidencePolicy(base.evidence, overrides.evidence),
		quality: mergeQualityThresholds(base.quality, overrides.quality),
	};
}

export function policyAllowsCompletion(input: {
	mode: WorkflowMode;
	policy: WorkflowPolicy;
	acceptedResearchLanes: number;
	acceptedSectionWriters: number;
	acceptedKinds: readonly string[];
	hasBrief: boolean;
	hasOutline: boolean;
	unresolvedGaps: number;
	unresolvedConflicts: number;
	allAdjudicated: boolean;
	/** Reviewer may release residual gaps/conflicts so they do not block completion. */
	reviewerRelease?: { gapsAccepted?: boolean; conflictsAccepted?: boolean };
}): boolean {
	if (!input.allAdjudicated) return false;
	const { gates } = input.policy;
	if (input.acceptedResearchLanes < gates.minAcceptedResearchLanes) return false;
	if (input.acceptedSectionWriters < gates.minAcceptedSectionWriters) return false;
	const gapsReleased = input.reviewerRelease?.gapsAccepted === true;
	const conflictsReleased = input.reviewerRelease?.conflictsAccepted === true;
	if (!gapsReleased && input.unresolvedGaps > gates.maxUnresolvedGaps) return false;
	if (!conflictsReleased && input.unresolvedConflicts > gates.maxUnresolvedConflicts) return false;
	if (gates.requireBrief && !input.hasBrief) return false;
	if (gates.requireOutline && !input.hasOutline) return false;
	if (gates.requireWriter && !input.acceptedKinds.includes("writer")) return false;
	if (gates.requireEditor && !input.acceptedKinds.includes("editor")) return false;
	if (gates.requireReviewer && !input.acceptedKinds.includes("reviewer")) return false;
	return true;
}
