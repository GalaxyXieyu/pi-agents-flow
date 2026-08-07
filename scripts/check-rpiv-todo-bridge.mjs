import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const packageRoot = process.env.PI_RPIV_TODO_DIR
	?? path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo");
const packagePath = path.join(packageRoot, "package.json");
const indexPath = path.join(packageRoot, "index.ts");
const replayPath = path.join(packageRoot, "state", "replay.ts");

const failures = [];
let version = "unknown";
try {
	const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
	version = typeof manifest.version === "string" ? manifest.version : version;
} catch (error) {
	failures.push(`cannot read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
}

const checks = [
	[indexPath, "pi-agents-flow:workflow-todo-apply:v0", "workflow apply event"],
	[indexPath, "pi.events.on(WORKFLOW_TODO_APPLY_EVENT", "workflow event listener"],
	[indexPath, "applyTaskMutation(state, operation.action, operation)", "rpiv-todo state mutation"],
	[replayPath, "pi-agents-flow-workflow-todo-snapshot", "workflow snapshot replay"],
];

for (const [filePath, marker, label] of checks) {
	try {
		if (!fs.readFileSync(filePath, "utf8").includes(marker)) failures.push(`${label} is missing from ${filePath}`);
	} catch (error) {
		failures.push(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failures.length > 0) {
	console.error(`rpiv-todo workflow bridge is unavailable (installed version: ${version}).`);
	for (const failure of failures) console.error(`- ${failure}`);
	console.error("Automatic workflow Todo projection will fall back to explicit todo operations until the rpiv-todo bridge is restored.");
	process.exitCode = 1;
} else {
	console.log(`rpiv-todo workflow bridge is ready (version ${version}).`);
}
