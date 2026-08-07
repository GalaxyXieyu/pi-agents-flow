# Security Policy

## Supported versions

Only the latest `0.1.x-alpha` release is supported during Alpha. Security fixes may include breaking configuration or persisted-data changes until the affected subsystem is declared stable in `SUPPORT.md`.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub Security Advisories for `GalaxyXieyu/pi`, or contact the repository owner privately through the contact method on the GitHub profile. Include the affected version, reproduction steps, impact, and any suggested mitigation.

Expect an acknowledgement within 7 days. A fix timeline depends on severity and reproducibility. Public disclosure should wait until a patched Alpha is available.

## Sensitive data

Delegated prompts, model output, transcripts, file paths, and workflow artifacts may be written below `.pi-agents-flow/`, the Pi session directory, or the operating-system temp directory. Treat these as potentially sensitive. Do not commit them, attach them to public issues, or share them without review.

Tool allowlists, capability ceilings, and invocation policy reduce accidental authority; they are not an operating-system sandbox. Run untrusted Agents in an isolated user account, container, or disposable worktree.
