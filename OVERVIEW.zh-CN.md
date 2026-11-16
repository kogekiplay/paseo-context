Paseo Context 展示上下文组成、请求历史、用量趋势、文件与命令活动及 Agent 协作。直接复用当前 dsh-context 界面，保留原版多色配色、明暗样式和八种界面语言。

在 Agent 面板打开上下文或编队，点击 composer 的“上下文”按钮或输入 `/context`；侧栏“上下文洞察”提供跨会话用量和日期筛选。

需要 Paseo 0.15.4 或更新版本及 daemon 上的 Node.js 22+。完整交互界面支持 Desktop、网页及 iOS/iPadOS 原生客户端，包括窄屏布局。Android 的独立消息桥为实验性支持。

daemon 优先读取本地 Codex、Claude Code 的 JSONL 日志，其他会话使用 Paseo timeline 回退。实际 tokens 来自供应商报告；组成、费用和可观测耗时为估算。未记录的工具定义、系统提示词、供应商内部状态及附件内容无法还原。

偏好设置控制面板位置、日期范围、趋势、排序和编队显示。提示词前缀/后缀应用于新建 Agent 的系统提示词，并发送到所选模型提供方。

会话文本仅通过所选 Paseo 主机的插件 RPC 传到自己的客户端。公开网络请求用于获取 models.dev 价格、GitHub 版本和推荐信息以及 HTTPS 推荐图标。daemon 显式配置 DEEPSEEK_API_KEY 时可使用官方余额 API；不读取 DSH 配置或凭据。插件拥有 daemon 用户的文件访问权限。
