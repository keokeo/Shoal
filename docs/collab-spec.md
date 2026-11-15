# Shoal 跨厂商原生 CLI 轻量协作机制规范

本文档定义 Shoal（`agent-workbench`）中面向 Claude Code、Codex CLI 与 Antigravity CLI（`agy`）的三层轻量协作机制，以及支撑安全投递的底层 PTY 护栏。

## 1. 设计原则与硬边界

1. **普通窗口零膨胀**：不在终端面板增加常驻审阅状态条、不弹窗打断对话、不改动标题栏「通过」按钮的现有语义、不引入强制送审工作流。
2. **绝不触碰终端容器高度**：保持 ConPTY 不因动态横幅改尺寸（避免历史重绘闪烁问题），任何界面增量仅放在已有模态框或浮层内。
3. **严格遵守 `agy -p` 禁用规则**：交互式 `agy` 会话只通过标准启动参数（`--add-dir`）与工作台终端排队投递参与协作，绝不调用无头 `agy -p`。
4. **同项目强隔离**：协作索引、快照与 `shoal` CLI 互调一律严格限定在发起方任务所属的 `projectId` 内部；跨项目会话不可相互列举、读取或投递。
5. **不污染用户指标**：后台自动投递与自动回传不改写任务自动标题（`titleAuto`）、`lastPrompt` 预览及侧边栏 `lastActiveAt` 活跃排序。

## 2. 底层基础：4 道 PTY 安全投递护栏（`server/sessions.ts`）

向交互式 CLI 终端排队粘贴提示词前，`deliverable()` 与 `deliver()` 必须同时满足以下条件：

1. **首轮启动完成护栏（`!initialPromptPending`）**：带初始提示词新建会话时，等待首轮 hook 启动（或在静默 CLI 无首轮提示/到达 4 秒 `quiet` 超时/`Stop` 后自动解除，避免 Codex 未提交首句前不发 `SessionStart` 造成死锁）。
2. **启动弹窗阻塞护栏（`!startupBlocked`）**：首轮尚未完成前，若 PTY 输出出现 Codex/Claude 目录与 hook 信任确认弹窗（如 `Hooks need review`、`Do you trust the files in this folder`、`No, exit`），冻结队列直到用户在终端回车或触发首个会话 hook。
3. **投递在途锁（`now >= deliveringUntil`）**：`deliver()` 弹出队列写终端到 CLI 触发 `UserPromptSubmit` / `PreInvocation` 存在 0.5–2 秒延迟，锁定 `8000 ms` 防止连发两条。
4. **草稿/Ctrl+C 中断保护与输入序号取消**：
   - 使用 `isTerminalReportSequence()` 过滤 xterm 焦点（`\x1b[I`/`\x1b[O`）、SGR 鼠标、CPR 光标与 DA 设备属性自动回报，避免误判用户正在打字；
   - 用户出现可见未提交字符（`hasDraft`）或刚按 `Ctrl+C` 清空中断队列（`interruptedByUser`）时冻结自动排队，直到用户在终端主动回车提交或从 UI 显式发起非系统排队操作；
   - `deliver()` 写入粘贴帧并延迟 `300 ms` 发送 `\r` 前，捕获 `inputSeq`；若期间发生真实用户输入或 `Ctrl+C`，立即取消本次 `\r` 并回退系统计数。

## 3. 三层轻量协作架构

### Layer 1：同项目静默 Markdown 快照黑板（零打扰被动共享）

- 每次主会话非限流 `Stop` hook 到来时，工作台原子写入该任务最新回复摘要：
  - `<stateDir>/collab/<projectId>/turns/<taskId>-latest.md`
- 同时原子刷新项目同伴索引：
  - `<stateDir>/collab/<projectId>/PEERS.md`
- 索引包含同项目所有非归档任务的 `#序号`、`taskId`、标题、CLI 类型、实时状态、最近需求摘要、最新回复文件绝对路径及首行摘要。
- 会话启动环境变量自动注入：
  - `WORKBENCH_COLLAB_DIR=<stateDir>/collab/<projectId>`
  - `WORKBENCH_PEERS_FILE=<stateDir>/collab/<projectId>/PEERS.md`
