import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	getLegacyProjectRuntimeRoot,
	getPreferredProjectRuntimeRoot,
	getProjectArtifactsRoot,
	getProjectCompositionsDir,
	getProjectWorkflowsDir,
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
