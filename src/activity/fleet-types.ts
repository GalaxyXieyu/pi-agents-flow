/**
 * FleetItem and FleetSnapshot — UI-neutral DTOs for subagent fleet projection.
 *
 * Moved out of tui/fleet.ts so that activity core can project fleet state
 * without importing TUI.  The TUI Fleet component re-exports these from
 * tui/fleet.ts for backward compatibility.
 */

import type { AsyncRunSummary } from "../runs/background/async-status.ts";
import type {
	ForegroundChildControl,
	ForegroundResumeChild,
	ForegroundResumeRun,
	ForegroundRunControl,
} from "../shared/types/async-execution.ts";

export type FleetItem = (
	| { key: string; kind: "foreground-active"; runId: string; index?: number; agent: string; state: "running"; updatedAt: number; control: ForegroundRunControl; activeChild?: ForegroundChildControl }
	| { key: string; kind: "foreground-recent"; runId: string; index: number; agent: string; state: ForegroundResumeChild["status"]; updatedAt: number; run: ForegroundResumeRun; child: ForegroundResumeChild }
	| { key: string; kind: "async"; runId: string; index?: number; agent: string; state: string; updatedAt: number; run: AsyncRunSummary; step?: AsyncRunSummary["steps"][number] }
) & { description?: string };

export interface FleetSnapshot {
	items: FleetItem[];
	error?: string;
}
