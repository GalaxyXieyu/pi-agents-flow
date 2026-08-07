/**
 * Restricted, side-effect-free evaluator for composition `enableIf` expressions.
 *
 * Composition templates gate whether a workflow node is included in the final DAG
 * with an `enableIf` string (for example `hasDb && targetModule.includes("db")`).
 * That decision is made at *render time* — before anything is handed to the
 * execution engine — so the evaluator must be pure, free of side effects, and
 * guaranteed to terminate.
 *
 * ## Why this hand-written parser instead of `eval` / `new Function` / `vm`
 *
 * `enableIf` strings originate from templates that may be authored (or edited) by
 * weaker models. Handing an attacker- or mistake-controlled string to `eval`,
 * `new Function`, or the `vm` module would expose the entire host runtime:
 * filesystem, process, network, `require`, timers, and so on. This layer of the
 * project deliberately does *not* introduce a sandbox, so the only safe design is
 * to never execute the string as code at all. Instead we tokenize it and walk a
 * recursive-descent grammar that can *only* express the whitelisted operators,
 * literals, and four string helpers below. The evaluation boundary is the parser:
 * anything the grammar cannot represent is a hard error, never an executed side
 * effect. There is intentionally no dynamic code execution path anywhere here.
 *
 * ## Why an unknown identifier is a hard error (not `false`)
 *
 * Every operand identifier must be a param that was already declared and assigned.
 * A typo like `hasDbb` must fail loudly rather than silently evaluate to `false`
 * or `undefined`. If unknown names quietly became falsey, a weaker model that
 * misspelled a param would silently drop a workflow node from the DAG with no
 * diagnostic — the worst kind of failure to debug. Failing explicitly lets the
 * author (human or model) see and correct the mistake immediately.
 *
 * ## Supported grammar (kept intentionally narrow)
 *
 * - Operands: declared param identifiers, single/double quoted string literals
 *   (with `\\` and escaped-quote support), numeric literals, `true`, `false`.
 * - Comparison: `===` `!==` `>` `<` `>=` `<=`.
 * - Logic: `&&` `||` `!`.
 * - Parenthesized grouping `( )`.
 * - Four postfix helpers on strings only: `includes(x)`, `startsWith(x)`,
 *   `endsWith(x)` (string arg, boolean result) and `length` (property access,
 *   numeric result).
 * - Precedence, lowest to highest: `||` -> `&&` -> comparison -> unary `!` ->
 *   postfix helper -> primary.
 *
 * Everything else is rejected: assignment, loose equality (`==` / `!=`),
 * increment, commas, arbitrary calls, member chains like `a.b.c`, template
 * literals, regex, `this`, and any global object name. The final result must be a
 * boolean.
 */

export type CompositionParamValue = string | number | boolean;

export interface CompositionExprResult {
	ok: boolean;
	value?: boolean;
	error?: string;
}

/** Hardest ceiling on input size, to reject pathological inputs up front. */
const MAX_SOURCE_LENGTH = 1024;

/** Postfix helpers that take a single string argument and return a boolean. */
const STRING_METHODS = new Set(["includes", "startsWith", "endsWith"]);

type TokenType =
	| "identifier"
	| "string"
	| "number"
	| "true"
	| "false"
	| "op"
	| "dot"
	| "lparen"
	| "rparen"
	| "comma"
	| "eof";

interface Token {
	type: TokenType;
	/** Raw operator text for `op`, decoded contents for `string`, source text otherwise. */
	value: string;
	/** Zero-based index into the source where this token starts. */
	start: number;
}

/** Marker error type so evaluation failures are distinguishable from real bugs. */
class ExprError extends Error {}

/**
 * Evaluate a composition `enableIf` expression against a table of already
 * declared and assigned params.
 *
 * Returns `{ ok: true, value }` with a boolean `value` on success, or
 * `{ ok: false, error }` with a specific, actionable message on any failure. It
 * never throws for malformed input and never executes the source as code.
 */
