# TDD Plan：数字管理员（Digital Administrator）

状态：已交叉验证（2026-11-13，见文末矩阵）
关联：[spec](../specs/digital-administrator.md) · [OKR](../okr/2026-Q4-digital-administrator.md)
底座：数字员工 plan（`digital-employees-tdd.md`）Stages 0–6 全部落地；本 plan 在其上新增管理层；测试编号 T0–T8 为本 plan 局部命名（与数字员工 plan 的 T1–T6 分文件不冲突）。

## Stage 0 — 通道 spike（调研，不写产品代码）✅ 决议见文末决议节

- T0.1 dws 发送能力：`dws chat` 发消息到指定群/自己的调用语法、输出格式、失败形态。产出：命令样例 + 解析结论落本文件决议节。
- T0.2 dws 接收能力：`dws event` 长连接子进程的启动/输出格式/断线行为；消息事件里发送者 userId 与内容的解析路径。产出：子进程管理样例 + 事件 schema 草案。
- T0.3 通知目标确认：私人通知群的群 id（用户侧准备）；确认白名单 userId。
- 完成标准：三问有结论 + 决议落档；Transport 接口签名据此定稿。

## Stage 1 — 数据层（M1, M2）✅

测试先行（`packages/experimental/pi-agent/tests/employee-store.spec.ts` 扩展）：

- T1.1 admin 记录：`type: 'admin'` + `channel: 'dingtalk'` 校验（非 admin 带 channel 拒绝；admin 缺 channel 拒绝）；类型预设填充（admin 职责模板 + emoji，同 pi-coder 机制）；admin 的 cwd 免用户校验（编排层固定分组目录，store 不拒绝无用户 cwd 的 admin）。
- T1.2 `managerId` 校验：指向不存在的管理员拒绝；指向 admin 类型才合法；pi-coder 不可作为 managerId。
- T1.3 创建自动绑定：`managerId` 缺省时唯一管理员自动补；多个管理员且缺省 → 拒绝（要求显式）。
- T1.4 删除管理员：其绑定员工 `managerId` 全部清空（解绑不删除）。
- T1.5 删除员工：记录移除即解绑（无残留引用）。
- T1.7 人工删除不受限：dsh 侧删除不检查 `managerId`（无管理员/未绑定员工同样可删）——受限的只有管理员工具路径（Stage 4）。
- T1.6 旧记录迁移回填：无 `type`/`channel` 的既有记录补 `type: 'pi-coder'`。

实现：`src/employee-store.ts` 扩展。

## Stage 2 — 管理员会话编排（M3）✅

测试先行（`tests/employee-directory.spec.ts` 扩展）：

- T2.1 admin 创建编排：pi 会话 cwd 固定分组目录（忽略向导 cwd）；adapter route 同 pi-coder（`pi-employee-<id>`）。
- T2.2 admin 会话直通：web 对话注入 admin 职责模板（首次）；后续消息复用同一 pi 会话。
- T2.3 admin 的 pi 子代理启动时注册管理工具（工具注册断言，工具行为归 Stage 4）。

实现：`src/employee-directory.ts` / `src/manager.ts` 扩展。

## Stage 3 — 反馈管线（M4, M6）

测试先行（`tests/admin-pipeline.spec.ts`，stub transport + stub pi）：

- T3.1 绑定员工的回合结算 → Transport.send 收到格式化消息（发送者名 + 回答文本）。
- T3.2 回答超 2000 字符 → 截断 + 省略提示。
- T3.3 未绑定员工（无 `managerId`）的结算 → 不发送。
- T3.4 Transport 失败 → 恰好 3 次重试（退避）→ 仍失败落日志、员工会话不受阻塞（后续回合照常）。
- T3.5 admin 自身回合结算 → 不进入反馈管线。
- T3.6 创建/销毁员工 → 生命周期通知消息（M6）。

实现：`src/admin/pipeline.ts`（结算观察复用 manager 的 settle 事件）。

## Stage 4 — Transport（M5, M10）

测试先行（`tests/admin-transport.spec.ts`，stub dws spawn）：

- T4.1 接口契约：`send` 退避重试 3 次语义（在实现内）；`start` 注册接收回调；`stop` 终止长连接子进程。
- T4.2 dws 发送实现：spawn `dws chat` 参数正确（目标群、内容转义）；非零退出按失败处理。
- T4.3 dws 接收实现：长连接子进程 stdout 解析为 InboundMessage（userId + 文本）；进程退出自动重启（重连）；插件停机时子进程终止。
- T4.4 settings 配置生效：通知群 id、userId 白名单、机器人凭据预留字段（M10）。

实现：`src/admin/transport.ts`（接口）+ `src/admin/dws-transport.ts`（dws 实现）。

## Stage 5 — 白名单与双向注入（M7）

测试先行（`tests/admin-inbound.spec.ts`）：

- T5.1 白名单通过 → 消息注入管理员会话（来源元数据"钉钉"）→ 回答 settle 后 Transport.send 回发。
- T5.2 非白名单 userId → 忽略：不注入、不回发、无副作用。
- T5.3 管理员活动轮未结束时的注入 → 排队（followUp 语义），不并发。
- T5.4 注入遵循员工会话既有消息写入路径（复用直通 adapter）。

实现：`src/admin/inbound.ts`（消费 Transport.receive）。

