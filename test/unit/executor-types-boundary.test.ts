import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("executor-types remains a type-only dependency leaf", () => {
	const filePath = path.join(projectRoot, "src", "runs", "foreground", "executor-types.ts");
	const source = fs.readFileSync(filePath, "utf8");
	const imports = [...source.matchAll(/^import\s+(.+?)\s+from\s+["']([^"']+)["'];/gm)];
	for (const [, clause, specifier] of imports) {
		assert.match(clause ?? "", /^type\b/, `executor-types must not value-import ${specifier}`);
	}
	assert.doesNotMatch(source, /from\s+["']\.\/executor-validation\.ts["']/, "the type leaf must not depend back on validation");
});
