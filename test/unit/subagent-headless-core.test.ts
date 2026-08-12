import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executorPathDir = path.join(projectRoot, "src", "runs", "foreground");

const EXECUTOR_PATH_FILES = [
	"executor-path-chain.ts",
	"executor-path-async.ts",
	"executor-path-single.ts",
	"executor-path-parallel-helpers.ts",
	"executor-path-parallel-run.ts",
	"executor-path-parallel-types.ts",
	"executor-path-misc.ts",
	"executor-control.ts",
] as const;

describe("executor path static edge — no chain-clarify or pi-tui imports", () => {
	for (const file of EXECUTOR_PATH_FILES) {
		it(`${file} does not import chain-clarify or pi-tui`, () => {
			const filePath = path.join(executorPathDir, file);
			const source = fs.readFileSync(filePath, "utf8");
			assert.doesNotMatch(
				source,
				/from\s+["'].*chain-clarify\.ts["']/,
				`${file} must not import chain-clarify (TUI dependency)`,
			);
			assert.doesNotMatch(
				source,
				/from\s+["'].*pi-tui["']/,
				`${file} must not import pi-tui`,
			);
		});
	}
});

describe("activity core static edge — no tui/fleet or pi-tui imports", () => {
	it("activity/types.ts does not import tui/fleet or pi-tui", () => {
		const filePath = path.join(projectRoot, "src", "activity", "types.ts");
		const source = fs.readFileSync(filePath, "utf8");
		assert.doesNotMatch(source, /from\s+["'].*tui\/fleet/, "activity/types must not import tui/fleet");
		assert.doesNotMatch(source, /from\s+["'].*pi-tui/, "activity/types must not import pi-tui");
	});

	it("activity/projection.ts does not import tui/fleet or pi-tui", () => {
		const filePath = path.join(projectRoot, "src", "activity", "projection.ts");
		const source = fs.readFileSync(filePath, "utf8");
		assert.doesNotMatch(source, /from\s+["'].*tui\/fleet/, "activity/projection must not import tui/fleet");
		assert.doesNotMatch(source, /from\s+["'].*pi-tui/, "activity/projection must not import pi-tui");
	});
});