## Stage 6 — 管理员工具（M8）

测试先行（`tests/admin-tools.spec.ts`，stub transport + stub store）：

- T6.1 创建工具：创建 pi-coder 且 `managerId` = 本管理员；成功后生命周期通知。
- T6.2 销毁工具（正向）：销毁已绑定员工 → 记录删除（解绑）+ 通知。
- T6.3 销毁工具（反向）：销毁未绑定员工 → 拒绝并返回原因，记录不动。
- T6.4 列表工具：仅返回本管理员绑定集（含运行状态）。
- T6.5 派活工具：消息注入指定已绑定员工会话；未绑定拒绝。
- T6.6 查询工具：返回运行/空闲、最近反馈、最后活跃时间；未绑定拒绝。
- T6.7 工具注册：admin 子代理启动时五工具全部注册（对接 Stage 2.3）。

实现：`src/admin/tools.ts`（绑定校验在工具实现内强制）。

## Stage 7 — 向导与命令（M1, M3, M9）

- T7.1 类型步骤：向导第一步两类型卡片；选数字管理员 → 精简字段（无 cwd，模型/思考保留）；选数字程序员 → 既有五字段。组件测试。
- T7.2 多管理员选择：存在多个管理员时创建一线员工需显式选择（向导步骤 / 命令参数）；组件与命令测试。
- T7.3 locale：8 语言字典键齐全（两类型文案、工具相关 toast）。
- T7.4 文档：pi-agent README 双语（管理员章节）、experimental 组表。

## Stage 8 — 全链路验收与 gates

- T8.1 全 gates：doc-sync / lint / typecheck / coverage / constraints。
- T8.2 真机 SMOKE（KR5）：创建管理员 → 钉钉收生命周期通知 → IM 派活数字程序员 → 员工执行 → 反馈回钉钉 → IM 指令创建（自动绑定）/销毁（未绑定拒绝）→ web 直聊管理员。

## 交叉验证矩阵（spec ↔ plan）

| spec 需求 | 覆盖测试 | Stage |
|---|---|---|
| M1 类型两维与预设 | T1.1 T7.1 | 1,7 |
| M2 绑定模型 | T1.2–T1.5 T7.2 T6.1–T6.3 | 1,6,7 |
| M3 管理员双面会话 | T2.1 T2.2 T7.1 | 2,7 |
| M4 反馈管线 | T3.1–T3.4 | 3 |
| M5 Transport | T4.1–T4.3 | 4 |
| M6 生命周期通知 | T3.6 T6.1 T6.2 | 3,6 |
| M7 白名单与注入 | T5.1–T5.4 | 5 |
| M8 管理员工具 | T6.1–T6.7 | 6 |
| M9 dsh 侧路径 | T1.3 T1.5 T1.7 T7.2 | 1,7 |
| M10 通道配置 | T4.4 | 4 |

反向核对：T0.x 为 spike（决议落档，对应 KR4 的 Transport 签名定稿）；T1.x–T8.x 每条均出现在矩阵左列（T7.3/T7.4 locale 与文档对应 KR5 质量门槛，T8.1/T8.2 对应 KR5）。

## Stage 0 决议（2026-11-13 spike，真机验证）

**T0.1 发送（已验证）。** 命令：`dws chat +send-to-group --group <群名或ID> --content <文本> --yes --format json`。返回 `{ success, result.openTaskId }`；`openTaskId` 与事件的 `message_id` 不可关联。**非交互环境必须 `--yes`**（confirmation_required 门，Host spawn 一律携带）。

**T0.2 接收（已验证）。** 命令：`dws event +listen-im --kind group --chat-query <群名> --format json`。启动输出 ready 行（`[event] ready event_key=user_im_message_receive_group bus_pid=… subscribe_id=…`，bus `idle_timeout=300s`），之后每条消息一行 JSON：`{ type, event_id, message_id, conversation_id, sender, sender_open_dingtalk_id, content, create_time, event_time }`。停止：`dws event status` / `dws event stop <subscribe_id> --yes`（停订阅同时停 bus）。

**T0.3 通知目标（已建立）。** 通知群「数字管理员通知」，openConversationId = `cidIEd64NRF/Jr+yTuLnk+0SQ==`；所有者 PaytonWu，openDingTalkId = `D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu`（白名单键），userId = `01014034531454088201`。

**派生实现决策：**
1. **白名单键用 `sender_open_dingtalk_id`**（事件携带；settings 白名单存该值）。
2. **自消息回环过滤**：管线发送走 dws（以用户身份），其通知也会成为事件且 sender 与用户相同——无法按发送者区分。管线发送的每条消息一律以 `【` 开头（【数字管理员】/【系统】/【名】反馈：），入站过滤丢弃 `【` 开头的消息；用户真实指令不会以此开头。
3. **监听器必须被监督**：bus `idle_timeout=300s` 会自行退出——Transport 以"可重启的受监督子进程"持有监听（退出即带退避重启；重启后 subscribe_id 变化无状态可丢，事件为即时通知无补发）。
4. **conversation_id 双向过滤**：入站只接受 `conversation_id` == 配置通知群的群 id 的事件（多群监听误入防线）。

对 plan 的影响：Stage 4 的 dws Transport 按上述命令与过滤实现；Stage 5 的白名单键与回环过滤按 1/2 落地。
