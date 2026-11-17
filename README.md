# Paseo Context

[English](README_en.md)

Paseo 的上下文洞察插件。基于 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 的公开 fork，直接复用上游当前版本的 React 界面、CSS、图表、浏览器和八种语言翻译，以 Paseo 的会话数据替换原宿主数据源。

保留原版多色配色及原版明暗样式，不将图表改成 Paseo 的主题色。界面源代码来自上游，而不是根据旧截图重画。

以下为插件实际运行截图，使用仓库内生成的示例数据：

![上下文面板](docs/screenshots/context.png)
![Agent 编队](docs/screenshots/fleet.png)

## 安装

需要 Paseo **0.16.0 或更新版本**，以及可运行 Node.js 22+ 的 daemon。完整交互界面直接运行于 Desktop、网页及 iOS/iPadOS 原生客户端；手机和平板使用上游响应式布局。原生端复用 Paseo 内置 WebView，iPad 客户端已完成真实运行握手。Android 提供独立消息桥，目前属于实验性支持。

在 Paseo 启用插件后安装：

```sh
paseo plugin install git:kogekiplay/paseo-context
```

也可在 Settings → Plugins 中输入 `git:kogekiplay/paseo-context`。安装时会从源码构建原版界面。插件运行于所选 daemon，远程连接时读取远程 daemon 的会话记录。

从源码开发：

```sh
git clone https://github.com/kogekiplay/paseo-context.git
cd paseo-context
npm ci --ignore-scripts
npm run build
paseo plugin install "$PWD"
```

修改后执行 `npm run build` 和 `paseo plugin reload paseo-context`。

## 界面与入口

- **上下文标签页和 Explorer 侧栏**：上下文组成、实际使用量、Token 分类、耗时、趋势、逐步/逐轮切换、全量/增量及前一步/前一轮对比。
- **上下文浏览器**：原版 DNA、分组列表、矩形树图、消息和工具筛选、内容展开、系统提示词与工具定义查看。
- **文件活动、命令执行**：读取/写入/搜索、行数和次数、失败命令、执行耗时及后台进程状态。
- **编队**：Agent 网络、跨 Agent 通信时间线、委派、捕获到的任务与依赖、Paseo“子任务”、提示词和回复详情。子任务直接读取 Paseo 时间线，保留运行中、已完成、失败和取消状态，并关联已有子代理。
- **上下文洞察**：跨会话用量、日期范围、热力图、技能/工具/程序排行、搜索、归档和目录筛选。
- **默认标签页**：进入 Agent 会话后，自动添加“上下文 / 编队 / 统计”，随后返回原会话标签。输入区不再常驻“上下文”按钮。三个入口同时出现在工作区标签栏“+”菜单，关闭后可从这里重新打开。
- **统计**：直接复用原版轮次／步骤表、工具详情、耗时条、合计、事件行、上下文增量、最新／累计和展开控件。完整读取会话；未记录的首 Token、解码速度等数据保持未知。
- **命令**：`/context`、`/context fleet`、`/context stats` 打开对应标签；`/context insights` 打开跨会话洞察，`/context modal` 保留弹窗。
- **偏好设置**：面板位置、编队开关、洞察入口、默认范围、图表粒度、增量基线、排序和趋势设置。

三个面板是 Paseo 原生工作区标签页，与 Agent、终端和文件并列；同一工作区各保留一个。只有一个可选会话时不显示选择器；多个会话时通过顶部紧凑入口切换，选择会在三个面板间共享并持久保存到标签状态。每个 Agent 在当前客户端插件生命周期内自动初始化一次，手动关闭标签后不会在每次会话更新时强行重开。Paseo 当前没有会话内部固定子标签或禁止关闭标签的插件接口。

标签初始化使用公开导航返回原 Agent。冷启动时先打开第一个面板，在它挂载的布局阶段取得导航、创建其余面板并立即返回会话。这个初始化交接只短暂有效；离开原会话、面板加载超时或插件停止后取消，之后手动打开面板不会触发延迟回跳。手机返回会话时不需要聚焦输入框或弹出键盘。

面板位置设为“仅侧栏”时，上下文命令打开 Explorer，自动标签只添加编队和统计；设为“隐藏”则不自动添加标签。关闭编队设置会隐藏其菜单项并停止自动添加。旧版已打开的 Agent 专属面板仍可使用。

