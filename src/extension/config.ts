import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactDirPreference, ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";
import { MAX_WORKFLOW_MAX_NODE_ATTEMPTS } from "../workflows/retry-policy.ts";

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>(["project", "session", "temp"]);
const WORKFLOW_LANGUAGES = new Set(["auto", "zh", "en"]);

/** Hard upper bound accepted for `workflowConcurrency`, matching the tool schema. */
export const MAX_WORKFLOW_CONCURRENCY = 32;
/** Workflow children allowed to run at once when nothing is configured. */
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
	}
	const config = parsed as Record<string, unknown>;
	if (config.artifactDir !== undefined && !ARTIFACT_DIR_PREFERENCES.has(config.artifactDir as ArtifactDirPreference)) {
		throw new Error(`config.artifactDir must be "project", "session", or "temp"`);
	}
	if (config.workflowLanguage !== undefined && !WORKFLOW_LANGUAGES.has(config.workflowLanguage as string)) {
		throw new Error(`config.workflowLanguage must be "auto", "zh", or "en"`);
	}
	if (config.workflowConcurrency !== undefined) {
		const value = config.workflowConcurrency;
		if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_WORKFLOW_CONCURRENCY) {
			throw new Error(`config.workflowConcurrency must be an integer between 1 and ${MAX_WORKFLOW_CONCURRENCY}`);
		}
	}
	if (config.workflowMaxNodeAttempts !== undefined) {
		const value = config.workflowMaxNodeAttempts;
		if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_WORKFLOW_MAX_NODE_ATTEMPTS) {
			throw new Error(`config.workflowMaxNodeAttempts must be an integer between 1 and ${MAX_WORKFLOW_MAX_NODE_ATTEMPTS}`);
		}
	}
	return parsed as ExtensionConfig;
}

export function saveConfig(config: ExtensionConfig, configPath = getConfigPath()): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

export function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig {
	const configPath = getConfigPath();
	const next = updater(readConfigForUpdate(configPath));
	saveConfig(next, configPath);
	return next;
}

export function loadConfig(): ExtensionConfig {
	const configPath = getConfigPath();
	try {
		return readConfigForUpdate(configPath);
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
