/**
 * Repo-local faux provider child for headless subagent execute tests.
 *
 * This script stands in for the pi-coding-agent child process. It never accesses
 * the network and never loads any TUI. It verifies the minimal child environment
 * policy and emits a provider-style JSONL `message_end` result (the format the
 * subagent executor parses), then exits.
 *
 * Minimal-env assertions (from buildChildEnvironment profile="minimal"):
 *   - `PI_SUBAGENT_PARENT_SESSION` must be present and non-empty (explicit parent
 *     identity).
 *   - Ambient secrets/credentials must be absent (OPENAI_API_KEY, GITHUB_TOKEN,
 *     AWS_SECRET_ACCESS_KEY, DATABASE_URL, etc.).
 *   - Ambient MCP / extension capability config must be absent (MCP_SERVERS,
 *     PI_EXTENSIONS). Protocol-required child keys such as MCP_DIRECT_TOOLS and
 *     the runtime-acknowledged-extensions path are child-owned and may be
 *     present; they do not leak ambient host capability.
 */

const parentIdentity = process.env.PI_SUBAGENT_PARENT_SESSION;
const leaks = [];
for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "MCP_SERVERS", "PI_EXTENSIONS"]) {
	if (process.env[key]) leaks.push(key);
}
const fakeSecret = process.env.PI_FAUX_PROVIDER_FAKE_SECRET;
if (fakeSecret) leaks.push("PI_FAUX_PROVIDER_FAKE_SECRET");

if (!parentIdentity) {
	process.stderr.write("FAUX_PROVIDER_MISSING_IDENTITY\n");
	process.exit(2);
}
if (leaks.length > 0) {
	process.stderr.write(`FAUX_PROVIDER_ENV_LEAK ${leaks.join(",")}\n`);
	process.exit(3);
}

const payload = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{
			type: "text",
			text: `headless-subagent-executed parent=${parentIdentity} pid=${process.pid}`,
		}],
		model: "faux/test-model",
		stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	},
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(0);