export function evaluateCompositionExpr(
	source: string,
	params: Readonly<Record<string, CompositionParamValue>>,
): CompositionExprResult {
	try {
		if (source.length > MAX_SOURCE_LENGTH) {
			throw new ExprError(`expression is ${source.length} characters, which exceeds the ${MAX_SOURCE_LENGTH} character limit`);
		}
		const tokens = tokenize(source);
		if (tokens.length === 1 && tokens[0].type === "eof") {
			throw new ExprError("empty expression: expected a boolean condition");
		}
		const parser = new Parser(tokens, params);
		const value = parser.parseExpression();
		parser.expectEnd();
		if (typeof value !== "boolean") {
			throw new ExprError(`expression must evaluate to a boolean, but got ${typeof value} (${formatValue(value)})`);
		}
		return { ok: true, value };
	} catch (error) {
		if (error instanceof ExprError) {
			return { ok: false, error: error.message };
		}
		throw error;
	}
}

function isIdentifierStart(char: string): boolean {
	return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$";
}

function isIdentifierPart(char: string): boolean {
	return isIdentifierStart(char) || (char >= "0" && char <= "9");
}

function isDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = source.length;
	while (i < n) {
		const char = source[i];
		if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") {
			i++;
			continue;
		}
		const start = i;
		if (isIdentifierStart(char)) {
			i++;
			while (i < n && isIdentifierPart(source[i])) i++;
			const text = source.slice(start, i);
			if (text === "true" || text === "false") {
				tokens.push({ type: text, value: text, start });
			} else {
				tokens.push({ type: "identifier", value: text, start });
			}
			continue;
		}
		if (isDigit(char)) {
			i++;
			while (i < n && isDigit(source[i])) i++;
			if (i < n && source[i] === ".") {
				i++;
				if (i >= n || !isDigit(source[i])) {
					throw new ExprError(`malformed number at position ${start}: a decimal point must be followed by a digit`);
				}
				while (i < n && isDigit(source[i])) i++;
			}
			tokens.push({ type: "number", value: source.slice(start, i), start });
			continue;
		}
		if (char === "'" || char === '"') {
			const quote = char;
			i++;
			let decoded = "";
			while (i < n && source[i] !== quote) {
				if (source[i] === "\\") {
					const escaped = source[i + 1];
					if (escaped === "\\" || escaped === quote) {
						decoded += escaped;
						i += 2;
						continue;
					}
					throw new ExprError(`invalid escape sequence "\\${escaped ?? ""}" at position ${i}: only \\\\ and \\${quote} are supported`);
				}
				decoded += source[i];
				i++;
			}
			if (i >= n) {
				throw new ExprError(`unclosed string literal starting at position ${start}`);
			}
			i++;
			tokens.push({ type: "string", value: decoded, start });
			continue;
		}
		if (char === "(") {
			tokens.push({ type: "lparen", value: "(", start });
			i++;
			continue;
		}
		if (char === ")") {
			tokens.push({ type: "rparen", value: ")", start });
			i++;
			continue;
		}
		if (char === ".") {
			tokens.push({ type: "dot", value: ".", start });
			i++;
			continue;
		}
		if (char === ",") {
			tokens.push({ type: "comma", value: ",", start });
			i++;
			continue;
		}
		if (char === "&") {
			if (source[i + 1] === "&") {
				tokens.push({ type: "op", value: "&&", start });
				i += 2;
				continue;
			}
			throw new ExprError(`unexpected "&" at position ${start}: use "&&" for logical and`);
		}
		if (char === "|") {
			if (source[i + 1] === "|") {
				tokens.push({ type: "op", value: "||", start });
				i += 2;
				continue;
			}
			throw new ExprError(`unexpected "|" at position ${start}: use "||" for logical or`);
		}
		if (char === "=") {
			if (source.startsWith("===", i)) {
				tokens.push({ type: "op", value: "===", start });
				i += 3;
				continue;
			}
			if (source.startsWith("==", i)) {
				throw new ExprError(`loose equality "==" at position ${start} is not allowed: use strict "==="`);
			}
			throw new ExprError(`unexpected "=" at position ${start}: assignment is not allowed`);
		}
		if (char === "!") {
			if (source.startsWith("!==", i)) {
				tokens.push({ type: "op", value: "!==", start });
				i += 3;
				continue;
			}
			if (source.startsWith("!=", i)) {
				throw new ExprError(`loose inequality "!=" at position ${start} is not allowed: use strict "!=="`);
			}
			tokens.push({ type: "op", value: "!", start });
			i++;
			continue;
		}
		if (char === ">") {
			if (source[i + 1] === "=") {
				tokens.push({ type: "op", value: ">=", start });
				i += 2;
			} else {
				tokens.push({ type: "op", value: ">", start });
				i++;
			}
			continue;
		}
		if (char === "<") {
			if (source[i + 1] === "=") {
				tokens.push({ type: "op", value: "<=", start });
				i += 2;
			} else {
				tokens.push({ type: "op", value: "<", start });
				i++;
			}
			continue;
		}
		throw new ExprError(`unexpected character "${char}" at position ${start}`);
	}
	tokens.push({ type: "eof", value: "", start: n });
	return tokens;
}

