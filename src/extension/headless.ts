/**
 * Headless extension entry (`pi-agents-flow/headless`).
 *
 * Resolves to a genuine UI-free server runtime: no pi-tui module and no
 * `src/tui/*` module is imported on this path. It assembles the shared core
 * (`createExtensionCore`) with the headless HeadlessDecisionProvider-backed
 * workflow/subagent interaction, an explicit decision audit sink, and minimal
 * child environment policy. It never reverse-imports the interactive
 * `./index.ts` entry.
 */

export {
	createHeadlessExtension,
	defaultScriptedProvider,
	type ExtensionFactory,
	type HeadlessRuntimeOptions,
} from "../headless/runtime.ts";
import { createHeadlessExtension } from "../headless/runtime.ts";

export { createHeadlessWorkflowInteraction } from "../workflows/interaction.ts";
export { createHeadlessExecutionClarifier } from "../runs/shared/execution-clarifier.ts";
export {
	createScriptedDecisionProvider,
	createAlwaysApproveScriptedProvider,
	type ScriptedDecisionCase,
	type ScriptedDecisionProviderOptions,
} from "../headless/scripted-decision-provider.ts";
export { buildChildEnvironment, type ChildEnvironmentProfile } from "../runs/shared/child-environment.ts";
export type {
	HeadlessDecision,
	HeadlessDecisionProvider,
	HeadlessDecisionRequest,
	HeadlessDecisionVerdict,
} from "../headless/decision-contract.ts";
export type { DecisionAuditRecord, DecisionAuditSink } from "../headless/decision-audit.ts";

export { createExtensionCore, type ExtensionCore, type ExtensionCoreOptions } from "./core.ts";

export { createWorkflowController, type WorkflowController } from "../workflows/controller.ts";
export { registerWorkflowTool, registerWorkflowAssetsTool } from "../workflows/tool.ts";

export default createHeadlessExtension;
