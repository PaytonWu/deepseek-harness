# TDD Plan：数字员工（Digital Employees）

状态：已交叉验证（2026-11-11，见文末矩阵）
关联：[spec](../specs/digital-employees.md) · [OKR](../okr/2026-Q4-digital-employees.md)
原则：每个 Stage 先写测试（red）再实现（green）；Stage 0 是无测试的调研 spike，产出回答 spec §5 开放问题的决策记录（追加到本文件）。

## Stage 0 — Seam spike（调研，不写产品代码）

- S0.1 回答 Q-A：调研侧边栏会话分组的注入扩展点（client ui-sidebar / workspace 会话分组面）。产出：分组注入方案 + 示例补丁。
- S0.2 回答 Q-B：验证直通缝。候选优先级：① `agent/pre-step` 或 `agent/request` waterfall 拦截员工会话 prompt；② 专用员工 preset。产出：选定缝 + 最小可行拦截 PoC（stub pi）。
- S0.3 回答 Q-C：绑定持久化位置决策（会话事件 vs employees.json 内的映射表）。
- 完成标准：三个问题有决策 + 本文件"Stage 0 决议"节落档；不合并产品代码。

## Stage 1 — 员工目录 EmployeeStore（N1, N2, N8 部分）

测试先行（`packages/experimental/pi-agent/tests/employee-store.spec.ts`）：

- T1.1 空/缺文件初始化为空目录；`list()` 返回空。
- T1.2 create 持久化并回读（跨实例）；id 8 位随机不重复。
- T1.3 create 校验拒绝：空 name、空 description、cwd 不存在、导入 piSessionFile 不存在、名称重复——每例一条测试。
- T1.4 update 生效并持久化；update 未知 id 响亮失败。
- T1.5 delete 移除并持久化；未知 id 响亮失败。
- T1.6 畸形 employees.json 加载响亮失败（非数组/缺字段）。
- T1.7 原子写（写入后文件 0600；临时文件不残留——以现有 atomic-write 行为为准做冒烟断言）。

实现：`src/employee-store.ts`（模式复用 registry.ts）。

## Stage 2 — Remote API（N1 的 API 面）

测试先行（`tests/employee-api.spec.ts`，走 typert gateway fixture，模式参考现有 remote 方法测试）：

- T2.1 list 返回全部员工。
- T2.2 create/update/delete 参数透传与错误码映射（名称重复、cwd 缺失、导入缺失）。
- T2.3 未认证/越权行为与现有 API 面一致（如 fixture 支持）。

实现：`src/employee-remote.ts` 注册 Remote 方法。

## Stage 3 — 员工会话直通（N4, N5, N6, N7, N8 回填）

依赖 Stage 0 的 Q-B 决议。测试先行（`tests/employee-session.spec.ts`，stub pi）：

- T3.1 绑定：员工首次会话消息 → 创建会话绑定 + 记入分组（断言绑定存储变更）。
- T3.2 直通：绑定会话的 prompt 不产生 LLM 请求（mock adapter 断言零调用），pi 收到消息，回答回写为助手消息。
- T3.3 首注入：新建 pi 会话的第一条 sendPrompt 是职责描述，第二条才是用户消息。
- T3.4 续用：同员工第二条消息走同一 pi 会话（stub 断言 `--session` 复用）；重启插件实例后冷恢复（新进程 attach）。
- T3.5 导入：员工带 piSessionFile 创建时，首次消息以该文件冷恢复（不注入职责描述）。
- T3.6 中断：运行中停止 → pi 收到 clear_queue+abort；已产生回答回写。
- T3.7 并发边界：员工活动轮未结束时再发消息 → 排队（followUp 语义），不并发两轮。
- T3.8 回答 bounded（超长截断到 MAX_RESULT_CHARS）。

实现：`src/employee-session.ts`（复用 PiRpcChild/PiChildManager）。

## Stage 4 — UI（N3, N9）

- T4.1 分组注入：client 测试断言"我的数字员工"分组出现且不动 Ungrouped。
- T4.2 向导弹窗：组件测试——必填校验、cwd 浏览（复用 in-page picker overlay）、导入字段可选、提交调用 employee/create。
- T4.3 员工入口：员工名 + 状态点（idle/running/inactive 数据驱动）。
- T4.4 locale：8 语言字典键齐全（check:i18n 覆盖）。
- 手动验收清单（进本文件）：创建→对话→中断→重启→续对话全流程录 GIF（record-browser-gif 规则）。

实现：client 插件组件 + `locale/*.json`。

## Stage 5 — 端到端与文档

- T5.1 keyless 快照：向导创建员工 + 一轮员工对话（stub pi）进 `test:snapshot`。
- T5.2 真实 pi e2e：无 pi 自跳；有 pi 时员工会话真实一轮。
- T5.3 文档：pi-agent README 双语更新（员工层）、Agent Note 移交/更新、experimental 组表、`pi_agent` 工具描述补员工入口说明。
- T5.4 全 gates：doc-sync / lint / typecheck / constraints / coverage / test:snapshot。

## 交叉验证矩阵（spec ↔ plan）

| spec 需求 | 覆盖测试 | Stage |
|---|---|---|
| N1 员工 CRUD 与校验 | T1.2 T1.3 T1.4 T1.5 T2.2 | 1,2 |
| N2 目录持久化 | T1.1 T1.6 T1.7 | 1 |
| N3 命名分组 | T4.1 | 4 |
| N4 绑定持久/重启恢复 | T3.1 T3.4 | 3 |
| N5 直通 | T3.2 | 3 |
| N6 首注入职责描述 | T3.3 T3.5（导入不注入） | 3 |
| N7 会话中断 | T3.6 | 3 |
| N8 导入/新建回填 | T1.3(导入校验) T3.4 T3.5 | 1,3 |
| N9 UI 向导/入口/locale | T4.1–T4.4 | 4 |
| N10 匿名工具不变 | 既有 16 测试不回归 | 3 |

反向核对：每个 Stage 的每条测试都出现在矩阵左列 —— T1.x/T2.x/T3.x/T4.x/T5.x 全部可追溯（T2.3 为 API 面一致性保护，属 N1 API 面附带；T5.x 为质量门槛，对应 KR4）。

## Stage 0 决议（spike 后回填）

（待 Stage 0 完成后填写 Q-A/Q-B/Q-C 的决策与依据。）
