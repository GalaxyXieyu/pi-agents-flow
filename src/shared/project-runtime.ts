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
import { randomUUID } from "node:crypto";
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

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve which runtime root to use for reads.
 * Prefer a non-empty `.pi/agents-flow` tree; an accidentally-created empty
 * preferred root must not hide non-empty legacy data.
 */
export function resolveProjectRuntimeRoot(cwd: string): string {
	const preferred = getPreferredProjectRuntimeRoot(cwd);
	if (isNonEmptyDir(preferred)) return preferred;
	const legacy = getLegacyProjectRuntimeRoot(cwd);
	if (isNonEmptyDir(legacy)) return legacy;
	return preferred;
}

function resolveProjectRuntimeSubdir(cwd: string, leaf: string): string {
	const preferred = path.join(getPreferredProjectRuntimeRoot(cwd), leaf);
	if (isNonEmptyDir(preferred) || (fs.existsSync(preferred) && !isNonEmptyDir(path.join(getLegacyProjectRuntimeRoot(cwd), leaf)))) return preferred;
	const legacy = path.join(getLegacyProjectRuntimeRoot(cwd), leaf);
	return isNonEmptyDir(legacy) ? legacy : preferred;
}

/** Always the preferred write location under `.pi`. */
export function getProjectRuntimeRootForWrite(cwd: string): string {
	return getPreferredProjectRuntimeRoot(cwd);
}

export type ProjectRuntimeMigrationResult =
	| { status: "noop"; reason: "no-legacy" | "same-path" }
	| { status: "migrated"; from: string; to: string }
	| { status: "merged"; from: string; to: string; conflicts: string[]; legacyPreserved: boolean }
	| { status: "failed"; from: string; to: string; error: string };

const migratedCwds = new Set<string>();
const RUNTIME_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt"]);

function remapRuntimePathText(value: string, legacyRoot: string, preferredRoot: string): string {
	if (value === legacyRoot) return preferredRoot;
	const legacyPrefix = `${legacyRoot}${path.sep}`;
	const preferredPrefix = `${preferredRoot}${path.sep}`;
	let updated = value.split(legacyPrefix).join(preferredPrefix);
	const escapedLegacyPrefix = JSON.stringify(legacyPrefix).slice(1, -1);
	if (escapedLegacyPrefix !== legacyPrefix) {
		const escapedPreferredPrefix = JSON.stringify(preferredPrefix).slice(1, -1);
		updated = updated.split(escapedLegacyPrefix).join(escapedPreferredPrefix);
	}
	return updated;
}

function mergeMissingRuntimeEntries(source: string, destination: string): { created: string[]; conflicts: string[] } {
	const created: string[] = [];
	const conflicts: string[] = [];
	const merge = (from: string, to: string): void => {
		if (!fs.existsSync(to)) {
			created.push(to);
			fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
			return;
		}
		const sourceStat = fs.lstatSync(from);
		const destinationStat = fs.lstatSync(to);
		if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
			for (const entry of fs.readdirSync(from)) merge(path.join(from, entry), path.join(to, entry));
			return;
		}
		conflicts.push(path.relative(source, from));
	};
	try {
		merge(source, destination);
		return { created, conflicts };
	} catch (error) {
		for (const entry of [...created].reverse()) fs.rmSync(entry, { recursive: true, force: true });
		throw error;
	}
}

