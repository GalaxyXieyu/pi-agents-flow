/**
 * Scripted decision provider for offline tests and benchmarks.
 *
 * NOT a production default. This provider is deterministic and offline: it maps
 * input `HeadlessDecisionRequest`s to fixed structured verdicts via case rules so
 * tests and the A1e benchmark can run without a network provider or production
 * key. It deliberately cannot be used to widen capability: any requested verdict
 * is still validated by the fail-closed contract and the platform forbidden-
 * capability gate downstream.
 */

import type { HeadlessDecision, HeadlessDecisionProvider, HeadlessDecisionRequest, HeadlessDecisionVerdict } from "./decision-contract.ts";

export interface ScriptedDecisionCase {
	/** Stable offline test/benchmark case id. */
	id: string;
	/** Only apply when the request kind matches. */
	kind?: HeadlessDecisionRequest["kind"];
	/** Require the traceId to start with this prefix (e.g. `bench/`). */
	tracePrefix?: string;
	/** Optional evidence marker match on a normalized JSON string. */
	evidenceIncludes?: string;
	verdict: HeadlessDecisionVerdict;
	reason: string;
	confidence: number;
	model?: string;
	provider?: string;
	structuredAnswer?: unknown;
}

export interface ScriptedDecisionProviderOptions {
	cases: ScriptedDecisionCase[];
	policyVersion: string;
	approveThreshold: number;
	model?: string;
	provider?: string;
	/**
	 * When true, a request that matches no case returns a fail-closed verdict
	 * instead of throwing. Tests may set false to assert the "no rule" path fails.
	 */
	fallbackFailClosed?: boolean;
	now?: () => Date;
}

const DEFAULT_MODEL = "scripted/offline";
const DEFAULT_PROVIDER = "scripted";

function normalizedEvidence(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function caseMatches(caseEntry: ScriptedDecisionCase, request: HeadlessDecisionRequest): boolean {
	if (caseEntry.kind !== undefined && caseEntry.kind !== request.kind) return false;
	if (caseEntry.tracePrefix !== undefined && !request.traceId.startsWith(caseEntry.tracePrefix)) return false;
	if (caseEntry.evidenceIncludes !== undefined && !normalizedEvidence(request.evidence).includes(caseEntry.evidenceIncludes)) return false;
	return true;
}

/**
 * Builds a deterministic offline HeadlessDecisionProvider from case rules.
 */
export function createScriptedDecisionProvider(options: ScriptedDecisionProviderOptions): HeadlessDecisionProvider {
	const cases = [...options.cases];
	return {
		async decide(request) {
			const match = cases.find((caseEntry) => caseMatches(caseEntry, request));
			if (!match) {
				if (options.fallbackFailClosed === false) {
					throw new Error(`Scripted decision provider has no case for request trace=${request.traceId} kind=${request.kind}.`);
				}
				return {
					verdict: "pause",
					reason: "Scripted provider has no matching decision case; fail-closed.",
					confidence: 0,
					model: options.model ?? DEFAULT_MODEL,
					provider: options.provider ?? DEFAULT_PROVIDER,
				};
			}
			return {
				verdict: match.verdict,
				reason: match.reason,
				confidence: match.confidence,
				model: match.model ?? options.model ?? DEFAULT_MODEL,
				provider: match.provider ?? options.provider ?? DEFAULT_PROVIDER,
				...(match.structuredAnswer !== undefined ? { structuredAnswer: match.structuredAnswer } : {}),
			};
		},
	};
}

/**
 * Convenience builder for a single always-approve offline provider used by
 * happy-path workflow unit tests. Keep approveThreshold high so the fail-closed
 * validation remains meaningful; do not use this as a production default.
 */
export function createAlwaysApproveScriptedProvider(options: { policyVersion: string; approveThreshold: number }): HeadlessDecisionProvider {
	return createScriptedDecisionProvider({
		policyVersion: options.policyVersion,
		approveThreshold: options.approveThreshold,
		fallbackFailClosed: true,
		cases: [{
			id: "always-approve",
			verdict: "approve",
			reason: "Offline scripted approval for deterministic tests.",
			confidence: 0.99,
			structuredAnswer: {},
		}],
	});
}
