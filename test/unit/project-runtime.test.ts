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
		assert.equal(getProjectArtifactsRoot(cwd, "read"), path.join(legacy, "artifacts"));
		// Writes still target the preferred tree.
		assert.equal(getProjectWorkflowsDir(cwd, "write"), path.join(getPreferredProjectRuntimeRoot(cwd), "workflows"));
	});

	it("prefers .pi/agents-flow once it exists even if legacy remains", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-prefer-"));
		dirs.push(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "{}");
		fs.mkdirSync(preferred, { recursive: true });
		assert.equal(resolveProjectRuntimeRoot(cwd), preferred);
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

	it("does not clobber an existing preferred tree during migration", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-keep-"));
		dirs.push(cwd);
		const legacy = getLegacyProjectRuntimeRoot(cwd);
		const preferred = getPreferredProjectRuntimeRoot(cwd);
		fs.mkdirSync(path.join(legacy, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "workflows", "old.json"), "{}");
		fs.mkdirSync(path.join(preferred, "workflows"), { recursive: true });
		fs.writeFileSync(path.join(preferred, "workflows", "new.json"), "{}");
		const result = ensureProjectRuntimeRoot(cwd);
		assert.equal(result.status, "noop");
		assert.equal(fs.existsSync(path.join(preferred, "workflows", "new.json")), true);
		assert.equal(fs.existsSync(path.join(legacy, "workflows", "old.json")), true);
	});
