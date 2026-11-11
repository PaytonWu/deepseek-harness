**pi agent** 工具让 dsh agent 把编码任务交给 pi coding-agent child，让它在工具调用之间保持存活，并在之后继续同一段对话。

每个 child 都作为独立 pi 进程运行，拥有自己的会话、模型、工具与凭据。dsh agent 用一条自包含任务启动 child、接收回答，随后可以追加消息、中断正在运行的轮次或查询状态。child 在后台持续运行；Host 重启前记录的 child 在再次收到消息时会从其 pi 会话文件恢复。

pi 自身的配置保持权威。宿主机要求 PATH 上有 `pi`；缺失时所有操作都会带安装指引响亮失败。会话文件位于 Harness home 之下，删除该目录即删除全部 pi 产物。
