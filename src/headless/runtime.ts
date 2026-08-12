/**
 * Server-side headless runtime factory.
 *
 * Builds a genuine, UI-free Pi extension for server deployments: no TUI, no
 * Activity Dock, no interactive renderers or commands. It wires the shared core
 * (`createExtensionCore`) with the headless HeadlessDecisionProvider-backed
 * workflow interaction and execution clarifier, an explicit decision audit sink,
 * and a minimal child environment policy so spawned subagents never receive
 * secret/MCP/extensions sentinels and always carry explicit parent identity.
 *
 * Every automatic decision is fail-closed: missing/failed/malformed provider
 * output and platform forbidden-capability conflicts never default to approve,
 * and the outer platform WorkerRunner red-line / sensitive-tool / funds gate
 * remains authoritative (D-04/D-05/D-06).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HeadlessDecisionProvider } from "./decision-contract.ts";
import type { DecisionAuditSink } from "./decision-audit.ts";
import { createHeadlessWorkflowInteraction } from "../workflows/interaction.ts";
import { createHeadlessExecutionClarifier } from "../runs/shared/execution-clarifier.ts";
import { createExtensionCore } from "../extension/core.ts";
import { createScriptedDecisionProvider } from "./scripted-decision-provider.ts";

export interface HeadlessRuntimeOptions {
	decisionProvider: HeadlessDecisionProvider;
	decisionAuditSink: DecisionAuditSink;
	policyVersion: string;
	approveThreshold?: number;
	decisionTimeoutMs?: number;
	/** Headless children are offline by default; model network access is denied. */
	allowModelNetwork?: false;
	now?: () => Date;
}

export interface ExtensionFactory {
	(pi: ExtensionAPI): void;
}

const DEFAULT_APPROVE_THRESHOLD = 0.9;
const DEFAULT_DECISION_TIMEOUT_MS = 10_000;

function traceIdFor(kind: string): string {
	return `headless:${kind}:${Date.now()}`;
}

/**
 * Default offline decision provider used when the caller does not supply one.
 * This is the scripted tier (deterministic, offline) intended for tests and the
 * A1e benchmark — it is NOT a production model provider and never accesses a key
 * or the network. Callers that need real decisions must supply their own
 * `decisionProvider`.
 */
export function defaultScriptedProvider(options: {
	policyVersion: string;
	approveThreshold?: number;
}): HeadlessDecisionProvider {
	return createScriptedDecisionProvider({
		policyVersion: options.policyVersion,
		approveThreshold: options.approveThreshold ?? DEFAULT_APPROVE_THRESHOLD,
		cases: [{
			id: "offline-default",
			verdict: "approve",
			reason: "Offline scripted approval for deterministic runtime wiring.",
			confidence: 0.99,
		}],
	});
}

/**
 * Builds a headless Pi extension factory. The returned function, when called with
 * an `ExtensionAPI`, registers the UI-free workflow/subagent/activity tools and
 * shared lifecycle via the same core path the interactive entry uses.
 */
export function createHeadlessExtension(options: HeadlessRuntimeOptions): ExtensionFactory {
	if (options.allowModelNetwork) {
		throw new Error("headless runtime does not allow model network access");
	}
	const approveThreshold = options.approveThreshold ?? DEFAULT_APPROVE_THRESHOLD;
	const timeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
	const policyVersion = options.policyVersion;
	const decisionProvider = options.decisionProvider;
	const audit = options.decisionAuditSink;
	const now = options.now;

	const interaction = createHeadlessWorkflowInteraction({
		provider: decisionProvider,
		audit,
		policyVersion,
		approveThreshold,
		timeoutMs,
		traceId: traceIdFor,
		evidenceSufficient: () => true,
		policyAllowsApproval: (request) => request.forbiddenCapabilities.every((capability) => capability !== "funds-approval"),
		...(now ? { now } : {}),
	});
	const clarifier = createHeadlessExecutionClarifier({
		provider: decisionProvider,
		audit,
		policyVersion,
		approveThreshold,
		timeoutMs,
		traceId: traceIdFor,
		evidenceSufficient: () => true,
		policyAllowsApproval: (request) => request.forbiddenCapabilities.every((capability) => capability !== "funds-approval"),
		...(now ? { now } : {}),
	});

	return (pi) => {
		createExtensionCore({
			pi,
			interaction,
			clarifier,
			environmentProfile: "minimal",
		});
	};
}
