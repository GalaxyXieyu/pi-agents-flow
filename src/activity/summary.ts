import type { ActivityState } from "./types.ts";

export interface ActivitySummaryCounts {
	running: number;
	done: number;
	failed: number;
	waiting: number;
	pending: number;
}

export function summarizeActivityStates(states: ActivityState[]): ActivitySummaryCounts {
	const counts: ActivitySummaryCounts = { running: 0, done: 0, failed: 0, waiting: 0, pending: 0 };
	for (const state of states) {
		switch (state) {
			case "running": counts.running++; break;
			case "completed":
			case "accepted": counts.done++; break;
			case "failed": counts.failed++; break;
			case "waiting":
			case "paused": counts.waiting++; break;
			default: counts.pending++; break;
		}
	}
	return counts;
}

export function activityLeadState(counts: ActivitySummaryCounts): ActivityState {
	if (counts.running > 0) return "running";
	if (counts.failed > 0) return "failed";
	if (counts.waiting > 0) return "waiting";
	if (counts.pending > 0) return "pending";
	return "completed";
}
