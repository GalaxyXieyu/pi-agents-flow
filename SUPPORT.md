# Support Matrix

Pi Agents Flow `0.1.x-alpha` is tested against:

| Component | Supported |
|---|---|
| Pi packages | `@earendil-works/pi-*` `>=0.81.0 <0.82.0` |
| Node.js | `>=22.19.0`; CI covers 22.19 and 24 |
| Operating systems | Linux, macOS, and Windows in CI |
| Package install | npm tarball or checked-out directory through `pi install` |
| Bun | Not supported for the Alpha package test path |

Core foreground/background delegation, Agent discovery, invocation policy, saved chains, Fleet, and Activity surfaces are the primary Alpha scope.

Dynamic Workflow, Deep Research, Coding Workflow, and Watchdog are experimental. Their commands, persisted artifacts, schemas, and UI may change between Alpha releases. WorkflowDataContract and delegation payloads are strict, but Alpha does not promise backward compatibility for previously persisted experimental runs.

Provider authentication, MCP servers, and `rpiv-todo` are external integrations. The workflow remains authoritative when the optional Todo bridge is unavailable. Report reproducible defects in the GitHub issue tracker; use `SECURITY.md` for vulnerabilities.
