interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

interface ParentSessionIdentityManager {
	getSessionId(): string | null | undefined;
}

export class ParentSessionIdentityError extends Error {
	readonly code = "PARENT_SESSION_IDENTITY_REQUIRED";

	constructor() {
		super("Parent session identity is unavailable; child launch is blocked.");
		this.name = "ParentSessionIdentityError";
	}
}

export function assertRequiredParentSessionId(sessionId: string | null | undefined): string {
	const resolved = sessionId?.trim();
	if (!resolved) throw new ParentSessionIdentityError();
	return resolved;
}

export function resolveRequiredParentSessionId(sessionManager: ParentSessionIdentityManager): string {
	return assertRequiredParentSessionId(sessionManager.getSessionId());
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}
