# Spec：数字员工（Digital Employees）

状态：已评审（2026-11-11，与 OKR [2026-Q4](../okr/2026-Q4-digital-employees.md) 对齐）
关联：[TDD plan](../plans/digital-employees-tdd.md)（交叉验证矩阵见文末）
底座：现有 `packages/experimental/pi-agent/`（RPC 子进程管理、指针注册表、`pi_agent` 工具）全部复用，本 spec 在其上新增员工层。

## 1. 术语

| 术语 | 定义 |
|---|---|
| **数字员工**（employee） | 用户创建的具名 pi 编码代理实体：`{ id, name, description, cwd, piSessionFile? }`。`piSessionFile` 为空表示首次对话时新建 pi 会话并回填；非空表示绑定已有 pi 会话文件（导入）。 |
| **员工会话**（employee session） | 绑定到某员工的 dsh 会话，位于命名会话分组"我的数字员工"下；用户在其中的消息直通该员工绑定的 pi 子代理。 |
| **直通**（passthrough） | 员工会话的用户消息不经过 dsh 主 LLM；由插件转发给 pi 子代理，pi 回答回写为该会话的助手消息。 |

## 2. 用户场景

### S1 创建员工

用户在侧边栏"我的数字员工"分组头部点击"新建数字员工"，向导弹窗依次收集：名称（必填）、职责描述（必填，多行）、工作目录（必填，目录浏览）、导入已有 pi 会话（可选：填 pi 会话文件路径或会话 id；留空则首次对话时新建）。提交后：

- 员工写入员工目录（见 §3.1）；
- 分组下出现该员工的会话入口（首条消息时创建会话并绑定）。

### S2 与员工对话

用户点开员工入口进入员工会话，发送消息：

1. 插件确保该员工的 pi 子代理存活（已绑定则 `--session` 冷恢复，未绑定则新建会话并回填绑定）；
2. 首次新建 pi 会话时，先以一条内部 sendPrompt 注入员工职责描述作为开场指令；
3. 用户消息 sendPrompt 给 pi；pi 回答（`agent_settled` 后的 lastAssistantText）回写为员工会话的助手消息；
4. 运行期间会话显示运行状态；用户可中断（clear_queue + abort），中断后已产生的回答照常回写。

### S3 编辑与删除

- 编辑：向导复用，改名称/职责/cwd；cwd 变更仅影响后续 pi 子代理启动（活动进程不迁移）。
- 删除：确认弹窗；员工目录项与会话入口移除；pi 会话文件**保留**（用户数据不自动删）。

### S4 重启恢复

Host 重启后：员工目录、分组、会话绑定完整恢复；继续对话走冷恢复续用同一 pi 会话（KR3）。

## 3. 行为规格

### 3.1 员工目录（EmployeeStore）

- 存储：`$DSH_HOME/pi-agent/employees.json`，原子写（`dsh-atomic-write`，0600）。
- 记录：`{ id: <8位随机>, name, description, cwd, piSessionFile?: string, createdAt }`。
- 校验：name/description 非空；cwd 必须是已存在目录；导入的 piSessionFile 必须指向已存在文件；畸形文件响亮失败（同 children.json 策略）。
- 变更即持久化；读取在插件启动时一次完成。

### 3.2 分组与会话绑定

- "我的数字员工"是**命名会话分组**，不修改全局 "Ungrouped" 文案。
- 员工的 dsh 会话建立绑定时进入该分组；绑定关系持久（会话日志/插件存储）。
- 员工会话在 UI 中显示员工名（会话标题默认取员工名）。

### 3.3 直通语义（passthrough）

- 员工会话的 user message 提交后**不发起 dsh 主 LLM 请求**；插件负责转发并回写答案。
- 回写内容：pi 的最终回答文本（bounded，复用 MAX_RESULT_CHARS）。
- 中断：暴露为会话级停止按钮语义（触发 pi interrupt）。
- 现有 `pi_agent` 五操作工具保持不变，仍可在普通会话中使用（匿名委派逃生门）。

### 3.4 API 面（Remote methods）

`employee/list`、`employee/create`、`employee/update`、`employee/delete`：参数与 §2 场景一致；错误码可定位（名称重复、cwd 不存在、导入文件不存在等）。

### 3.5 UI

- 分组头部"新建数字员工"按钮 → 向导弹窗（表单校验内联显示）。
- 员工会话入口：员工名 + 运行状态点（idle/running/inactive）。
- 全部文案走 locale 字典（8 语言：en/zh/ja/es/fr/de/ru/pt）。

## 4. 非目标

同 OKR 非目标；另：v1 不做员工头像/品牌化、不做员工使用统计。

## 5. 开放问题（进入 plan Stage 0 spike 解决）

- Q-A：会话侧边栏命名分组能否由 Host/Client 插件注入？具体扩展点？
- Q-B："直通"的最佳实现缝：agent waterfall 拦截（`agent/pre-step`/`agent/request`）、专用 agent preset、或 client 侧专用视图？dsh 会话基础设施（日志/历史/搜索）必须完整复用。
- Q-C：员工会话的绑定关系存哪（会话事件 vs 插件存储）以同时满足"会话可搜索"与"重启恢复"。

## 6. 需求追溯 ID（供 plan 交叉验证）

| ID | 需求 |
|---|---|
| N1 | 员工 CRUD（含校验：非空、cwd 存在、导入文件存在、名称唯一） |
| N2 | 员工目录持久化于 `$DSH_HOME/pi-agent/employees.json`（原子写，畸形响亮失败） |
| N3 | 命名分组"我的数字员工"（不改 Ungrouped） |
| N4 | 员工会话绑定与分组归属持久，重启恢复 |
| N5 | 直通：员工会话消息不进 dsh LLM，转发 pi，回答回写 |
| N6 | 首次 pi 会话注入职责描述 |
| N7 | 会话级中断（pi interrupt 语义） |
| N8 | 导入已有 pi 会话（绑定既有文件）/ 留空新建并回填 |
| N9 | UI 向导 + 分组入口 + 状态显示，8 语言 locale |
| N10 | `pi_agent` 匿名工具行为不变 |
