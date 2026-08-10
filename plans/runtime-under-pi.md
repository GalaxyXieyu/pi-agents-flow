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
| Reads | Resolve each runtime leaf independently; an empty/new partial tree never hides a non-empty legacy leaf |
| Existing preferred + legacy trees | Copy missing entries into `.pi/agents-flow`; never overwrite conflicts and preserve legacy while conflicts remain |
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

Automatic migration is the default path:

1. On extension load and write paths, `ensureProjectRuntimeRoot(cwd)` calls `migrateLegacyProjectRuntime(cwd)`.
2. If `.pi-agents-flow` exists and `.pi/agents-flow` does not → rename (or copy+remove) legacy → preferred.
3. If preferred already exists → merge only missing entries. Existing preferred files win; conflicts are reported and the legacy tree remains intact for manual resolution.
4. If a copy/merge fails, entries created by that attempt are rolled back so a partial preferred tree cannot hide complete legacy data.
5. Persisted text paths are rewritten to `.pi/agents-flow`; immutable content-addressed result objects are remapped in memory when hydrated so their hashes remain valid.
6. Path preflight does **not** create empty runtime dirs; only real writers mkdir leaves.

Manual fallback if you want to move data yourself:

```bash
mkdir -p .pi
mv .pi-agents-flow .pi/agents-flow
```

## Why not dump files directly in `.pi/`?

`.pi/` already holds Pi project settings, goals, agents, etc. A dedicated `agents-flow/` leaf keeps plugin runtime separate from Pi core config while still living under the single project `.pi` umbrella the user asked for.

