# P1 Benchmark & Observability

Branch: `refactor/runtime-stabilization`

## Delivered

### Comparable timing JSON

`npm run benchmark:timings` (`scripts/benchmark-timings.ts`) now:

- measures **discovery**, **context-pack**, and **scheduler-queue**
- writes comparable JSON via `--json <path>`
- prints a human summary via `--human` (default when not only machine output)
- uses a synthetic workflow run when no real workflow directory is provided
- remains defensive: probe failures become `null` timings instead of hard crashes

Example:

```bash
npm run benchmark:timings -- --json ci/latest-timings.json --human
```

### Workflow search benchmark (existing)

`npm run benchmark:workflow` still summarizes deep-research quality fixtures and can write a JSON baseline with `--json`.

CLI side effect fixed: importing `workflow-benchmark.ts` no longer executes the search-benchmark CLI (`import.meta.main` guard).

### Advisory regression gate

`npm run benchmark:regression` wraps `scripts/check-benchmark-regression.mjs`:

- compares numeric fields between baseline and current JSON
- default threshold 50% in CI workflow, 20% in script CLI default
- **advisory by default** (exit 0 + stderr warnings)
- optional `--fail` for hard enforcement later

### CI

`.github/workflows/benchmark-regression.yml`:

- runs on PR/push to main
- captures current timings
- compares against `ci/baseline-timings.json` when present
- never fails the job for missing baseline or advisory regressions
- uploads artifacts

Seed baseline committed at `ci/baseline-timings.json` from a local machine run so the gate has something to compare against immediately.

## Acceptance

| Requirement | Status |
| --- | --- |
| JSON baseline with discovery / context-pack / scheduler fields | Yes |
| Locally reproducible | Yes (`npm run benchmark:timings`) |
| Advisory CI / docs, no hard block without baseline | Yes |