function formatValue(value: CompositionParamValue): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function describeToken(token: Token): string {
	if (token.type === "eof") return "end of input";
	if (token.type === "string") return `string literal ${JSON.stringify(token.value)}`;
	return `"${token.value}"`;
}

class Parser {
	tokens: Token[];
	params: Readonly<Record<string, CompositionParamValue>>;
	pos: number;

	constructor(tokens: Token[], params: Readonly<Record<string, CompositionParamValue>>) {
		this.tokens = tokens;
		this.params = params;
		this.pos = 0;
	}

	peek(): Token {
		return this.tokens[this.pos];
	}

	advance(): Token {
		return this.tokens[this.pos++];
	}

	expectEnd(): void {
		const token = this.peek();
		if (token.type !== "eof") {
			throw new ExprError(`unexpected trailing token ${describeToken(token)} at position ${token.start}`);
		}
	}

	parseExpression(): CompositionParamValue {
		return this.parseOr();
	}

	parseOr(): CompositionParamValue {
		let left = this.parseAnd();
		while (this.peek().type === "op" && this.peek().value === "||") {
			this.advance();
			const right = this.parseAnd();
			left = requireBoolean(left, 'left operand of "||"') || requireBoolean(right, 'right operand of "||"');
		}
		return left;
	}

	parseAnd(): CompositionParamValue {
		let left = this.parseComparison();
		while (this.peek().type === "op" && this.peek().value === "&&") {
			this.advance();
			const right = this.parseComparison();
			left = requireBoolean(left, 'left operand of "&&"') && requireBoolean(right, 'right operand of "&&"');
		}
		return left;
	}

	parseComparison(): CompositionParamValue {
		const left = this.parseUnary();
		const token = this.peek();
		if (token.type === "op" && (token.value === "===" || token.value === "!==" || token.value === ">" || token.value === "<" || token.value === ">=" || token.value === "<=")) {
			this.advance();
			const right = this.parseUnary();
			return applyComparison(token.value, left, right);
		}
		return left;
	}

	parseUnary(): CompositionParamValue {
		const token = this.peek();
		if (token.type === "op" && token.value === "!") {
			this.advance();
			const operand = this.parseUnary();
			return !requireBoolean(operand, 'operand of "!"');
		}
		return this.parsePostfix();
	}

