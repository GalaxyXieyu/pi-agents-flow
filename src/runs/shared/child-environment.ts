import { SUBAGENT_PARENT_SESSION_ENV } from "./pi-args.ts";

const BASE_RUNTIME_KEYS = new Set([
	"PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
	"SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PI_CODING_AGENT_DIR",
]);

const CHILD_PROTOCOL_KEYS = new Set([
	"MCP_DIRECT_TOOLS",
	"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ORCHESTRATOR_TARGET",
	"PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
	"PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_CHILD_INDEX",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_PARENT_EVENT_SINK",
	"PI_SUBAGENT_PARENT_CONTROL_INBOX",
	"PI_SUBAGENT_PARENT_ROOT_RUN_ID",
	"PI_SUBAGENT_PARENT_RUN_ID",
	"PI_SUBAGENT_PARENT_CHILD_INDEX",
	"PI_SUBAGENT_PARENT_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_SUBAGENT_PARENT_CAPABILITY_TOKEN",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_REQUIRED_TOOLS",
	"PI_SUBAGENT_MCP_DIRECT_TOOLS",
	"PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH",
	"PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS",
	"PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA",
	"PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE",
	"PI_SUBAGENT_STRUCTURED_OUTPUT_SUBMISSION_DIR",
	"PI_SUBAGENT_CAPABILITY_CEILING_V1",
	"PI_SUBAGENT_TOOL_BUDGET",
	"PI_SUBAGENT_TOOL_BUDGET_ZERO_AUTH",
	"PI_SUBAGENT_WATCHDOG_CHILD_CONFIG",
	"PI_SUBAGENT_WAIT_TOOL_ENABLED",
	"PI_SUBAGENT_STEER_INBOX",
	"PI_SUBAGENT_STEER_CAPABILITY",
	"PI_SUBAGENT_STEER_ACK_DIR",
	"PI_SUBAGENT_INHERIT_PROJECT_CONTEXT",
	"PI_SUBAGENT_INHERIT_SKILLS",
	"PI_SUBAGENT_INTERCOM_SESSION_NAME",
	"PI_INTERCOM_STABLE_ID",
	"PI_INTERCOM_SESSION_ID",
]);

const FAUX_PROVIDER_OVERLAY_KEYS = new Set([
	"PI_FAUX_PROVIDER_URL",
	"PI_FAUX_PROVIDER_MODEL",
]);

export type ChildEnvironmentProfile = "interactive" | "minimal";

export interface BuildChildEnvironmentInput {
	profile: ChildEnvironmentProfile;
	base?: NodeJS.ProcessEnv;
	overlay?: Record<string, string | undefined>;
	parentSessionId: string;
	allowModelNetwork: boolean;
}

function validatePolicy(input: BuildChildEnvironmentInput): void {
	if (input.profile === "minimal" && input.allowModelNetwork) {
		throw new Error("minimal child environment does not allow model network access");
	}
	if (input.profile === "interactive" && !input.allowModelNetwork) {
		throw new Error("interactive child environment requires model network access");
	}
}

function buildMinimalEnvironment(input: BuildChildEnvironmentInput, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of BASE_RUNTIME_KEYS) {
		const value = base[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(input.overlay ?? {})) {
		if (!BASE_RUNTIME_KEYS.has(key) && !CHILD_PROTOCOL_KEYS.has(key) && !FAUX_PROVIDER_OVERLAY_KEYS.has(key)) continue;
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

export function buildChildEnvironment(input: BuildChildEnvironmentInput): NodeJS.ProcessEnv {
	if (!input.parentSessionId.trim()) {
		throw new Error("buildChildEnvironment requires an explicit non-empty parentSessionId");
	}
	validatePolicy(input);
	const base = input.base ?? process.env;
	const env = input.profile === "interactive"
		? { ...base, ...(input.overlay ?? {}) }
		: buildMinimalEnvironment(input, base);
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete env[key];
	}
	env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId;
	return env;
}
