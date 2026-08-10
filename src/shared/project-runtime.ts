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

export type ProjectRuntimeMigrationResult =
	| { status: "noop"; reason: "no-legacy" | "preferred-exists" | "same-path" }
	| { status: "migrated"; from: string; to: string }
	| { status: "failed"; from: string; to: string; error: string };

const migratedCwds = new Set<string>();

/**
 * Best-effort one-time move of a legacy `.pi-agents-flow` tree into
 * `.pi/agents-flow` for this process/cwd.
 *
 * Safety:
 * - never overwrites an existing preferred tree
 * - never deletes the legacy tree unless rename/copy fully succeeds
 * - failures are non-fatal so runtime can still write to the preferred path
 */
export function migrateLegacyProjectRuntime(cwd: string): ProjectRuntimeMigrationResult {
	const preferred = getPreferredProjectRuntimeRoot(cwd);
	const legacy = getLegacyProjectRuntimeRoot(cwd);
	if (preferred === legacy) return { status: "noop", reason: "same-path" };

	const legacyExists = (() => {
		try { return fs.statSync(legacy).isDirectory(); } catch { return false; }
	})();
	if (!legacyExists) {
		migratedCwds.add(cwd);
		return { status: "noop", reason: "no-legacy" };
	}

	const preferredExists = (() => {
		try { return fs.existsSync(preferred); } catch { return false; }
	})();
	if (preferredExists) {
		migratedCwds.add(cwd);
		return { status: "noop", reason: "preferred-exists" };
	}

	// Avoid hammering rename after a successful migrate in this process.
	if (migratedCwds.has(cwd) && !legacyExists) {
		return { status: "noop", reason: "no-legacy" };
	}

	try {
		fs.mkdirSync(path.dirname(preferred), { recursive: true });
		fs.renameSync(legacy, preferred);
		migratedCwds.add(cwd);
		return { status: "migrated", from: legacy, to: preferred };
	} catch (renameError) {
		// Cross-device rename can fail; fall back to recursive copy then remove legacy.
		try {
			fs.cpSync(legacy, preferred, { recursive: true, errorOnExist: true, force: false });
			fs.rmSync(legacy, { recursive: true, force: true });
			migratedCwds.add(cwd);
			return { status: "migrated", from: legacy, to: preferred };
		} catch (copyError) {
			const error = copyError instanceof Error ? copyError.message : String(copyError);
			const renameMsg = renameError instanceof Error ? renameError.message : String(renameError);
			return {
				status: "failed",
				from: legacy,
				to: preferred,
				error: `rename failed (${renameMsg}); copy failed (${error})`,
			};
		}
	}
}

/**
 * Best-effort legacy migration only.
 * Does not create an empty preferred tree — leaf writers mkdir when they actually persist files,
 * so path preflight / dry launches do not litter the project with empty runtime dirs.
 */
export function ensureProjectRuntimeRoot(cwd: string): ProjectRuntimeMigrationResult {
	return migrateLegacyProjectRuntime(cwd);
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
