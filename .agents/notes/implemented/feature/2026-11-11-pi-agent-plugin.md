# Agent Note: PI Agent tool plugin

Status: implemented

English | [中文](2026-11-11-pi-agent-plugin.zh.md)

## Problem

dsh delegates tasks to external agents through the subagent seam, and the shipped providers for Claude Code, Codex, and generic ACP are one-shot by design: an external execution accepts one self-contained task and returns the final answer, and the seam rejects follow-ups for external children ([subagent subsystem](../../../../docs/subsystems/subagent.md)). Continuation is scoped to local children because the continuation substrate is the durable dsh Session ([continuable subagent conversations](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md)).

The motivating workflow needs a continuable external coding agent: start a task in a workspace, send follow-up messages, interrupt a running turn, and resume the same conversation after a dsh Host restart. pi (the pi-coding-agent CLI) supports exactly this through its RPC mode: a long-lived child process controlled by JSONL records, with sessions persisted to files it can restore.

Adding external continuation to the seam would create a second continuation substrate next to the dsh Session, and no evidence yet shows that a durable external descriptor plus a provider-cooperative resume protocol generalizes beyond one external agent. The seam records this scope deliberately ("Only local children support later messages and cold resume"), so the gap is real, but the seam is the wrong place to close it today.

## Decision

`packages/experimental/pi-agent/` is an official experimental plugin exposing one model-facing tool, `pi_agent`, and owning every pi child itself. The plugin registers no subagent provider and does not touch the seam; pi children are not visible in `list_agents`, and the tool description states this boundary.

### Tool surface

`pi_agent` has five operations:

- `start`: one self-contained task text and an optional `cwd` (default: the parent's effective directory). Returns a `childId` immediately; the run continues in the background.
- `send`: appends a message to a child. A running child receives it as a follow-up; an inactive child restarts from its pi session file (cold resume).
- `interrupt`: interrupts the child's current turn.
- `status`: reports one child or every child's state and the latest result summary.
- `list`: lists children, including children recorded before a Host restart.

Concurrency is bounded by the `maxChildren` config field, default 4.

### Ownership layers

pi owns conversation content: the message tree, turns, and tool traffic persist in pi session files, and dsh never parses them. The plugin owns a durable pointer registry — one record per child mapping `childId` to the pi session file, run state, and `cwd` — following the repository's plugin-owned durable state pattern. The dsh session log records tool calls, parameters, and final results or status summaries, which satisfies the model-visible-means-logged rule at that minimum.

### Runtime, credentials, and permissions

- The plugin locates `pi` on PATH and fails loudly with install guidance when it is missing; it never downloads or bundles a pi runtime.
- pi's native models and credentials stay authoritative. The plugin offers optional overrides only: forwarding provider and model as CLI arguments and injecting an explicit environment map.
- Reach control is pi's native tool allowlist: a `tools` config field forwards to pi's `--tools` selection (default: pi's own default tool set), so a read-only child is one configuration line. pi raises no per-tool approval records; there is no cross-harness approval channel, and worktree isolation is out of scope. A child runs in the parent's effective directory.

### Storage and lifecycle

The plugin pins `--session-dir` to `$DSH_HOME/pi-agent/sessions/`, so backup, cleanup, and uninstall semantics stay inside the Harness home. On Host exit or plugin unload, the plugin terminates live children gracefully. After a Host crash, the next plugin start examines registry entries marked running, kills a leftover process only after verifying its command line belongs to this plugin's pi child, skips and warns when verification is uncertain, and marks the child inactive; a later `send` cold-resumes it from the pi session file.

### Surfaces

The plugin ships in the Plugins page for web, headless, SDK, and Desktop profiles. Desktop works because Windows GUI launches inherit the registry PATH; a machine without Node and pi fails loudly by design. macOS and Linux inherit the session or login-shell environment as their platform documentation already specifies.


## Risks

- The pi RPC protocol and session restore flags are versioned with the installed pi; protocol drift breaks the plugin. Record the resolved pi version at plugin start and fail loudly on malformed RPC traffic instead of degrading.
- Orphan cleanup kills by pid after command-line verification; pid reuse can defeat the check, so the cleanup stays best-effort and skips uncertain cases.
- pi children are outside the subagent tree and its guards; capacity control is `maxChildren` alone.
- `start` returns before completion; a long task occupies a child slot until it settles or is interrupted.

## Alternatives considered

**Extend the subagent seam for external continuable children.** A contract change through the seam, both SDK projections, snapshots, and docs would make pi a first-class continuable child. It lost because the seam's continuation machinery is built on the dsh Session: an external child needs a durable external descriptor, process ownership across activations, and a resume protocol each external agent would define differently. Shipping that with a single consumer risks an abstraction fitted to pi alone; revisit when a product-level external-continuation capability is wanted, using this plugin's semantics as the reference.

**Mount pi through the generic `subagent-acp` provider.** No new code, but pi implements no ACP mode, so the provider cannot drive it.

**Ship a one-shot provider in the seam, Claude Code style.** The smallest in-seam path, but continuation is the primary requirement, and a one-shot provider does not satisfy it.

**Expose pi through a plain shell command.** No plugin at all: the model calls the shell tool. It loses structured child identity, interruption, status, orphan cleanup, and cold resume, which are the point of the integration.

## Consequences

The shipped implementation satisfies the acceptance criteria of the proposal: stub-protocol unit tests cover all five operations, cold resume, orphan sweeping, graceful teardown, and the fail-loud path (16 tests); a real-pi smoke passes end to end against the installed pi and self-skips without a usable model. Answers are polled rather than pushed: `start` and `send` return before the run finishes, and the model polls `status`. The send-path streaming state closes a response/settle race with a monotonic settle epoch. Reach control shipped as pi's native `--tools` allowlist rather than a permission field, because pi raises no per-tool approval records.
