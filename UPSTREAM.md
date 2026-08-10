# Upstream and Attribution

Pi Agents Flow is a learning fork and substantial extension of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents), originally authored by Nico Bailon. The upstream MIT copyright and permission notice remain unchanged in `LICENSE`.

The fork was introduced into `GalaxyXieyu/pi` at commit `8f86e29e3b76ccf58715ba4f6508ffacc4c20b7b` and retains upstream changelog history. Fork-owned work includes supervisor-managed Dynamic Workflow, Deep Research and Coding presets, WorkflowDataContract, durable recovery and artifacts, quality gates, Agent visibility/invocation policy, proactive discovery, Activity Board/Dock integration, and release hardening.

When syncing upstream, compare public delegation and preflight contracts first. Do not overwrite `src/workflows/`, persisted `.pi/agents-flow` formats (legacy `.pi-agents-flow` may still be readable), or fork-specific Agent policy without an explicit migration and regression tests.
