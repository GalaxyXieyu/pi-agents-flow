# Runtime data under project `.pi`

## Decision

Project-local pi-agents-flow runtime now lives under Pi's project config directory:

```text
<cwd>/.pi/agents-flow/
  workflows/
  compositions/
  artifacts/
  chain-runs/
```

## Compatibility

| Concern | Behavior |
| --- | --- |
| New writes | Always `.pi/agents-flow/...` |
| Reads | Prefer `.pi/agents-flow` when present; otherwise a non-empty legacy `.pi-agents-flow` |
| Compositions list/load | Union preferred + legacy trees |
| Gitignore | Ignores both `.pi/agents-flow/` and `.pi-agents-flow/` |
| Watchdog noise | Ignores both runtime trees |

## Code

- `src/shared/project-runtime.ts` — root resolution helpers
- `src/shared/artifacts.ts` — project artifact/chain-run dirs
- `src/workflows/controller.ts` — workflow store root
- `src/workflows/composition-store.ts` — composition files
- `src/watchdog/change-signature.ts` — ignore prefixes

## Migration for existing projects

No automatic file move (keeps user data safe). Options:

1. Leave legacy in place — reads still work until the new tree exists.
2. Manually move: `mv .pi-agents-flow .pi/agents-flow` (create `.pi` first if needed).
3. After the first new write creates `.pi/agents-flow`, that tree wins for reads.

## Why not dump files directly in `.pi/`?

`.pi/` already holds Pi project settings, goals, agents, etc. A dedicated `agents-flow/` leaf keeps plugin runtime separate from Pi core config while still living under the single project `.pi` umbrella the user asked for.

## Automatic migration

On write paths and extension load, `ensureProjectRuntimeRoot(cwd)` calls
`migrateLegacyProjectRuntime(cwd)`:

1. If `.pi-agents-flow` exists and `.pi/agents-flow` does not → rename (or copy+remove) legacy → preferred.
2. If preferred already exists → leave both alone (no clobber).
3. Path preflight does **not** create empty runtime dirs; only real writers mkdir leaves.