原版设置中的提示词前缀/后缀映射为 Paseo **新建 Agent 的 systemPrompt**。修改设置不会重写已有 Agent 的提示词；Paseo 当前没有与上游逐请求动态系统提示词章节完全等价的插件接口。

页面按需读取数据：上下文先显示当前会话，再独立补齐子 Agent 费用；编队只传图表所需的摘要，完整消息按需读取；统计只加载原版表格数据。未变化的会话跳过全文重传与重绘，隐藏文档暂停页面轮询。语法字典经本地主机按需加载，所有原有语言仍可使用；设置页不轮询会话，公开价格请求也不阻塞看板首屏。

## 数据来源与统计口径

优先读取 daemon 本地的 **Codex rollout JSONL** 和 **Claude Code 会话 JSONL**，包括完整已落盘历史、压缩后的替代历史、回滚和工具结果。其他 provider 或无法找到原始日志的会话，使用 Paseo timeline 分页回退。

“实际”表示供应商已报告的用量；彩色组成是对可观测文本的估算，使用上游的固定密度算法。日志未记录的系统提示词、工具 schema、加密思考、服务端注入和不可观测阶段无法还原，空值不代表这些内容没有消耗 tokens。回退 timeline 的用量和内部上下文尤其有限。

费用按公开模型价目估算；未知模型保持未计价。时间表示可观测的请求/工具区间；并行工具的总工作耗时与实际忙碌时长分别计算。输出速度基于具有可用耗时的输出样本。它们不是账户账单或供应商完整服务端追踪。

原生用量和计时适配参考 [CC Switch](https://github.com/farion1231/cc-switch/tree/ed6d51e590ff8a34431ca60eacfc78e12704075b)：Codex 优先使用精确的 `last_token_usage`，支持缓存字段别名，缺少单次数据时才用累计差值；输入已含缓存，不重复相加。模型/首 token 耗时按日志边界估算，排除工具结束后才写入 usage 的等待；缺少输出开始事件时不猜首 token 或生成速度。统计表逐字段保留“未记录”，包括未报告的缓存读写；已报告的零仍为零。运行中和被打断但尚无 usage 的步骤也会保留。

Paseo 原生子 Agent 关系及日志中的子会话会映射到编队。任务、收件人、状态和依赖以日志实际捕获的字段为准。未公开的 Agent 团队内部状态无法凭空补齐。

原宿主的账号钱包、资源协议、文件管理器和会话内置页面没有保留兼容层。文件操作改用 Paseo Context 自己的预览，复用上游富文本查看器；支持当前文件的文本（前 2 MiB）和图片（20 MiB 内）预览。日志内保留的图片可直接查看；缺失的附件与不支持的二进制格式会明确提示不可用。

## 网络与隐私

会话文本通过所选 Paseo 主机的插件 RPC 传给自己的客户端，不上传到第三方分析服务。界面随插件构建并在隔离 frame 中运行；不加载远程脚本。

daemon 会请求 `models.dev` 获取公开模型价格、GitHub 获取本 fork 的最新 release 与上游推荐卡片数据。推荐图标可能由客户端从对应 HTTPS 图片服务加载。这些请求不携带会话文本。会话中已引用的 HTTPS 图片地址只在展开对应图片预览时由客户端加载。

若 daemon 环境显式配置了 `DEEPSEEK_API_KEY`，插件可请求 **DeepSeek 官方** `https://api.deepseek.com/user/balance` 显示余额；未配置时隐藏。该密钥仅用于官方余额接口，不经客户端或其他站点发送，不读取 DSH 的配置或凭据。

插件是 Paseo 的受信任本地代码，拥有 daemon 用户的文件访问权限。提示词前缀/后缀会随新 Agent 的系统提示词发送给用户选择的模型提供方。

## 开发与同步上游

```sh
npm run check
npm run build
```

`src/client` 和 `src/shared` 保留上游布局，`web/` 提供原版界面的独立构建及宿主桥接；`client/` 为 Paseo 入口容器，`server/` 为日志和 SDK 适配，`shared/core/` 为 daemon 使用的上游分析算法。

本仓库保留 GitHub fork 关系与完整历史。上游基线为 **v0.85.1 后的 `9e221195ac7c02cff9a21311dda6d61f50cf50d3`**。同步流程、需要保护的宿主边界见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

## 许可与致谢

项目沿用 Apache-2.0，原作者与许可见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。原版 UI 使用的 MIT primitives、theme、store 等静态模块保留在 `web/vendor/`，没有 DSH/Cordis 宿主运行时依赖。第三方授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
