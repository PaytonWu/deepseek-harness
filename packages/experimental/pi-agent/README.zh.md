---
description: "面向模型的 pi_agent 工具：以独立会话运行可继续的 pi coding-agent 子代理，面向选择或配置外部 pi 运行时委托任务的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pi-agent

[English](README.md) | 中文

## 概述

`pi_agent` 把一个委托的编码任务作为 pi coding-agent 子进程运行：它拥有独立的 RPC 会话、模型、工具与凭据。一个 child 接受一条自包含任务，在工具调用之间持续运行，可接收后续消息、可被中断，并能在 Host 重启后从其 pi 会话文件恢复。pi 拥有对话内容；本包拥有 child 身份、进程生命周期，以及 Harness home 之下的持久指针注册表。

仅在任务因明确要求而属于 pi 时使用——例如操作者明确点名要 pi。这些 child 不是 dsh subagent；普通委托请使用 dsh subagent。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 或 Desktop 的插件页启用 **PI agent**，或在任意 Host 组合中挂载 `@deepseek-ai/dsh-pi-agent`。插件要求 Host 进程环境能解析到 `pi`；缺失时所有操作都会带安装指引响亮失败，不存在回退。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `pi` | 每个 child 启动的可执行文件，从 PATH 解析 |
| `args` | `[]` | 插在 pi 自身模式参数之前的额外参数 |
| `tools` | — | 转发给 `--tools` 的 pi 工具选择；省略时保持 pi 默认工具集 |
| `provider` | — | 转发给 `--provider` 的 provider 名；省略时保持 pi 配置 |
| `model` | — | 转发给 `--model` 的模型 id；省略时保持 pi 配置 |
| `env` | `{}` | 叠加在子进程环境之上的环境变量映射 |
| `maxChildren` | `4` | 同时存活的 pi child 数量上限 |

pi 自身的模型、凭据与设置保持权威；覆盖字段只转发 CLI 参数。会话文件位于 `$DSH_HOME/pi-agent/sessions/` 之下。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-pi-agent)是每个受支持字段及其 JSDoc 的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件以 pi 的 RPC 模式启动每个 child，把 `--session-dir` 钉在 Harness home 之下，并通过 RPC `get_state` 把具体会话文件读入指针注册表。发送使用 RPC `prompt`（运行流式期间以 `followUp` 排队）；中断使用 `clear_queue` 与 `abort`；完成状态由 `agent_settled` 事件观察。注册表记录可跨重启存活；记录早于 Host 重启的 child 会从其 pi 会话文件冷恢复。Host 退出时插件优雅终止存活的 child；崩溃后只有在校验过命令行之后才终止遗留进程，不确定的情况带警告跳过。不扩展 subagent 缝隙的决策由[决策记录](../../../.agents/notes/implemented/feature/2026-11-11-pi-agent-plugin.zh.md)持有。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Bundle 组合](../pi-agent-bundle/README.zh.md)

[Subagent 子系统](../../../docs/subsystems/subagent.zh.md) — 外部 child 为何留在委托缝隙之外

pi RPC 模式 — 子进程侧的线上契约，随所安装的 pi 包提供文档

<a id="model-experience"></a>
## 数字员工

`/new-employee <名称> --cwd <目录> --description <职责> [--session <文件>]` 创建一个数字员工：一个具名 pi 编码代理，拥有自己的 dsh 会话，位于 **我的数字员工** Workspace 分组。该会话中的消息直通员工的 pi 子代理 —— `pi-employee` LLM adapter 路由把 pi 变成会话的“模型”，历史、搜索与中断全部复用普通会话生命周期。职责描述在全新 pi 会话中作为第一条指令注入；导入的 `--session` 文件则让员工续用既有 pi 记忆。员工记录持久化于 `$DSH_HOME/pi-agent/employees.json`。

侧边栏创建表单弹窗延后：它需要 `ui-workspace` 新增分组头 slot（产品 UI 变更，需设计评审）。

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

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **pi 必须在 PATH 上** — 插件既不下载也不捆绑 pi 运行时；没有 pi 的 Host 按设计响亮失败。
- **child 位于 subagent 树之外** — `list_agents`、树内消息与缝隙守卫看不到 pi child；容量仅由 `maxChildren` 约束。
- **答案是轮询而非推送** — `start` 与 `send` 在运行结束前返回；模型必须轮询 `status`，已完成的答案只有在轮询观察到后才被记录。
- **RPC 协议随 pi 版本演进** — 插件面向随所装 pi 提供文档的 RPC 子集；协议漂移在流量畸形时响亮失败。

### 开发备注
<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
