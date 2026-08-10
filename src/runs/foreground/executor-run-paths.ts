/**
 * Run-path facade for the subagent executor.
 */
export { runAsyncPath } from "./executor-path-async.ts";
export { runChainPath } from "./executor-path-chain.ts";
export {
	buildParallelModeError,
	createParallelWorktreeSetup,
	buildParallelWorktreeTaskCwdError,
	resolveSingleRunOutputBaseDir,
	buildChainWorktreeTaskCwdError,
	resolveParallelTaskCwd,
	finalizeParallelWorktreeHandoff,
	findDuplicateParallelOutputPath,
	runForegroundParallelTasks,
	runParallelPath,
} from "./executor-path-parallel.ts";
export { runSinglePath } from "./executor-path-single.ts";
export {
	inferExecutionMode,
	duplicateSubagentCallResult,
	omitExecutionModeActionAlias,
} from "./executor-path-misc.ts";
