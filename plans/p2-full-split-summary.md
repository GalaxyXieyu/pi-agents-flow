# P2 Full Split Summary

Branch: `refactor/runtime-stabilization`  
Goal structure: `optimization-report.md` §P2

## Target structure (from optimization-report)

| File | Target split | Status |
| --- | --- | --- |
| `subagent-executor.ts` | pure helpers + recovery/validation slices | **Done (multi-module)** |
| `agents.ts` | discovery vs override/config | **Done (facade)** |
| `controller.ts` | pure helpers vs factory | **Deferred** (see residual) |
| `shared/types.ts` | domain modules + re-export facade | **Done** |

## Resulting layout

### `src/shared/types/` (facade: `src/shared/types.ts`)

- `basic.ts`, `progress.ts`, `results.ts`, `artifacts.ts`
- `async-execution.ts`, `display.ts`, `error-handling.ts`
- `execution-options.ts`, `constants.ts`, `recursion-depth.ts`, `utility-functions.ts`

Public import path remains `../shared/types.ts` (export * facade).

### `src/agents/` (facade: `agents.ts`)

- `agents-config.ts` — types, settings, overrides, package path helpers, loaders
- `agent-discovery.ts` — `discoverAgents` / `discoverAgentsAll` / `EXTRA_AGENT_DIRS_ENV`
- `agents.ts` — re-exports identity + config + discovery

### `src/runs/foreground/`

- `executor-helpers.ts` — pure string/path/mode helpers
- `executor-validation.ts` — launch validation / param normalization / fork preflight
- `subagent-executor.ts` — control plane + run paths + `createSubagentExecutor` (~4059 lines, down from 4644)

### `src/workflows/controller.ts`

Left as a single file (1213 lines). Extracting helpers pulled heavy import graphs and made the already-long controller suite impractical to green-check in this pass. Next slice should move only pure status/guidance helpers with a lean import set and run the controller suite overnight/with concurrency limits.

## Line counts (approx)

| Path | Lines |
| --- | ---: |
| `subagent-executor.ts` | 4059 |
| `executor-validation.ts` | 563 |
| `executor-helpers.ts` | 112 |
| `agents.ts` (facade) | 6 |
| `agents-config.ts` | 1698 |
| `agent-discovery.ts` | 214 |
| `shared/types.ts` (facade) | 17 |
| `controller.ts` | 1213 |

## Tests run (all pass)

```text
node --experimental-strip-types --test \
  test/unit/executor-helpers.test.ts \
  test/unit/async-resume.test.ts \
  test/unit/nested-control.test.ts \
  test/unit/preflight.test.ts \
  test/unit/pi-args.test.ts \
  test/unit/workflow-skills-agents.test.ts \
  test/unit/agent-overrides.test.ts \
  test/unit/activity-board.test.ts
# 160 pass / 0 fail
```

Also fixed `workflow-skills-agents` expectation: runtime default tools now include `web_search` for every child (matches `SUBAGENT_DEFAULT_TOOLS` from earlier optimization commits).

## Residuals

1. `controller.ts` not split yet.
2. `agents-config.ts` still large (types + overrides + package IO); further type-only extract is optional.
3. `subagent-executor.ts` still holds control + run-path orchestration (~4k lines); next cut is `executor-control.ts` / `executor-run-paths.ts` with careful `ExecutorDeps` typing.
4. Full `npm run test:unit` suite not re-run end-to-end (known hang risk on large suites).