	parsePostfix(): CompositionParamValue {
		let value = this.parsePrimary();
		while (this.peek().type === "dot") {
			const dot = this.advance();
			const name = this.peek();
			if (name.type !== "identifier") {
				throw new ExprError(`expected a method or property name after "." at position ${dot.start}, but found ${describeToken(name)}`);
			}
			this.advance();
			if (name.value === "length") {
				if (this.peek().type === "lparen") {
					throw new ExprError(`"length" at position ${name.start} is a property, not a method: remove the "()"`);
				}
				if (typeof value !== "string") {
					throw new ExprError(`".length" requires a string operand, but got ${typeof value} (${formatValue(value)})`);
				}
				value = value.length;
				continue;
			}
			if (STRING_METHODS.has(name.value)) {
				const arg = this.parseCallArgument(name.value);
				if (typeof value !== "string") {
					throw new ExprError(`".${name.value}(...)" requires a string operand, but got ${typeof value} (${formatValue(value)})`);
				}
				if (typeof arg !== "string") {
					throw new ExprError(`".${name.value}(...)" requires a string argument, but got ${typeof arg} (${formatValue(arg)})`);
				}
				value = name.value === "includes"
					? value.includes(arg)
					: name.value === "startsWith"
						? value.startsWith(arg)
						: value.endsWith(arg);
				continue;
			}
			throw new ExprError(`unknown method or property "${name.value}" at position ${name.start}: only includes(), startsWith(), endsWith(), and length are allowed`);
		}
		return value;
	}

	parseCallArgument(method: string): CompositionParamValue {
		const open = this.peek();
		if (open.type !== "lparen") {
			throw new ExprError(`"${method}" is a method and must be called with "(...)" at position ${open.start}`);
		}
		this.advance();
		const arg = this.parseExpression();
		const close = this.peek();
		if (close.type === "comma") {
			throw new ExprError(`"${method}(...)" takes exactly one argument, but found "," at position ${close.start}`);
		}
		if (close.type !== "rparen") {
			throw new ExprError(`expected ")" to close "${method}(...)" at position ${close.start}, but found ${describeToken(close)}`);
		}
		this.advance();
		return arg;
	}

	parsePrimary(): CompositionParamValue {
		const token = this.peek();
		if (token.type === "lparen") {
			this.advance();
			const value = this.parseExpression();
			const close = this.peek();
			if (close.type !== "rparen") {
				throw new ExprError(`unclosed parenthesis: expected ")" at position ${close.start}, but found ${describeToken(close)}`);
			}
			this.advance();
			return value;
		}
		if (token.type === "true" || token.type === "false") {
			this.advance();
			return token.type === "true";
		}
		if (token.type === "number") {
			this.advance();
			return Number(token.value);
		}
		if (token.type === "string") {
			this.advance();
			return token.value;
		}
		if (token.type === "identifier") {
			this.advance();
			if (!Object.hasOwn(this.params, token.value)) {
				const declared = Object.keys(this.params);
				const suffix = declared.length > 0 ? `declared params: ${declared.join(", ")}` : "no params are declared";
				throw new ExprError(`unknown identifier "${token.value}" at position ${token.start}: it is not a declared param (${suffix})`);
			}
			return this.params[token.value];
		}
		throw new ExprError(`unexpected token ${describeToken(token)} at position ${token.start}: expected a value`);
	}
}

function requireBoolean(value: CompositionParamValue, context: string): boolean {
	if (typeof value !== "boolean") {
		throw new ExprError(`${context} must be a boolean, but got ${typeof value} (${formatValue(value)})`);
	}
	return value;
}

function applyComparison(op: string, left: CompositionParamValue, right: CompositionParamValue): boolean {
	if (op === "===" || op === "!==") {
		if (typeof left !== typeof right) {
			throw new ExprError(`strict equality "${op}" requires operands of the same type, but got ${typeof left} (${formatValue(left)}) and ${typeof right} (${formatValue(right)})`);
		}
		const equal = left === right;
		return op === "===" ? equal : !equal;
	}
	if (typeof left !== "number" || typeof right !== "number") {
		throw new ExprError(`"${op}" requires numeric operands, but got ${typeof left} (${formatValue(left)}) and ${typeof right} (${formatValue(right)})`);
	}
	if (op === ">") return left > right;
	if (op === "<") return left < right;
	if (op === ">=") return left >= right;
	return left <= right;
}
