# P0 Runtime Semantics Audit

Date: 2026-08-10  
Branch: `refactor/runtime-stabilization`  
Baseline report: `optimization-report.md` §P0

## Checklist

| P0 item | Status | Evidence |
| --- | --- | --- |
| Failure class / retryability / suggested action projected beyond Controller text | **Done** | `src/activity/projection.ts` projects `failureClass` / `retryable` / `suggestedAction` onto `AgentExecutionActivity`; `src/tui/activity-board.ts` `recoveryDetailLines()` renders Next step / Why in Plan Details; Agent Activity detail lines also include Failure/Action when height allows |
| Machine-readable repair decision from evaluate/quality | **Done** | `src/workflows/guidance.ts` `WorkflowRepairGuidance.recommendedAction`; `src/workflows/controller.ts` returns `repairGuidance` on evaluate/status/quality paths; `src/workflows/quality.ts` surfaces `recommendedAction` |
| Evidence mode + quality enforcement user-visible policy | **Done** | Defaults `auto` + `advisory` in `src/workflows/policy.ts`; strict web/local/mixed in `src/workflows/quality.ts`; README §workflow quality documents modes and JSON example; tool prompt documents policy in `src/workflows/tool.ts` |
| Strict web/local/mixed fixtures | **Done** | `test/unit/workflow-quality.test.ts` covers strict web/local/mixed release blocking |

## Residual notes (not P0 blockers)

1. **Fleet deep inspector** (`src/tui/fleet.ts` detail panes) still shows raw `Error:` text for child runs and does not re-render workflow `failureClass` / `suggestedAction`. Activity Board is the workflow-facing surface and already carries recovery guidance; Fleet remains a child-run transcript inspector. No code change required for P0 acceptance.
2. **Agent Activity height truncation** can hide Failure/Action lines in a 40-row board. Plan Details always shows Next step / Why first, so operators still get an actionable path without scrolling. Locked by new board tests.

## Tests run

```text
node --experimental-strip-types --test \
  test/unit/activity-board.test.ts \
  test/unit/workflow-guidance.test.ts \
  test/unit/workflow-quality.test.ts \
  test/unit/model-fallback.test.ts
# pass: activity-board 18/18; guidance/quality/model-fallback green in prior combined run
```

## Gap patch applied this round

- Added regression tests in `test/unit/activity-board.test.ts`:
  - non-retryable `provider_quota_exhausted` → replacement Next step + Why
  - retryable transport failure → exact `run_ready nodeId=...` guidance
  - projection retains `failureClass` / `retryable` / `suggestedAction`

## Verdict

P0 runtime semantics are closed for this optimization round. Proceed to P1 (benchmark JSON + advisory CI gate), then P2 helper extraction.