function rewriteLegacyRuntimePaths(root: string, legacyRoot: string, preferredRoot: string): void {
	const rewrites: Array<{ filePath: string; original: string; updated: string }> = [];
	const visit = (entryPath: string): void => {
		const stat = fs.lstatSync(entryPath);
		if (stat.isSymbolicLink()) return;
		if (stat.isDirectory()) {
			if (path.basename(entryPath) === "objects" && path.basename(path.dirname(entryPath)) === "artifacts") return;
			for (const entry of fs.readdirSync(entryPath)) visit(path.join(entryPath, entry));
			return;
		}
		if (!stat.isFile() || !RUNTIME_TEXT_EXTENSIONS.has(path.extname(entryPath).toLowerCase())) return;
		const original = fs.readFileSync(entryPath, "utf8");
		const updated = remapRuntimePathText(original, legacyRoot, preferredRoot);
		if (updated === original) return;
		rewrites.push({ filePath: entryPath, original, updated });
	};
	if (isDirectory(root)) visit(root);
	const written: typeof rewrites = [];
	try {
		for (const rewrite of rewrites) {
			const tempPath = `${rewrite.filePath}.${process.pid}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(tempPath, rewrite.updated, "utf8");
				fs.renameSync(tempPath, rewrite.filePath);
				written.push(rewrite);
			} finally {
				fs.rmSync(tempPath, { force: true });
			}
		}
	} catch (error) {
		for (const rewrite of written.reverse()) fs.writeFileSync(rewrite.filePath, rewrite.original, "utf8");
		throw error;
	}
}

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
	if (!legacyExists && migratedCwds.has(cwd)) return { status: "noop", reason: "no-legacy" };
	if (!legacyExists) {
		try {
			rewriteLegacyRuntimePaths(preferred, legacy, preferred);
			migratedCwds.add(cwd);
			return { status: "noop", reason: "no-legacy" };
		} catch (rewriteError) {
			return { status: "failed", from: legacy, to: preferred, error: rewriteError instanceof Error ? rewriteError.message : String(rewriteError) };
		}
	}

	if (isDirectory(preferred)) {
		let created: string[] = [];
		try {
			const merged = mergeMissingRuntimeEntries(legacy, preferred);
			created = merged.created;
			rewriteLegacyRuntimePaths(preferred, legacy, preferred);
			if (merged.conflicts.length === 0) fs.rmSync(legacy, { recursive: true, force: true });
			migratedCwds.add(cwd);
			return { status: "merged", from: legacy, to: preferred, conflicts: merged.conflicts, legacyPreserved: merged.conflicts.length > 0 };
		} catch (mergeError) {
			for (const entry of [...created].reverse()) fs.rmSync(entry, { recursive: true, force: true });
			return { status: "failed", from: legacy, to: preferred, error: mergeError instanceof Error ? mergeError.message : String(mergeError) };
		}
	}

	try {
		fs.mkdirSync(path.dirname(preferred), { recursive: true });
		fs.renameSync(legacy, preferred);
		try {
			rewriteLegacyRuntimePaths(preferred, legacy, preferred);
		} catch (rewriteError) {
			fs.renameSync(preferred, legacy);
			throw rewriteError;
		}
		migratedCwds.add(cwd);
		return { status: "migrated", from: legacy, to: preferred };
	} catch (renameError) {
		try {
			const { conflicts } = mergeMissingRuntimeEntries(legacy, preferred);
			if (conflicts.length > 0) throw new Error(`unexpected conflicts while copying to a new runtime tree: ${conflicts.join(", ")}`);
			rewriteLegacyRuntimePaths(preferred, legacy, preferred);
			fs.rmSync(legacy, { recursive: true, force: true });
			migratedCwds.add(cwd);
			return { status: "migrated", from: legacy, to: preferred };
		} catch (copyError) {
			fs.rmSync(preferred, { recursive: true, force: true });
			const error = copyError instanceof Error ? copyError.message : String(copyError);
			const renameMsg = renameError instanceof Error ? renameError.message : String(renameError);
			return { status: "failed", from: legacy, to: preferred, error: `rename failed (${renameMsg}); copy failed (${error})` };
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
	return mode === "write" ? path.join(getProjectRuntimeRootForWrite(cwd), "workflows") : resolveProjectRuntimeSubdir(cwd, "workflows");
}

export function getProjectCompositionsDir(cwd: string, mode: "read" | "write" = "write"): string {
	return mode === "write" ? path.join(getProjectRuntimeRootForWrite(cwd), "compositions") : resolveProjectRuntimeSubdir(cwd, "compositions");
}

export function getProjectArtifactsRoot(cwd: string, mode: "read" | "write" = "write"): string {
	return mode === "write" ? path.join(getProjectRuntimeRootForWrite(cwd), "artifacts") : resolveProjectRuntimeSubdir(cwd, "artifacts");
}

export function getProjectChainRunsRoot(cwd: string, mode: "read" | "write" = "write"): string {
	return mode === "write" ? path.join(getProjectRuntimeRootForWrite(cwd), "chain-runs") : resolveProjectRuntimeSubdir(cwd, "chain-runs");
}
