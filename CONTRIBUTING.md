# Contributing

Pi Agents Flow is currently developed inside `GalaxyXieyu/pi`. Open an issue before a broad architectural change. Keep changes scoped, preserve upstream attribution, and do not commit generated `.pi-agents-flow/` runtime data.

## Setup

From `learning/pi-harness/extensions/pi-agents-flow`:

```bash
npm ci --ignore-scripts
npm run test:unit
npm run test:integration
npm run test:e2e
npm run smoke:pack
```

Use Node 22.19 or newer. Tests must not require paid provider calls or credentials. New runtime dependencies must use exact versions and be reviewed with the lockfile.

## Pull requests

Describe the user-visible behavior, compatibility impact, tests run, and residual risk. Add focused regression coverage for bug fixes. Changes to Dynamic Workflow, Deep Research, Coding Workflow, or Watchdog must retain their experimental label unless the support policy is deliberately revised.

Follow the root repository's `CONTRIBUTING.md` and `AGENTS.md` for commit, changelog, and review requirements.
