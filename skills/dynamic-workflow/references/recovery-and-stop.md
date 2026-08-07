# Recovery And Stop

- Workflow state is stored under `.pi-agents-flow/workflows/<run-id>/`.
- `events.jsonl` is the recovery source; `manifest.json` is an atomic projection.
- Session custom entries bind run id, revision, session id, cwd, and Git branch.
- On reload, continue only when all binding fields match. A mismatch is a hard stop requiring an explicit new run or user decision.
- `pause` stops new scheduling. It does not discard completed results.
- `stop` terminates the workflow state and preserves attempts, artifacts, and delivery files.
- `cancel_node` stops only the named running or waiting node. Siblings and the workflow stay active; a later `run_ready` creates a new immutable attempt when retry is appropriate.
- On startup, reload, or resume, recover waiting attempts first, then actively schedule any ready nodes in an active workflow.
- Never delete old attempts when retrying. A retry creates a new attempt number.
- User steering becomes a new plan or decision event; invalidate only nodes whose assumptions changed.
