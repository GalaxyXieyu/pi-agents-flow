import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateCompositionExpr, type CompositionParamValue } from "../../src/workflows/composition-expr.ts";

function ok(source: string, params: Readonly<Record<string, CompositionParamValue>> = {}): boolean {
	const result = evaluateCompositionExpr(source, params);
	assert.equal(result.ok, true, `expected ok for ${JSON.stringify(source)}, got error: ${result.error}`);
	assert.equal(typeof result.value, "boolean");
	return result.value as boolean;
}

function fail(source: string, params: Readonly<Record<string, CompositionParamValue>> = {}): string {
	const result = evaluateCompositionExpr(source, params);
	assert.equal(result.ok, false, `expected failure for ${JSON.stringify(source)}, got value: ${result.value}`);
	assert.equal(result.value, undefined);
	assert.equal(typeof result.error, "string");
	return result.error as string;
}

describe("composition-expr operators and helpers", () => {
	it("uses a bare boolean param as a switch", () => {
		assert.equal(ok("hasDb", { hasDb: true }), true);
		assert.equal(ok("hasDb", { hasDb: false }), false);
	});

	it("evaluates true and false literals", () => {
		assert.equal(ok("true"), true);
		assert.equal(ok("false"), false);
	});

	it("evaluates strict equality on strings", () => {
		assert.equal(ok('targetModule === "payments"', { targetModule: "payments" }), true);
		assert.equal(ok('targetModule === "payments"', { targetModule: "auth" }), false);
	});

	it("evaluates strict inequality", () => {
		assert.equal(ok('targetModule !== "payments"', { targetModule: "auth" }), true);
		assert.equal(ok("count !== 3", { count: 3 }), false);
	});

	it("evaluates numeric comparisons", () => {
		assert.equal(ok("count > 3", { count: 4 }), true);
		assert.equal(ok("count < 3", { count: 4 }), false);
		assert.equal(ok("count >= 3", { count: 3 }), true);
		assert.equal(ok("count <= 3", { count: 3 }), true);
		assert.equal(ok("count === 3", { count: 3 }), true);
	});

	it("evaluates logical and, or, not", () => {
		assert.equal(ok("a && b", { a: true, b: true }), true);
		assert.equal(ok("a && b", { a: true, b: false }), false);
		assert.equal(ok("a || b", { a: false, b: true }), true);
		assert.equal(ok("a || b", { a: false, b: false }), false);
		assert.equal(ok("!a", { a: false }), true);
		assert.equal(ok("!a", { a: true }), false);
	});

	it("evaluates parenthesized grouping", () => {
		assert.equal(ok("(a || b) && c", { a: false, b: true, c: true }), true);
		assert.equal(ok("(a || b) && c", { a: false, b: true, c: false }), false);
	});

	it("supports includes, startsWith, endsWith on strings", () => {
		assert.equal(ok('targetModule.includes("db")', { targetModule: "orders-db" }), true);
		assert.equal(ok('targetModule.includes("db")', { targetModule: "orders" }), false);
		assert.equal(ok('name.startsWith("svc-")', { name: "svc-auth" }), true);
		assert.equal(ok('name.startsWith("svc-")', { name: "auth" }), false);
		assert.equal(ok('name.endsWith("-db")', { name: "orders-db" }), true);
		assert.equal(ok('name.endsWith("-db")', { name: "orders" }), false);
	});

	it("supports length as a property returning a number", () => {
		assert.equal(ok("name.length > 3", { name: "auth" }), true);
		assert.equal(ok("name.length > 3", { name: "db" }), false);
		assert.equal(ok("name.length === 4", { name: "auth" }), true);
	});

	it("accepts a param as a method argument", () => {
		assert.equal(ok("target.includes(needle)", { target: "orders-db", needle: "db" }), true);
	});

	it("handles escaped quotes and backslashes in string literals", () => {
		assert.equal(ok('label === "a\\"b"', { label: 'a"b' }), true);
		assert.equal(ok("label === 'a\\\\b'", { label: "a\\b" }), true);
		assert.equal(ok("label === 'it\\'s'", { label: "it's" }), true);
	});
});

describe("composition-expr operator precedence", () => {
	it("binds && tighter than ||", () => {
		// false || (true && false) === false; if || bound tighter it would be (false||true)&&false === false too,
		// so use a case that distinguishes: true || (false && false) === true.
		assert.equal(ok("t || f && f", { t: true, f: false }), true);
		// (f && f) is false, then t || false === true. If && were looser: (t||f) && f === false.
		assert.equal(ok("f && f || t", { t: true, f: false }), true);
	});

	it("binds ! tighter than comparison and applies to grouped comparisons", () => {
		assert.equal(ok("!(count > 3)", { count: 2 }), true);
		assert.equal(ok("!(count > 3)", { count: 5 }), false);
		assert.equal(ok("!a === b", { a: true, b: false }), true);
	});

	it("binds comparison tighter than && and ||", () => {
		assert.equal(ok('env === "prod" && count > 1', { env: "prod", count: 2 }), true);
		assert.equal(ok('env === "prod" && count > 1', { env: "dev", count: 2 }), false);
	});
});

