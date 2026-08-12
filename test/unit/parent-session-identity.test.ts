import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	ParentSessionIdentityError,
	resolveRequiredParentSessionId,
} from "../../src/shared/session-identity.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relative: string): string {
	return fs.readFileSync(path.join(projectRoot, relative), "utf-8");
}

describe("required parent session identity", () => {
	it("returns a trimmed platform session identity", () => {
		assert.equal(resolveRequiredParentSessionId({ getSessionId: () => "  parent-123  " }), "parent-123");
	});

	for (const missing of [null, undefined, "", "   "] as const) {
		it(`fails closed for ${String(missing)} before a launch callback can run`, () => {
			let spawned = 0;
			assert.throws(() => {
				const parentSessionId = resolveRequiredParentSessionId({ getSessionId: () => missing });
				spawned += 1;
				return parentSessionId;
			}, (error: unknown) => {
				assert.ok(error instanceof ParentSessionIdentityError);
				assert.equal(error.code, "PARENT_SESSION_IDENTITY_REQUIRED");
				return true;
			});
			assert.equal(spawned, 0);
		});
	}

	it("resolves identity at single, chain, parallel, async, and control production launch boundaries", () => {
		const cases = [
			["single", "src/runs/foreground/executor-path-single.ts"],
			["chain", "src/runs/foreground/executor-path-chain.ts"],
			["parallel", "src/runs/foreground/executor-path-parallel-run.ts"],
			["async", "src/runs/foreground/executor-path-async.ts"],
			["control", "src/runs/foreground/executor-control.ts"],
		] as const;
		for (const [label, relative] of cases) {
			const content = source(relative);
			assert.match(content, /resolveRequiredParentSessionId\s*\(/, `${label} must resolve required identity`);
			assert.doesNotMatch(content, /getSessionId\(\)\s*\?\?\s*undefined/, `${label} must not pass optional identity`);
		}
	});

	it("contains no child-launch non-null assertion in production run sources", () => {
		const runRoot = path.join(projectRoot, "src", "runs");
		const files: string[] = [];
		const visit = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const target = path.join(dir, entry.name);
				if (entry.isDirectory()) visit(target);
				else if (entry.name.endsWith(".ts")) files.push(target);
			}
		};
		visit(runRoot);
		for (const file of files) {
			assert.doesNotMatch(fs.readFileSync(file, "utf-8"), /parentSessionId!/, path.relative(projectRoot, file));
		}
	});
});
