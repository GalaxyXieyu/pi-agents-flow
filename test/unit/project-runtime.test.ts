import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	ensureProjectRuntimeRoot,
	getLegacyProjectRuntimeRoot,
	getPreferredProjectRuntimeRoot,
	getProjectArtifactsRoot,
	getProjectCompositionsDir,
	getProjectWorkflowsDir,
	migrateLegacyProjectRuntime,
	resolveProjectRuntimeRoot,
} from "../../src/shared/project-runtime.ts";
import {
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
} from "../../src/shared/artifacts.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("project runtime under .pi/agents-flow", () => {
	it("writes under .pi/agents-flow by default", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getPreferredProjectRuntimeRoot(cwd), path.join(cwd, ".pi", "agents-flow"));
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi", "agents-flow"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi", "agents-flow", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi", "agents-flow", "chain-runs"));
		assert.equal(getProjectWorkflowsDir(cwd, "write"), path.join(cwd, ".pi", "agents-flow", "workflows"));
		assert.equal(getProjectCompositionsDir(cwd, "write"), path.join(cwd, ".pi", "agents-flow", "compositions"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi", "agents-flow", "artifacts"));
	});

	it("reads legacy .pi-agents-flow when the new tree is empty and legacy has data", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-legacy-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "run.json"), "{}");
		assert.equal(resolveProjectRuntimeRoot(cwd), legacy);
		assert.equal(getProjectArtifactsRoot(cwd, "read"), path.join(getPreferredProjectRuntimeRoot(cwd), "artifacts"));
		// Writes still target the preferred tree.
		assert.equal(getProjectWorkflowsDir(cwd, "write"), path.join(getPreferredProjectRuntimeRoot(cwd), "workflows"));
	});

	it("does not let an empty preferred root hide non-empty legacy data", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-prefer-"));
		dirs.push(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "{}");
		fs.mkdirSync(preferred, { recursive: true });
		assert.equal(resolveProjectRuntimeRoot(cwd), legacy);
		assert.equal(getProjectWorkflowsDir(cwd, "read"), path.join(legacy, "workflows"));
	});

	it("resolves legacy leaves that have not yet been merged into a non-empty preferred tree", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-leaf-fallback-"));
		dirs.push(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(preferred, "artifacts"), { recursive: true });
		fs.writeFileSync(path.join(preferred, "artifacts", "new.txt"), "new");
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "{}");
		assert.equal(getProjectArtifactsRoot(cwd, "read"), path.join(preferred, "artifacts"));
		assert.equal(getProjectWorkflowsDir(cwd, "read"), path.join(legacy, "workflows"));
	});
});

	it("migrates a legacy tree into .pi/agents-flow when preferred is absent", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-migrate-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "run.json"), "{\"id\":1}");
		const result = migrateLegacyProjectRuntime(cwd);
		assert.equal(result.status, "migrated");
		assert.equal(fs.existsSync(legacy), false);
		assert.equal(fs.existsSync(path.join(preferred, "workflows", "run.json")), true);
		// Second call is a no-op.
		assert.equal(migrateLegacyProjectRuntime(cwd).status, "noop");
	});

	it("merges missing legacy entries without clobbering the preferred tree", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-keep-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "{}");
		fs.mkdirSync(path.join(preferred, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(preferred, "workflows", "new.json"), "{}");
		const result = ensureProjectRuntimeRoot(cwd);
		assert.equal(result.status, "merged");
		assert.equal(fs.existsSync(path.join(preferred, "workflows", "new.json")), true);
		assert.equal(fs.existsSync(path.join(preferred, "workflows", "old.json")), true);
		assert.equal(fs.existsSync(legacy), false);
	});

	it("preserves legacy conflicts while merging non-conflicting entries", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-conflict-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "same.json"), "legacy");
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "old");
		fs.mkdirSync(path.join(preferred, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(preferred, "workflows", "same.json"), "preferred");
		const result = ensureProjectRuntimeRoot(cwd);
		assert.equal(result.status, "merged");
		if (result.status === "merged") {
			assert.deepEqual(result.conflicts, [path.join("workflows", "same.json")]);
			assert.equal(result.legacyPreserved, true);
		}
		assert.equal(fs.readFileSync(path.join(preferred, "workflows", "same.json"), "utf8"), "preferred");
		assert.equal(fs.readFileSync(path.join(preferred, "workflows", "old.json"), "utf8"), "old");
		assert.equal(fs.existsSync(legacy), true);
	});

	it("does not rewrite immutable artifact objects or path-prefix lookalikes", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-immutable-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const immutableText = `object references ${legacy}${path.sep}workflows/run and ${legacy}-backup/data`;
		const objectPath = path.join(legacy, "workflows", "run", "artifacts", "objects", "aa", "object.json");
		fs.mkdirSync(path.dirname(objectPath), { recursive: true });
		fs.writeFileSync(objectPath, immutableText);
		const result = migrateLegacyProjectRuntime(cwd);
		assert.equal(result.status, "migrated");
		const migratedObject = path.join(getPreferredProjectRuntimeRoot(cwd), "workflows", "run", "artifacts", "objects", "aa", "object.json");
		assert.equal(fs.readFileSync(migratedObject, "utf8"), immutableText);
	});

	it("rewrites persisted legacy absolute paths after migration", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-rewrite-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows", "run"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "run", "manifest.json"), JSON.stringify({ materializedPath: path.join(legacy, "workflows", "run", "artifacts", "object") }));
		const result = migrateLegacyProjectRuntime(cwd);
		assert.equal(result.status, "migrated");
		const migrated = fs.readFileSync(path.join(preferred, "workflows", "run", "manifest.json"), "utf8");
		assert.match(migrated, /\.pi\/agents-flow/);
		assert.doesNotMatch(migrated, /\.pi-agents-flow/);
	});
