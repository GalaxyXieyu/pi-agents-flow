# Optimization Round Summary

Branch: `refactor/runtime-stabilization`  
Date: 2026-08-10

## Objective

Per `optimization-report.md`: P0 runtime-semantics closeout → P1 benchmark/observability → P2 first safe helper extraction from `subagent-executor.ts`. No full-repo rearchitecture.

## Completed

### P0 — runtime semantics audit + lock tests

- Audit written: `plans/p0-runtime-semantics-audit.md`
- Conclusion: failure/repair/evidence semantics already present end-to-end
- Added board regression tests for non-retryable replacement guidance and retryable `run_ready nodeId=...` guidance
- Residual (non-blocking): Fleet deep inspector still shows raw child errors, not workflow failureClass; Activity Board is the workflow recovery surface

### P1 — benchmarks + advisory gate

- `scripts/benchmark-timings.ts` now emits comparable JSON for:
  - `discovery`
  - `context-pack`
  - `scheduler-queue`
- npm scripts:
  - `benchmark:timings`
  - `benchmark:regression`
- Fixed import side effect: `workflow-benchmark.ts` CLI guarded with `import.meta.main`
- Advisory CI: `.github/workflows/benchmark-regression.yml` (warnings only; never blocks without `--fail`)
- Seed baseline: `ci/baseline-timings.json`
- Notes: `plans/p1-benchmark-observability.md`

### P2 — first helper extraction

- New module: `src/runs/foreground/executor-helpers.ts`
- Extracted pure helpers (cwd resolve, resume error classification, duplicates, pathWithin, mode label, agent-name collection, chain first-agent/task, async event goal)
- Behavior tests: `test/unit/executor-helpers.test.ts` (7/7)
- `subagent-executor.ts`: 4644 → ~4567 lines (first slice only)
- Public API / runtime protocol unchanged; imports remain internal

### Earlier on this branch

- peerDependencies relaxed to `>=0.81.0` (pi 0.84 compatible declaration)
- Main already includes refactor/optimization commits (default tools, structured-output harden, timing probe files)

## Not in this round

- Full P2 splits of `agents.ts`, `controller.ts`, `types.ts`
- Provider streaming compaction threshold product work
- Architecture doc rewrite beyond the audit/summary notes
- Full-suite `npm run test:unit` (suite previously hung at large scale); targeted suites used instead
- Push / merge to remote `main` (awaiting user)

## Residual risks

1. Full unit suite may still hang on some files; re-run with concurrency/timeouts before merge.
2. `ci/baseline-timings.json` is machine-local; CI advisory comparisons will be noisy until re-seeded on CI hardware.
3. Helper extraction is intentionally partial; more pure slices remain in `subagent-executor.ts`.
4. Optional peerDeps now allow pi ≥0.84; runtime still needs a restart + smoke against real pi 0.84.1.

## Merge readiness

Ready for user review / PR on `refactor/runtime-stabilization` after:

```bash
npm run benchmark:timings -- --json /tmp/timings.json --human
node --experimental-strip-types --test \
  test/unit/executor-helpers.test.ts \
  test/unit/activity-board.test.ts \
  test/unit/workflow-guidance.test.ts \
  test/unit/workflow-quality.test.ts \
  test/unit/async-resume.test.ts \
  test/unit/nested-control.test.ts
```

Do not merge/push unless requested.
