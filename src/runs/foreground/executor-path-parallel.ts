/**
 * Parallel run-path facade.
 */
export type { ForegroundParallelRunInput } from "./executor-path-parallel-types.ts";
export {
	buildParallelModeError,
	createParallelWorktreeSetup,
	buildParallelWorktreeTaskCwdError,
	resolveSingleRunOutputBaseDir,
	buildChainWorktreeTaskCwdError,
	resolveParallelTaskCwd,
	finalizeParallelWorktreeHandoff,
	findDuplicateParallelOutputPath,
} from "./executor-path-parallel-helpers.ts";
export {
	runForegroundParallelTasks,
	runParallelPath,
} from "./executor-path-parallel-run.ts";
