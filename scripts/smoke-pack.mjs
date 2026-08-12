import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-pack-"));
const packDir = path.join(tempRoot, "pack");
const installDir = path.join(tempRoot, "install");
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

function npm(args, cwd) {
	return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

try {
	const packed = JSON.parse(npm(["pack", packageRoot, "--json", "--pack-destination", packDir], packageRoot));
	assert.equal(Array.isArray(packed), true);
	const entry = packed[0];
	assert.equal(entry?.name, "pi-agents-flow");
	assert.equal(entry?.version, "0.1.0-alpha.2");
	const files = new Set((entry?.files ?? []).map((file) => file.path));
	for (const required of [
		"index.ts",
		"README.md",
		"TEACHING.md",
		"SECURITY.md",
		"CONTRIBUTING.md",
		"SUPPORT.md",
		"RELEASING.md",
		"UPSTREAM.md",
		"docs/pi-agents-flow-overview.zh-CN.md",
		"docs/images/pi-agents-flow-activity-dock.png",
	]) {
		assert.equal(files.has(required), true, `packed tarball is missing ${required}`);
	}

	fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "pi-agents-flow-smoke", private: true, type: "module" }, null, 2));
	const tarball = path.join(packDir, entry.filename);
	npm([
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		tarball,
		"@earendil-works/pi-agent-core@0.81.0",
		"@earendil-works/pi-ai@0.81.0",
		"@earendil-works/pi-coding-agent@0.81.0",
		"@earendil-works/pi-tui@0.81.0",
	], installDir);

	const installedPackage = JSON.parse(fs.readFileSync(path.join(installDir, "node_modules", "pi-agents-flow", "package.json"), "utf8"));
	assert.equal(installedPackage.name, "pi-agents-flow");
	assert.equal(installedPackage.pi.extensions[0], "./index.ts");
	const importScript = path.join(installDir, "smoke.mjs");
	fs.writeFileSync(importScript, [
		'import { createJiti } from "jiti";',
		'const jiti = createJiti(import.meta.url);',
		'const extensionModule = await jiti.import("pi-agents-flow");',
		'const background = await jiti.import("pi-agents-flow/background-work");',
		'const capability = await jiti.import("pi-agents-flow/capability-ceiling");',
		'const delegation = await jiti.import("pi-agents-flow/delegation");',
		'const preflight = await jiti.import("pi-agents-flow/preflight");',
		'if (typeof extensionModule.default !== "function") throw new Error("default extension export is not callable");',
		'if (background.BACKGROUND_WORK_PROTOCOL_VERSION !== 1) throw new Error("background-work export mismatch");',
		'if (capability.SUBAGENT_CAPABILITY_CEILING_VERSION !== 1) throw new Error("capability export mismatch");',
		'if (delegation.SUBAGENT_DELEGATION_PROTOCOL_VERSION !== 2) throw new Error("delegation export mismatch");',
		'if (preflight.SUBAGENT_LAUNCH_CONTRACT_VERSION !== 2) throw new Error("preflight export mismatch");',
	].join("\n"));
	execFileSync(process.execPath, [importScript], { cwd: installDir, stdio: "inherit" });
	console.log(`Tarball smoke passed: ${entry.filename} (${entry.size} bytes, ${entry.unpackedSize} unpacked).`);
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
