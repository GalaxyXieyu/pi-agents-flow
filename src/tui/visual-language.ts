import type { Theme } from "@earendil-works/pi-coding-agent";

export type VisualState =
	| "running"
	| "queued"
	| "pending"
	| "ready"
	| "waiting"
	| "complete"
	| "completed"
	| "accepted"
	| "superseded"
	| "paused"
	| "stopped"
	| "detached"
	| "failed"
	| "rejected"
	| "cancelled"
	| string;

const ASCII_SPINNER = ["-", "\\", "|", "/"] as const;
const RUNNING_SPINNER = ["◐", "◓", "◑", "◒"] as const;

function normalizedState(state: VisualState): string {
	return state.toLowerCase();
}

export function selectionMarker(selected: boolean, theme: Theme): string {
	return selected ? theme.fg("accent", ">") : " ";
}

export function statusLabel(state: VisualState): string {
	switch (normalizedState(state)) {
		case "active":
		case "running": return "RUN";
		case "queued": return "QUEUE";
		case "pending": return "PEND";
		case "ready": return "READY";
		case "waiting": return "WAIT";
		case "complete":
		case "completed":
		case "accepted": return "DONE";
		case "paused": return "PAUSE";
		case "stopped": return "STOP";
		case "detached": return "DET";
		case "failed": return "FAIL";
		case "superseded": return "SUPER";
		case "rejected": return "REJ";
		case "cancelled": return "CANC";
		default: return normalizedState(state).slice(0, 6).toUpperCase() || "IDLE";
	}
}

export function statusColor(state: VisualState): "accent" | "muted" | "success" | "warning" | "error" | "dim" {
	switch (normalizedState(state)) {
		case "active":
		case "running": return "accent";
		case "complete":
		case "completed":
		case "accepted": return "success";
		case "paused":
		case "stopped":
		case "waiting": return "warning";
		case "superseded": return "dim";
		case "failed":
		case "rejected":
		case "cancelled": return "error";
		case "queued":
		case "pending":
		case "ready": return "muted";
		default: return "dim";
	}
}

export function statusBadge(state: VisualState, theme: Theme, width = 5, frame?: number): string {
	void width;
	const glyph = (() => {
		switch (normalizedState(state)) {
			case "active":
			case "running":
				// A running node cycles the badge so a row that is quietly calling tools
				// (read/write) reads as alive instead of frozen. No frame => steady ◐, so
				// static callers keep the previous glyph.
				return frame === undefined || !Number.isFinite(frame)
					? "◐"
					: RUNNING_SPINNER[Math.abs(Math.trunc(frame)) % RUNNING_SPINNER.length]!;
			case "complete":
			case "completed":
			case "accepted": return "●";
			case "superseded": return "⊘";
			case "failed":
			case "rejected":
			case "cancelled":
			case "stopped": return "✕";
			default: return "○";
		}
	})();
	return theme.fg(statusColor(state), glyph);
}

export function runningFrame(seed?: number): string {
	if (seed === undefined || !Number.isFinite(seed)) return "-";
	return ASCII_SPINNER[Math.abs(Math.trunc(seed)) % ASCII_SPINNER.length]!;
}

export function noticePrefix(kind: "info" | "success" | "warning" | "error"): string {
	if (kind === "success") return "●";
	if (kind === "error") return "✕";
	return "○";
}
