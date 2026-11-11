---
description: "The model-facing pi_agent tool: continuable pi coding-agent children in their own sessions, for users and maintainers delegating tasks to an external pi runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-pi-agent

English | [中文](README.zh.md)

## Summary

`pi_agent` runs a delegated coding task as a pi coding-agent child process with its own RPC session, model, tools, and credentials. A child accepts one self-contained task, keeps running between tool calls, receives follow-up messages, can be interrupted, and resumes from its pi session file after a Host restart. pi owns conversation content; this package owns child identity, process lifecycle, and a durable pointer registry under the Harness home.

Use it when a task belongs to pi by explicit request — for example the operator asks for pi specifically. Children are not dsh subagents; use those for ordinary delegation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable **PI agent** in the Web or Desktop Plugins page, or mount `@deepseek-ai/dsh-pi-agent` in any Host composition. The plugin needs `pi` resolvable from the Host process environment; when it is missing, every operation fails with install guidance and no fallback.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `command` | `pi` | Executable started for every child, resolved from PATH |
| `args` | `[]` | Extra arguments inserted before pi's own mode arguments |
| `tools` | — | pi tool selection forwarded to `--tools`; omitted keeps pi's default set |
| `provider` | — | Provider name forwarded to `--provider`; omitted keeps pi's configuration |
| `model` | — | Model id forwarded to `--model`; omitted keeps pi's configuration |
| `env` | `{}` | Environment map layered over the child environment |
| `maxChildren` | `4` | Maximum simultaneously live pi children |

pi's own models, credentials, and settings stay authoritative; the override fields only forward CLI arguments. Session files live under `$DSH_HOME/pi-agent/sessions/`.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-pi-agent) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The plugin starts every child with pi's RPC mode, pins `--session-dir` under the Harness home, and reads the concrete session file from RPC `get_state` into its pointer registry. Sending uses RPC `prompt` (queueing with `followUp` while a run is streaming); interruption uses `clear_queue` and `abort`; completion is observed on the `agent_settled` event. Registry records survive restarts; a child whose record predates a Host restart is cold-resumed from its pi session file. On Host exit the plugin terminates live children gracefully; after a crash it kills a leftover process only after verifying its command line, and skips uncertain cases with a warning. The [decision record](../../../.agents/notes/implemented/feature/2026-11-11-pi-agent-plugin.md) owns the decision not to extend the subagent seam.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Bundle composition](../pi-agent-bundle/README.md)

[Subagent subsystem](../../../docs/subsystems/subagent.md) — why external children stay outside the delegation seam

pi RPC mode — the child-side wire contract, documented with the installed pi package

## Model Experience

### Request context and condition

#### What the model sees

The `pi_agent` tool declaration, its parameter schema (op/task/message/childId/cwd), and the `tool:pi-agent` system-prompt section, whenever the bundle layer is enabled for the running Host.

##### Verbatim system-prompt text

```markdown
Use pi_agent only when the operator explicitly asks for pi. This channel is separate from dsh subagents: pi children do not appear in list_agents and cannot receive subagent messages. start returns a childId immediately; poll status for the answer, send for follow-ups, interrupt to stop a running turn. Children survive Host restarts; an inactive child resumes on send.
```

#### Token effect

Conditional: the tool schema and prompt section are declared only while the plugin is enabled; enabling or disabling changes the request prefix accordingly.

#### KV Cache effect

Replacing: toggling the plugin adds or removes the tool declaration and prompt section, invalidating an existing cached prefix; while enabled, steady-state requests keep a stable repeated prefix.

## Known Limitations and Deferred Work

- **pi must be on PATH** — the plugin neither downloads nor bundles a pi runtime; hosts without pi fail loudly by design.
- **Children are outside the subagent tree** — `list_agents`, tree messaging, and seam guards do not see pi children; capacity is bounded by `maxChildren` alone.
- **Answers are polled, not pushed** — `start` and `send` return before the run finishes; the model must poll `status`, and a settled answer is recorded only after the poll observes it.
- **RPC protocol is versioned with pi** — the plugin targets the pi RPC subset documented with the installed pi; protocol drift fails loudly on malformed traffic.
### Dev Note
<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
