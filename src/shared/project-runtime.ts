/**
 * Project-local runtime data for pi-agents-flow.
 *
 * New default (under Pi's project config dir):
 *   <cwd>/.pi/agents-flow/{workflows,compositions,artifacts,chain-runs}
 *
 * Legacy (still readable for migration):
 *   <cwd>/.pi-agents-flow/...
 *
 * Writes always go to the new location so project trees stay tidy under `.pi`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { getConfigDirName } from "./utils.ts";

/** Legacy top-level runtime directory (pre-.pi migration). */
export const LEGACY_PROJECT_RUNTIME_ROOT = ".pi-agents-flow";

/** Runtime leaf under the Pi project config dir (usually `.pi`). */
export const PROJECT_RUNTIME_LEAF = "agents-flow";

export function getPreferredProjectRuntimeRoot(cwd: string): string {
	return path.join(cwd, getConfigDirName(), PROJECT_RUNTIME_LEAF);
}

export function getLegacyProjectRuntimeRoot(cwd: string): string {
	return path.join(cwd, LEGACY_PROJECT_RUNTIME_ROOT);
}

function isNonEmptyDir(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

/**
 * Resolve which runtime root to use for reads.
 * Prefer the new `.pi/agents-flow` tree when it exists; otherwise fall back to
 * a non-empty legacy `.pi-agents-flow` tree so old runs remain visible.
 */
export function resolveProjectRuntimeRoot(cwd: string): string {
	const preferred = getPreferredProjectRuntimeRoot(cwd);
	if (isNonEmptyDir(preferred) || fs.existsSync(preferred)) return preferred;
	const legacy = getLegacyProjectRuntimeRoot(cwd);
	if (isNonEmptyDir(legacy)) return legacy;
	return preferred;
}

/** Always the preferred write location under `.pi`. */
export function getProjectRuntimeRootForWrite(cwd: string): string {
	return getPreferredProjectRuntimeRoot(cwd);
}

export function getProjectWorkflowsDir(cwd: string, mode: "read" | "write" = "write"): string {
	const root = mode === "write" ? getProjectRuntimeRootForWrite(cwd) : resolveProjectRuntimeRoot(cwd);
	return path.join(root, "workflows");
}

export function getProjectCompositionsDir(cwd: string, mode: "read" | "write" = "write"): string {
	const root = mode === "write" ? getProjectRuntimeRootForWrite(cwd) : resolveProjectRuntimeRoot(cwd);
	return path.join(root, "compositions");
}

export function getProjectArtifactsRoot(cwd: string, mode: "read" | "write" = "write"): string {
	const root = mode === "write" ? getProjectRuntimeRootForWrite(cwd) : resolveProjectRuntimeRoot(cwd);
	return path.join(root, "artifacts");
}

export function getProjectChainRunsRoot(cwd: string, mode: "read" | "write" = "write"): string {
	const root = mode === "write" ? getProjectRuntimeRootForWrite(cwd) : resolveProjectRuntimeRoot(cwd);
	return path.join(root, "chain-runs");
}
