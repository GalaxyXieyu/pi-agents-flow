import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildChildEnvironment } from "../../src/runs/shared/child-environment.ts";
import { SUBAGENT_PARENT_SESSION_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ambient = {
	PATH: "/usr/local/bin:/usr/bin",
	HOME: "/home/runtime",
	TMPDIR: "/tmp/runtime",
	PI_CODING_AGENT_DIR: "/home/runtime/.pi/agent",
	NODE_OPTIONS: "--enable-source-maps",
	NODE_PATH: "/ambient/node_modules",
	OPENAI_API_KEY: "secret-provider-key",
	GITHUB_TOKEN: "secret-token",
	AWS_SECRET_ACCESS_KEY: "secret-aws",
	DATABASE_URL: "postgres://secret",
	MCP_SERVERS: "ambient-mcp",
	PI_EXTENSIONS: "ambient-extension",
	UNKNOWN_AMBIENT: "must-not-pass",
};

describe("child environment profiles", () => {
	it("allows minimal children only the explicit Node/Pi runtime baseline plus protocol overlay", () => {
		const env = buildChildEnvironment({
			profile: "minimal",
			base: ambient,
			overlay: {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_RUN_ID: "run-1",
				PI_CODING_AGENT_DIR: "/isolated/pi",
				OPENAI_API_KEY: "overlay-secret",
				MCP_SERVERS: "overlay-mcp",
				PI_EXTENSIONS: "overlay-extension",
				UNKNOWN_AMBIENT: "overlay-unknown",
			},
			parentSessionId: "parent-1",
			allowModelNetwork: false,
		});

		assert.equal(env.PATH, ambient.PATH);
		assert.equal(env.HOME, ambient.HOME);
		assert.equal(env.TMPDIR, ambient.TMPDIR);
		assert.equal(env.PI_CODING_AGENT_DIR, "/isolated/pi");
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "run-1");
		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "parent-1");
		for (const denied of ["NODE_OPTIONS", "NODE_PATH", "OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "MCP_SERVERS", "PI_EXTENSIONS", "UNKNOWN_AMBIENT"]) {
			assert.equal(env[denied], undefined, `${denied} must not reach the child`);
		}
	});

	it("accepts only explicitly overlaid non-secret faux provider fields", () => {
		const env = buildChildEnvironment({
			profile: "minimal",
			base: { PATH: "/bin", PI_FAUX_PROVIDER_URL: "http://ambient/faux", PI_FAUX_PROVIDER_TOKEN: "ambient-secret" },
			overlay: { PI_FAUX_PROVIDER_URL: "http://127.0.0.1/faux", PI_FAUX_PROVIDER_MODEL: "faux-model", PI_FAUX_PROVIDER_TOKEN: "overlay-secret" },
			parentSessionId: "parent-faux",
			allowModelNetwork: false,
		});
		assert.equal(env.PI_FAUX_PROVIDER_URL, "http://127.0.0.1/faux");
		assert.equal(env.PI_FAUX_PROVIDER_MODEL, "faux-model");
		assert.equal(env.PI_FAUX_PROVIDER_TOKEN, undefined);
	});

	it("treats undefined overlay values as deletion without ambient fallback", () => {
		const env = buildChildEnvironment({
			profile: "minimal",
			base: { PATH: "/bin", HOME: "/ambient-home", PI_CODING_AGENT_DIR: "/ambient-pi" },
			overlay: { HOME: undefined, PI_CODING_AGENT_DIR: undefined },
			parentSessionId: "parent-delete",
			allowModelNetwork: false,
		});
		assert.equal(env.HOME, undefined);
		assert.equal(env.PI_CODING_AGENT_DIR, undefined);
	});

	it("preserves provider credentials and normal runtime capability for interactive children", () => {
		const env = buildChildEnvironment({
			profile: "interactive",
			base: ambient,
			overlay: { OPENAI_API_KEY: "launch-provider-key", PI_SUBAGENT_CHILD: "1" },
			parentSessionId: "parent-interactive",
			allowModelNetwork: true,
		});
		assert.equal(env.OPENAI_API_KEY, "launch-provider-key");
		assert.equal(env.GITHUB_TOKEN, ambient.GITHUB_TOKEN);
		assert.equal(env.NODE_OPTIONS, ambient.NODE_OPTIONS);
		assert.equal(env.MCP_SERVERS, ambient.MCP_SERVERS);
		assert.equal(env.PI_EXTENSIONS, ambient.PI_EXTENSIONS);
		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "parent-interactive");
	});

	it("rejects unsupported profile and network combinations", () => {
		assert.throws(() => buildChildEnvironment({ profile: "minimal", base: {}, overlay: {}, parentSessionId: "parent", allowModelNetwork: true }), /minimal.*model network/i);
		assert.throws(() => buildChildEnvironment({ profile: "interactive", base: {}, overlay: {}, parentSessionId: "parent", allowModelNetwork: false }), /interactive.*model network/i);
	});

	it("does not let minimal overlays reintroduce secret-shaped or pseudo-protocol variables", () => {
		const env = buildChildEnvironment({
			profile: "minimal",
			base: ambient,
			overlay: {
				SERVICE_API_KEY: "secret",
				SESSION_TOKEN: "secret",
				APP_SECRET: "secret",
				AWS_REGION: "secret",
				DATABASE_URL: "secret",
				PI_SUBAGENT_API_KEY: "secret",
				PI_INTERCOM_SECRET: "secret",
				PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: "required-protocol-capability",
			},
			parentSessionId: "parent-minimal",
			allowModelNetwork: false,
		});
		for (const denied of ["SERVICE_API_KEY", "SESSION_TOKEN", "APP_SECRET", "AWS_REGION", "DATABASE_URL", "PI_SUBAGENT_API_KEY", "PI_INTERCOM_SECRET"]) {
			assert.equal(env[denied], undefined);
		}
		assert.equal(env.PI_SUBAGENT_PARENT_CAPABILITY_TOKEN, "required-protocol-capability");
	});

	it("exposes a default-interactive environmentProfile seam at foreground and background launches", () => {
		const options = fs.readFileSync(path.join(projectRoot, "src/shared/types/execution-options.ts"), "utf-8");
		assert.match(options, /environmentProfile\?: ChildEnvironmentProfile/);
		const foreground = fs.readFileSync(path.join(projectRoot, "src/runs/foreground/execution.ts"), "utf-8");
		assert.match(foreground, /environmentProfile\s*=\s*options\.environmentProfile\s*\?\?\s*"interactive"/);
		const background = fs.readFileSync(path.join(projectRoot, "src/runs/background/subagent-runner.ts"), "utf-8");
		assert.match(background, /profile\s*=\s*environmentProfile\s*\?\?\s*"interactive"/);
	});

	it("uses explicit interactive profiles at the default foreground and background spawn paths", () => {
		for (const relative of ["src/runs/foreground/execution.ts", "src/runs/background/subagent-runner.ts"]) {
			const source = fs.readFileSync(path.join(projectRoot, relative), "utf-8");
			assert.match(source, /\?\?\s*"interactive"/, `${relative} must default to interactive capability`);
			assert.match(source, /allowModelNetwork:\s*\w+\s*===\s*"interactive"/, `${relative} must derive network capability monotonically from profile`);
		}
	});

	it("is the sole builder used by both spawn paths without process.env spreading", () => {
		for (const relative of ["src/runs/foreground/execution.ts", "src/runs/background/subagent-runner.ts"]) {
			const source = fs.readFileSync(path.join(projectRoot, relative), "utf-8");
			assert.match(source, /buildChildEnvironment\s*\(/, `${relative} must use the shared builder`);
			assert.doesNotMatch(source, /\.\.\.process\.env/, `${relative} must not spread process.env`);
		}
	});
});
