# Agent Note: PI Agent 工具插件

Status: proposed

[English](2026-11-11-pi-agent-plugin.md) | 中文

## 问题

dsh 通过 subagent 缝隙把任务委托给外部 agent，已发布的 Claude Code、Codex 和通用 ACP provider 都按设计做成 one-shot：外部执行只接受一条自包含任务并返回最终答案，缝隙对外部 child 拒绝后续消息（[subagent 子系统](../../../../docs/subsystems/subagent.zh.md)）。延续能力只覆盖本地 child，因为延续的基底是持久化的 dsh Session（[可继续的 subagent 会话](../../implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)）。

本提案的动机场景需要一个可继续的外部编码 agent：在工作区里启动任务、追加消息、中断正在运行的轮次，并在 dsh Host 重启后恢复同一对话。pi（pi-coding-agent CLI）的 RPC 模式恰好提供这些能力：一个由 JSONL 记录控制的长驻子进程，会话持久化为文件并可恢复。

把外部延续加进缝隙，等于在 dsh Session 旁边引入第二套延续基底；目前没有证据表明“持久外部描述符 + provider 合作的恢复协议”能推广到 pi 之外。缝隙对这一范围有明确记录（“只有本地 child 支持后续消息和冷恢复”），缺口是真实的，但今天不该由缝隙来填补。

## 提案

新增 `packages/experimental/pi-agent/`：一个官方 experimental 插件，面向模型提供唯一工具 `pi_agent`，并自行管理全部 pi child。插件不注册 subagent provider，也不触碰缝隙；pi child 不出现在 `list_agents` 里，工具描述会写明这一边界。

### 工具面

`pi_agent` 有五个操作：

- `start`：一条自包含任务文本和可选 `cwd`（默认为父任务当前生效目录）。立即返回 `childId`，任务在后台继续运行。
- `send`：向 child 追加一条消息。运行中的 child 收到后续消息；闲置的 child 从其 pi 会话文件重启（冷恢复）。
- `interrupt`：中断 child 当前轮次。
- `status`：报告单个 child 或全部 child 的状态与最近一次结果摘要。
- `list`：列出全部 child，包括 Host 重启前记录的 child。

并发数量由配置字段 `maxChildren` 限定，默认 4。

### 所有权分层

pi 拥有对话内容：消息树、轮次和工具流量持久化在 pi 会话文件中，dsh 从不解析它们。插件拥有一个持久指针注册表——每个 child 一条记录，映射 `childId` 到 pi 会话文件、运行状态和 `cwd`——遵循本仓库插件自有持久状态模式。dsh 会话日志记录工具调用、参数和最终结果或状态摘要，以此为下限满足“模型可见即已记录”规则。

### 运行时、凭据与权限

- 插件在 PATH 上定位 `pi`，缺失时响亮报错并给出安装指引；从不下载或捆绑 pi 运行时。
- pi 原生的模型与凭据配置保持权威。插件只提供可选覆盖：把 provider 和 model 转发为 CLI 参数，以及注入显式环境变量映射。
- `permission` 配置字段取 `reject`（默认）或 `allow`，用于自动应答 pi 的权限记录。child 在父任务当前生效目录中运行；worktree 隔离与跨 harness 审批通道不在范围内。

### 存储与生命周期

插件把 `--session-dir` 钉到 `$DSH_HOME/pi-agent/sessions/`，使备份、清理和卸载语义保持在 Harness home 之内。Host 退出或插件卸载时，插件优雅终止所有运行中的 child。Host 崩溃后，插件下次启动检查标记为运行中的注册表项：先校验遗留进程的命令行确属本插件的 pi child 才终止它，校验不确定时跳过并记录警告，然后把该项标记为 inactive；后续 `send` 从 pi 会话文件冷恢复该 child。

### 覆盖面

插件进入 web、headless、SDK 和 Desktop 各 profile 的插件页。Desktop 可用是因为 Windows GUI 启动继承注册表 PATH；没有 Node 和 pi 的机器按设计响亮失败。macOS 和 Linux 按各自平台文档既有的方式继承会话或登录 shell 环境。

## 已考虑的替代方案

**扩展 subagent 缝隙以支持外部可继续 child。** 贯穿缝隙、两个 SDK 投影、快照和文档的合同变更会让 pi 成为缝隙的一等可继续 child。它落选是因为缝隙的延续机制建立在 dsh Session 之上：外部 child 需要持久外部描述符、跨 activation 的进程所有权，以及每个外部 agent 都会有不同定义的恢复协议。只有一个消费者时就交付这套机制，容易产生只为 pi 适配的抽象；等出现产品级外部延续需求时再立项，并以本插件的语义作为参考实现。

**通过通用 `subagent-acp` provider 挂载 pi。** 无需新代码，但 pi 没有实现 ACP 模式，provider 无法驱动它。

**在缝隙内做一个 one-shot provider（Claude Code 风格）。** 缝隙内最小的路径，但延续是首要需求，one-shot provider 满足不了。

**用普通 shell 命令暴露 pi。** 完全不做插件：模型直接调用 shell 工具。它会失去结构化 child 身份、中断、状态、孤儿清理和冷恢复，而这些正是本次集成的要点。

## 验收标准

- 在 web、headless、SDK 和 Desktop 的 dsh 会话中，模型可以启动 pi child、接收最终答案、追加消息、中断并列出 child；对 Host 重启前记录的 child 执行 `send` 能恢复 pi 对话。
- PATH 上没有 `pi` 时，委托以本地化的可操作错误失败并包含安装指引；不存在回退、重试或静默降级。
- Host 崩溃后，插件下次启动不留下未清点的 pi 进程：已确认的遗留进程被终止，不确定的跳过并记录警告。
- pi 会话文件只存在于 `$DSH_HOME/pi-agent/sessions/` 之下；删除该目录即删除全部 pi 产物。
- dsh 会话日志可重建每个模型可见事实：工具调用、参数和最终结果或状态摘要。
- pi RPC stub 驱动覆盖五个操作、冷恢复、孤儿清理、优雅终止和响亮失败路径的单元测试；真实 pi e2e 在缺少 pi 时自跳过；keyless recorded-session 快照覆盖 start、result 和 follow-up。

## 风险

- pi RPC 协议和会话恢复参数随所装 pi 版本演进；协议漂移会破坏插件。应在检测到不匹配时响亮失败，而不是降级。
- 孤儿清理在命令行校验之后按 pid 终止；pid 复用可能骗过校验，因此清理保持尽力而为，不确定时跳过。
- pi child 位于 subagent 树及其守卫之外；容量控制只有 `maxChildren`。
- `start` 在完成前返回；长任务会占用一个 child 名额，直到其结束或被中断。