describe("composition-expr rejections", () => {
	it("rejects an unknown identifier instead of treating it as false", () => {
		const error = fail("hasDbb", { hasDb: true });
		assert.match(error, /unknown identifier/);
		assert.match(error, /hasDbb/);
		assert.match(error, /hasDb/);
	});

	it("rejects a non-boolean final result", () => {
		assert.match(fail("targetModule", { targetModule: "db" }), /must evaluate to a boolean/);
		assert.match(fail("name.length", { name: "auth" }), /must evaluate to a boolean/);
		assert.match(fail("count", { count: 3 }), /must evaluate to a boolean/);
	});

	it("rejects assignment", () => {
		assert.match(fail("a=1", { a: true }), /assignment is not allowed/);
	});

	it("rejects loose equality and inequality", () => {
		assert.match(fail('x == "y"', { x: "y" }), /loose equality.*not allowed/);
		assert.match(fail('x != "y"', { x: "y" }), /loose inequality.*not allowed/);
	});

	it("rejects commas and multi-argument calls", () => {
		assert.match(fail('name.includes("a", "b")', { name: "ab" }), /exactly one argument/);
	});

	it("rejects arbitrary function calls outside the whitelist", () => {
		// A direct call on an identifier: the identifier itself is unknown, and even a
		// declared one cannot be "called" because calls are not part of the grammar.
		assert.match(fail("doThing()", { doThing: true }), /unknown identifier|trailing token/);
		assert.match(fail('name.toUpperCase()', { name: "auth" }), /unknown method or property/);
	});

	it("rejects member access chains like a.b.c", () => {
		assert.match(fail("a.b.c", { a: true }), /unknown method or property/);
	});

	it("rejects using length with parentheses", () => {
		assert.match(fail("name.length()", { name: "auth" }), /property, not a method/);
	});

	it("rejects unclosed parentheses", () => {
		assert.match(fail("(a || b", { a: true, b: false }), /unclosed parenthesis|expected "\)"/);
	});

	it("rejects unclosed string literals", () => {
		assert.match(fail('name === "db', { name: "db" }), /unclosed string literal/);
	});

	it("rejects trailing tokens and syntax errors", () => {
		assert.match(fail("a b", { a: true, b: true }), /trailing token/);
		assert.match(fail("&&", {}), /unexpected|value/);
	});

	it("rejects type-mismatched comparisons", () => {
		assert.match(fail("flag > 3", { flag: true }), /numeric operands/);
		assert.match(fail('count.includes("x")', { count: 3 }), /string operand/);
		assert.match(fail("num.length > 0", { num: 5 }), /string operand/);
	});

	it("rejects strict equality across mismatched types", () => {
		assert.match(fail('count === "3"', { count: 3 }), /same type/);
	});

	it("rejects logical operators on non-booleans", () => {
		assert.match(fail("name && flag", { name: "auth", flag: true }), /must be a boolean/);
		assert.match(fail("count || flag", { count: 3, flag: true }), /must be a boolean/);
		assert.match(fail("!name", { name: "auth" }), /must be a boolean/);
	});

	it("rejects empty or whitespace-only expressions", () => {
		assert.match(fail("", {}), /empty expression/);
		assert.match(fail("   \t\n ", {}), /empty expression/);
	});

	it("rejects input over the length limit", () => {
		const long = `${"a".repeat(2000)}`;
		assert.match(fail(long, { a: true }), /exceeds the 1024 character limit/);
	});

	it("rejects malformed numbers", () => {
		assert.match(fail("count === 3.", { count: 3 }), /malformed number/);
	});
});

describe("composition-expr injection safety", () => {
	it("never executes eval-style payloads and returns ok:false", () => {
		// None of these must run anything; each must be a safe parse/eval failure.
		assert.equal(evaluateCompositionExpr("process.exit(1)", {}).ok, false);
		assert.equal(evaluateCompositionExpr("(()=>1)()", {}).ok, false);
		assert.equal(evaluateCompositionExpr("a=1", {}).ok, false);
		assert.equal(evaluateCompositionExpr("require('fs')", {}).ok, false);
		assert.equal(evaluateCompositionExpr("this.constructor", {}).ok, false);
		assert.equal(evaluateCompositionExpr("globalThis", {}).ok, false);
		assert.equal(evaluateCompositionExpr("`${1}`", {}).ok, false);
	});

	it("reports unknown identifiers for global object names", () => {
		assert.match(fail("process.exit(1)", {}), /unknown identifier/);
		assert.match(fail("require('fs')", {}), /unknown identifier/);
	});
});