- 对 `agy` 会话，通过 `--add-dir <stateDir>/collab/<projectId>` 只挂载所属项目黑板目录（传递原始路径、不做 8.3 短名转换），确保 `agy` 仅能读取当前项目黑板；同时不影响主会话工作区归属判定。
- 任务或项目被删除时，对应快照或整个 `<stateDir>/collab/<projectId>` 同步清理。

### Layer 2：转发结果可选「单次自动回传」（`ForwardDialog`）

- 现有「转发结果…」弹窗（`ForwardDialog`）增加 1 个可选复选框（默认**不勾选**）：
  - `对方本轮完成后，自动把结果传回「<源任务>」`（`ForwardBody.replyBack?: boolean`）
- 状态机规则：
  - **新建目标任务**：直接带 `armed = true` 注册一次性的 `ReplyObligation`。
  - **转发至已有任务**：初始 `armed = false`，仅当目标会话后续真正启动由本次注入触发的回合（`systemInjected === true`）时才武装为 `armed = true`。用户在目标终端自己手工输入的轮次绝不会误触发回传。
  - 若目标回合因用户按 `Esc` 取消或命中 `rate_limit` / `error: 'canceled'` 结束，自动作废该回传义务而不回传错误碎片。
  - 目标正常完成 `Stop` 后，消耗本次义务，将 `forwardText`（带 `isAutoReply: true` 与 `peerHop`）投递回源任务并生成一张 `forward` 卡片；**严格 1 跳即止**。

### Layer 3：无感预注入 `shoal` CLI 与按需 Skill

- `writeHookFiles(stateDir)` 在启动阶段幂等生成：
  - `<stateDir>/bin/shoal-cli.mjs`（零外部依赖 ESM 脚本）
  - `<stateDir>/bin/shoal.cmd`（Windows 包装器，优先使用 `WORKBENCH_NODE` 指向的桌面内置 `node.exe`）
  - `<stateDir>/bin/shoal`（POSIX shell 包装器，严格使用 `\n` LF 换行以兼容 Git Bash）
- `SessionManager.spawn()` 对 `process.env` 执行大小写去重后的 `prependEnvPath(env, <stateDir>/bin)`（解决 Windows 下 `Path` 与 `PATH` 大小写并存导致失效问题），并注入会话级随机 256-bit `WORKBENCH_PEER_TOKEN`（进程退出或移除时立即吊销）。
- CLI 命令：
  - `shoal peers [--json]`：查看同项目所有活跃任务与状态（对应 `GET /api/peer/peers`）。
  - `shoal send <target> [-m "<说明>"] [--file <路径>] [--stdin] [--new]`：单向发消息给同项目另一个任务（`target` 自动剥离前导 `@`，避开 PowerShell Splatting 参数吞噬；多行正文通过 `--file` 或 `--stdin` 避开 `.cmd` 换行截断）。
  - `shoal ask <target> [-m "<说明>"] [--file <路径>] [--stdin] [--new]`：发送并在对方本轮完成后自动回传 1 次结果；提示发起方立即结束本轮等待，禁止写轮询死循环。
- 安全与防循环：
  - **鉴权与子代理屏蔽**：仅接受本地无 `Origin` 的 CLI 请求，`Authorization: Bearer <WORKBENCH_PEER_TOKEN>` 通过时间安全比较验证；当 `agy` 会话处于等待内部子代理的 `intermediate-stop`（`subagentWait === true`）时，返回 `403` 拒绝其衍生进程代发外部同伴消息。
  - **文件包含边界**：`--file` 经 `realpathSync` 解析后必须位于所属 `project.path` 或 `WORKBENCH_COLLAB_DIR` 目录内，且体积上限 `512 KB`。
  - **跳数与连发熔断**：自动接力链最大跳数 `MAX_AUTO_HOPS = 4`（超限返回 `429`）；同一会话同一轮次向同一目标连发上限 `2` 次（超限返回 `409`）。
- 按需发现技能：
  - `skills/shoal-collab/SKILL.md`（同步写入 `agy-hooks/.agents/skills/shoal-collab/SKILL.md`），仅在用户提及需要查看其他终端进展或向另一 CLI 协作提问时按需加载，不污染常规提示词。
