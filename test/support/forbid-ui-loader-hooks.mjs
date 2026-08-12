/**
 * Forbid-UI loader hook module (registered by forbid-ui-loader.mjs).
 *
 * Interpretation B (approved scope exception): blocks pi-tui / src/tui only when
 * the resolving parent is the pi-agents-flow extension's OWN source graph
 * (`src/**`). It absolutely blocks `/src/tui/`. The host SDK
 * (`@earendil-works/pi-coding-agent` in node_modules) legitimately imports pi-tui
 * for its interactive mode; that is a host-side dependency, not the extension's,
 * so those resolves are allowed. This proves the extension headless runtime has
 * zero OWN TUI dependency (D-04), while keeping genuine subagent execution
 * possible (A1d-T3).
 */

const PI_TUI_SPECIFIER = "@earendil-works/pi-tui";
const SRC_TUI_MARKER = "/src/tui/";
const SRC_TUI_FILE = "/src/tui";
const NODE_MODULES_MARKER = "/node_modules/";

function isOwnSource(parent) {
	if (typeof parent !== "string") return false;
	if (parent.includes(NODE_MODULES_MARKER)) return false;
	// Any repo file (src/** or the repo root entry) is extension-own. The entry
	// module and its src imports must not reference pi-tui directly.
	return true;
}

function isForbiddenOwnTuiPath(url) {
	const pathname = typeof url === "string" ? url : "";
	return pathname.includes(SRC_TUI_MARKER) || pathname.endsWith(SRC_TUI_FILE);
}

function forbiddenReason(specifier, parentURL) {
	const isPiTui = specifier === PI_TUI_SPECIFIER || specifier.startsWith(`${PI_TUI_SPECIFIER}/`);
	const parent = typeof parentURL === "string" ? parentURL : "";
	if (isPiTui && isOwnSource(parent)) {
		return `extension-own pi-tui specifier '${specifier}' (parent ${parent}) is forbidden by the forbid-ui-loader.`;
	}
	// Absolute block on the extension's own TUI source directory, regardless of
	// parent (covers repo entry and src/**).
	if (isForbiddenOwnTuiPath(parent) && parent.includes("/pi-agents-flow/")) {
		return `resolution under src/tui (parent ${parent}) is forbidden by the forbid-ui-loader.`;
	}
	return undefined;
}

export async function resolve(specifier, context, nextResolve) {
	const direct = forbiddenReason(specifier, context?.parentURL);
	if (direct) {
		const error = new Error(direct);
		error.code = "ERR_FORBIDDEN_UI_MODULE";
		throw error;
	}
	const resolved = await nextResolve(specifier, context);
	const after = forbiddenReason(resolved?.url, context?.parentURL);
	if (after) {
		const error = new Error(after);
		error.code = "ERR_FORBIDDEN_UI_MODULE";
		throw error;
	}
	return resolved;
}
