import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

// These tests assert the *end* of the grant pipeline: that per-launch extraTools
// grants and denyTools revocations actually reach the child's `--tools` CLI
// argument, and that the capability ceiling still clamps them.
describe("buildPiArgs per-launch tool grants", () => {
	const base = {
		baseArgs: [] as string[],
		task: "test",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
	};

	function toolsArg(args: string[]): string[] {
		const idx = args.indexOf("--tools");
		if (idx === -1) return [];
		return (args[idx + 1] ?? "").split(",").filter((entry) => entry.length > 0);
	}

	it("adds an extraTools grant to the child --tools allowlist", () => {
		const { args } = buildPiArgs({
			...base,
			tools: ["read"],
			extraTools: ["write"],
		});
		const tools = toolsArg(args);
		assert.ok(args.includes("--tools"));
		assert.ok(tools.includes("write"), `expected write in --tools, got ${tools.join(",")}`);
		assert.ok(tools.includes("read"));
	});

	it("removes a denyTools entry from the child --tools allowlist", () => {
		const { args } = buildPiArgs({
			...base,
			tools: ["read", "bash"],
			denyTools: ["bash"],
		});
		const tools = toolsArg(args);
		assert.ok(args.includes("--tools"));
		assert.ok(tools.includes("read"));
		assert.equal(tools.includes("bash"), false, `bash must not survive denyTools, got ${tools.join(",")}`);
		assert.equal(args.includes("bash"), false);
	});

	it("keeps the capability ceiling as a hard cap that a grant cannot widen", () => {
		const { args } = buildPiArgs({
			...base,
			tools: ["read", "write"],
			extraTools: ["bash"],
			capabilityCeiling: { version: 1, allowedTools: ["read", "write"], denyExtensions: false, sources: ["test"] },
		});
		const tools = toolsArg(args);
		assert.ok(tools.includes("read"));
		assert.ok(tools.includes("write"));
		assert.equal(tools.includes("bash"), false, `ceiling must block granted bash, got ${tools.join(",")}`);
		assert.equal(args.includes("bash"), false);
	});
});
