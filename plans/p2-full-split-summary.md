# P2 Full Split Summary

Branch: `refactor/runtime-stabilization`  
Goal structure: `optimization-report.md` §P2

## Target structure (from optimization-report)

| File | Target split | Status |
| --- | --- | --- |
| `subagent-executor.ts` | pure helpers + validation + control + run-paths | **Done** |
| `agents.ts` | types / config+overrides / discovery | **Done** |
| `controller.ts` | pure helpers vs factory | **Done** |
| `shared/types.ts` | domain modules + re-export facade | **Done** |

## Resulting layout

### `src/shared/types/` (facade: `src/shared/types.ts`)
- domain modules under `types/*` with stable re-export facade

### `src/agents/` (facade: `agents.ts`)
- `agent-types.ts` — types + pure name/policy helpers
- `agents-config.ts` — settings, overrides, package paths, loaders
- `agent-discovery.ts` — `discoverAgents` / `discoverAgentsAll`
- `agents.ts` — facade re-exports

### `src/workflows/`
- `controller-helpers.ts` — public controller types + pure helpers
- `controller.ts` — `createWorkflowController` factory + re-exports

### `src/runs/foreground/`
- `executor-helpers.ts` — pure string/path/mode helpers
- `executor-types.ts` — `SubagentParamsLike` / `ExecutorDeps` / `ExecutionContextData`
- `executor-validation.ts` — launch validation / param normalization
- `executor-control.ts` — resume/interrupt/nested/control memory
- `executor-run-paths.ts` — async/chain/parallel/single run paths
- `subagent-executor.ts` — wiring + `createSubagentExecutor` (~1150 lines)

## Line counts (approx)

| Path | Lines |
| --- | ---: |
| `subagent-executor.ts` | 1149 |
| `executor-control.ts` | 1486 |
| `executor-run-paths.ts` | 1786 |
| `executor-validation.ts` | 564 |
| `executor-types.ts` | 312 |
| `executor-helpers.ts` | 112 |
| `controller.ts` | 1038 |
| `controller-helpers.ts` | 239 |
| `agents.ts` (facade) | 7 |
| `agents-config.ts` | 1381 |
| `agent-discovery.ts` | 216 |
| `agent-types.ts` | 352 |
| `shared/types.ts` (facade) | 17 |

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

node --experimental-strip-types --test --test-name-pattern=\'rejects an impossible|resolves and persists workflow language|persists the configured node-attempt\' \
  test/unit/workflow-controller.test.ts
# 3 pass / 0 fail
```

## Residuals

1. Full `workflow-controller.test.ts` suite is large/slow; only smoke subset re-run after controller split.
2. Full `npm run test:unit` not re-run end-to-end (known hang risk).
3. `agents-config.ts` and `executor-run-paths.ts` remain large but now have clear boundaries for further cuts.
