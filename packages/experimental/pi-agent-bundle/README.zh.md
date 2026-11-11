---
description: "把可继续的编码任务委托给 pi 子代理，面向选择外部 pi 运行时的用户。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-pi-agent-bundle

[English](README.md) | 中文

## 概述

启用面向模型的 `pi_agent` 工具，把委托的编码任务交给在独立会话中运行、可继续的 pi coding-agent child。child 可接收后续消息、可被中断，并能在 Host 重启后恢复。它在 Web 与 Desktop 中默认关闭；在插件页选择启用。宿主机要求 PATH 上有 `pi`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 或 Desktop 打开插件页，在 Official 中启用 **PI agent**。关闭开关会移除该 profile 层；包保持安装状态。该工具要求 Host 进程环境能解析到 `pi`，否则带安装指引响亮失败。

开关打开后，`pi_agent` 工具会加入每个 Agent；关闭时从运行中的 Host 移除该工具，存活的 Agent 在下一次请求看到变化。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 Host 上贡献 `optional-pi-agent` 行。更晚的根 patch 可以禁用该行；单独覆盖并不会选中本 bundle。[profile composer](../../boot/app-boot/README.zh.md) 拥有 patch 排序与错误。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[能力实现](../pi-agent/README.zh.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through the pi agent capability: 本 bundle 只贡献 profile 层，工具 schema 与使用指引由 [pi agent 实现](../pi-agent/README.zh.md#model-experience)持有。

#### KV Cache effect

该层自身不贡献模型请求内容；启用或禁用它增删一个工具声明，这是由能力包持有的请求前缀变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **pi 必须在 PATH 上** — 本 bundle 既不下载也不捆绑 pi 运行时。
- **Experimental** — 该能力处于评估期，可能变化或撤回；见 [experimental 组](../README.zh.md#status)。

### 开发备注
<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
