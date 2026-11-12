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

## 执行状态（2026-11-11）

- Stage 0 ✅ 决议见下节。
- Stage 1 ✅ EmployeeStore（14 测试）。
- Stage 2 ✅ EmployeeDirectoryService（remote CRUD + 编排；4 测试，gateway wire 层由框架拥有，未重复测试）。
- Stage 3 ✅ 直通以 `pi-employee` LLM adapter 落地（Stage 0 决议 Q-B）；T3.2 的“零 LLM 请求”断言在 adapter 语义下转化为“assistant 文本来自 pi 回答”；T3.1/T3.4 的绑定与恢复由 directory 编排 + store.sessionId 承载（T2 覆盖）；T3.7 排队语义复用 pi 原生 followUp。adapter 语义 6 测试 + 真实 pi 员工冒烟 SMOKE-PASS。
- Stage 4 ◐ 命令向导落地（`/new-employee`，6 测试）；**表单弹窗延后**——需要 `ui-workspace` 新增分组头 slot（产品 UI 变更 + 设计评审），T4.1 分组免费（Workspace 实体）、T4.4 locale 字典随弹窗一并落地。
- Stage 5 ✅ 真实 pi 员工 e2e（SMOKE-PASS）；README 双语；keyless 快照延后（随弹窗 UI 一并录制向导+对话）。测试稳定性：stub 的 stdin 半行缓冲、RPC 命令超时、waitSettled 的 get_state 周期校准三项修复消除了 Windows 多进程竞态（47 测试 20+ 轮全绿）。

## Stage 6 — 创建向导 UI（N11–N16，2026-11-12 增补）

- T6.1 员工数据层：`type/avatar/model/thinking` 字段迁移与校验（默认名"数字程序员 N"递增；type 模板填充 description）；store 测试先行。
- T6.2 `employee/piModels` Remote：临时 pi 子进程实拉 `get_available_models`，Host 生命周期缓存，失败降级为空列表 + 明确错误文案；stub 测试。
- T6.3 `employee/create` 接受新字段；思考强度经子进程就绪后一次性应用（RPC `set_thinking_level`）；模型经 spawn 参数；adapter/ensure 测试。
- T6.4 ui-workspace 分组头新建菜单 slot（产品扩展点）：分组头 `+` 改为菜单触发；slot 注册菜单项；普通分组无注册项时保持原行为（直接新建会话）；组件测试。
- T6.5 pi-agent client 面（新 `/client` 入口）：注册"数字程序员"菜单项 + 五字段设置对话框（emoji 徽章集、目录浏览、模型/思考强度下拉）+ 侧边栏员工头像徽章（row leading）；8 语言字典；组件测试。
- T6.6 live 验收：`+` → 菜单 → 对话框 → 创建 → 分组下出现具名带头像员工 → 一轮对话（延续实测驱动）。

交叉验证增补：N11↔T6.4、N12↔T6.1、N13↔T6.1/T6.5、N14↔T6.5、N15↔T6.2、N16↔T6.3；T6.6 对应 KR1/KR2 活体验收。

## Stage 0 决议（2026-11-11 spike）

**Q-A 分组：用 Workspace 实体，零 UI 注入。** 侧边栏分组就是 Workspace（`Ungrouped` 是无 workspace 会话桶）。插件初始化时 `workspace/create`（path=`$DSH_HOME/pi-agent/workspace`，mkdir 保证存在）并 rename 为“我的数字员工”；员工会话 `session/create { workspaceId }` 天然落入分组。UI 改动仅剩向导与入口（Stage 4 减重）。

**Q-B 直通：pi 作为自定义 LLM adapter（route-per-employee）。** 会话事件写入面受保护（插件只能 appendPluginRecord，不能写 `assistant/message`），`agent/request` waterfall 只改模型参数、`PreStepDecision.reject` 不携带回复——均不可用。正缝是 `ctx.llm.registerAdapter`：插件为每个员工注册 provider route `pi-employee-<employeeId>`，其 `stream(options)` 不调真模型，而是转发最后一条用户消息给该员工的 pi 子代理（首次新建 pi 会话时先注入职责描述），等待 settle 后把回答作为 text chunk 流返回。dsh 的完整会话生命周期（消息写入、流式、历史、搜索、中断 signal）全部免费复用；MockAdapter 即此模式的先例。中断：`options.signal` abort → pi `clear_queue`+`abort`。

**Q-C 绑定：employees.json 存 `sessionId`。** 员工记录增加 `sessionId?: SessionId`（1:1，v1）；重启恢复走 `session/create` 的 blank-session 复用 + `selectModel('pi-employee-<id>', 'pi')`。会话本身是普通 dsh 会话，可搜索性天然成立。

对 plan 的影响：Stage 3 的“直通”卖现为 adapter（`src/employee-adapter.ts`）；Stage 4 的分组工作转移到 Stage 3（workspace 初始化）；UI 仅剩向导+入口。测试编号不变，映射表维持有效。
