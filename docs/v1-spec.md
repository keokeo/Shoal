# Shoal v1 需求与方案

> 项目原名 Agent Workbench，本文是开发时的设计记录，文中的“虾哥”指作者。

状态：草案；M0 技术验证已通过（2026-11-08，报告见 `.tmp/m0/REPORT.md`）；M1 已通过（2026-11-08，见 `.tmp/m1/RUN.md`）；M2 已通过（2026-11-09，见 `.tmp/m2/RUN.md`）

## 1. 要解决的问题

虾哥平时同时开 3–9 个 agent 会话（Claude Code、Codex、agy），分布在多个项目里。现状的痛点：

1. 终端分屏越多，每屏显示越少；开多个窗口又挤满任务栏。
2. 窗口长得太像，焦点没切过去，指令发错会话。
3. 某家额度用完要换 agent，新 agent 得去读旧会话记录，费时间也费 token。
4. agent 之间传结果只能复制粘贴或者靠中间文件。

## 2. 定位

本机运行的网页工作台，以任务为中心。虾哥负责派活和验收，agent 从头到尾负责一个任务，中途的开发和测试过程虾哥不关心。

第一版由虾哥派活。参考 DeepSeek super-agent 的分层：虾哥担任派活的 Router 层，各 agent 会话是干活的 Worker 层。

## 3. 硬性约束

- **只驱动各家原生的交互式 CLI**（`claude`、`codex`、`agy`），放在 PTY 里运行。不用 headless、SDK、app-server 或 ACP 去跑主要工作，因为实测这些方式更耗额度。
- **Windows 原生**：Windows 11，不依赖 WSL、`/bin/sh`、`curl`、`which`。
- **只在本机使用**：只监听 `127.0.0.1`；接口和鉴权按以后要支持手机访问来设计，但 v1 不开放给外部。
- **不改坏现有配置**：现有的 hooks（token-tracker、Codex `notify`、computer-use 等）只能追加，不能覆盖。

## 4. 核心流程

```
新建任务：选项目目录 → 选 agent → 写需求 → （可选）开 worktree，开之前弹窗确认
  → 进行中：PTY 在后台运行，点开可以看完整终端，也能直接打字干预
  → 停下：hook 或终端输出判断出 agent 在等人
      ├─ 中途在等你回答或授权 → 「需要你」队列
      └─ 任务做完 → 「待验收」队列，显示结果卡片
  → 验收：通过就归档
          有问题就写反馈 → 默认开新会话，注入任务卡片和反馈；也可以选择续接旧会话
  → 额度用完：生成交接卡片 → 一键换另一个 agent 接着做
  → 转发：把某张结果卡片连同一句要求发给另一个任务或 agent
```

## 5. 功能范围

### v1 必须有

| 功能 | 说明 |
|---|---|
| 项目和任务列表 | 左侧按项目分组列出任务；每个任务显示当前 agent、状态和等待时长 |
| 会话视觉区分 | 每个任务有一个固定颜色，主区域的边框、标题栏和输入提示都用这个颜色；标题显示“项目 / 任务 / agent” |
| 输入跟着主区域走 | 只有主区域显示的那个会话能收到键盘输入；切换会话时标题闪一下；不弹发送确认框 |
| 主区域 | 默认一次显示 1 个会话，可以切成 2 个并排；会话不会因为数量多而被切小 |
| 「需要你」和「待验收」队列 | 按等待时间排序；``Alt+` `` 跳到下一个在等你的会话（Chrome 不把 `Ctrl+Tab` 交给网页） |
| 结果卡片 | 统一格式：结论、可以打开的链接或运行入口、改了哪些文件、做了哪些检查和结果、还没验证的、风险 |
| 反馈和续做 | 默认开新会话并注入上下文；保留“续接旧会话”按钮 |
| 换 agent | 自动生成交接卡片，在同一个目录里用另一家 CLI 接着做 |
| 转发 | 把结果卡片加一句要求，粘贴到目标会话里 |
| 可选 worktree | 每个任务自己决定开不开，开之前弹窗确认；放在 `<repo>/.worktrees/<branch>` |
| 持久化 | 关掉工作台重新打开后，任务、会话 ID、卡片都在；PTY 进程不保留，重开时用续接命令恢复 |

### 以后再做

让一个 agent 当总调度来派活、自动在多个 agent 之间流转、手机访问、Watchdog 监控、打包成桌面应用、多台机器。

## 6. 技术方案

### 6.1 技术栈

- 服务端：Node 24 + TypeScript，`node-pty`（Windows 上用 ConPTY），HTTP + WebSocket，`node:sqlite` 做持久化。
- 前端：React + Vite，`@xterm/xterm` 加 fit、webgl、search 扩展。
- 测试：Vitest 测纯逻辑；Playwright 加一个假的 agent CLI 做 e2e；三个真实 CLI 各做一次 smoke 测试。

### 6.2 在 Windows 上启动 CLI（M0 已验证）

- 不经过 `.cmd` 包装，直接启动真正的程序：Claude 用 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，Codex 用 `node %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`，agy 用 `%LOCALAPPDATA%\agy\bin\agy.exe`。
- 启动命令表（hooks 参数见 6.3）：

| agent | 新会话 | 续接 | 怎么拿到会话 ID |
|---|---|---|---|
| Claude | `claude.exe --session-id <uuid>` | `claude.exe --resume <uuid>` | 工作台自己生成 UUID |
| Codex | `codex.js -c check_for_update_on_startup=false` | `codex.js resume <id> ...` | hook payload 的 `session_id`；SessionStart 要等第一次提交 prompt 才触发 |
| agy | `agy.exe` | `agy.exe --conversation <id>` | hook payload 的 `conversationId` |

- 环境变量：注入 `WORKBENCH_SESSION_ID`、`WORKBENCH_PORT`、`WORKBENCH_HOOK_TOKEN`；删掉从父进程继承来的 `CLAUDECODE`、`CLAUDE_CODE_*`、`CODEX_SANDBOX*`、`CODEX_THREAD*`、`AGY_SESSION*`，免得被识别成嵌套会话。
- **启动阶段的对话框不能盲答**：信任目录（Claude 的默认选项是 "No, exit"）、Codex 的 "Hooks need review"、更新提示、登录提示。工作台识别出这类对话框后，把会话放进「需要你」，由虾哥处理。

### 6.3 状态检测：hooks 为主，终端输出为辅

- **每次启动时注入 hooks，不改全局 hooks 文件**。三家都执行 `node <workbench>/hooks/notify.mjs <agent> <event>`，这个脚本把 payload POST 到 `127.0.0.1:<port>/hook`：
  - Claude：`--settings <tmp.json>`，内容为 `{hooks:{Stop:[{hooks:[{type:"command",command,timeout}]}], ...}}`。会和用户已有的 hooks 合并，不覆盖。
  - Codex：`-c 'hooks.<Event>=[{hooks=[{type="command",command=...,timeout=5}]}]'`。**第一次需要虾哥在 `/hooks` 里信任**；信任记录的 key 是 `<session-flags>:<event>:0:0`，跟具体会话无关，信任一次就一直有效。不使用 `--dangerously-bypass-hook-trust`，因为它会连带执行用户自己没信任的 hooks。
  - agy：`--add-dir <dir>`，dir 下放 `.agents/hooks.json`，格式为 `{workbench:{Stop:[{type:"command",command,timeout}]}}`。agy 通过 `cmd /c` 执行命令，**命令里不能带引号**，所以工作台的安装路径不能含空格。
- 事件映射：
  - Claude：`Stop`、`StopFailure` 视为停下；`Notification`、`PermissionRequest` 视为在等你；`UserPromptSubmit`、`PreToolUse` 视为在工作。
  - Codex：`Stop` 视为停下；`PermissionRequest` 视为在等你；`UserPromptSubmit` 视为在工作。终端输出里的 OSC 7501 `state=done|idle:app=codex` 作为辅助信号。
  - agy：`Stop` 视为停下（带 `terminationReason`、`fullyIdle`、`error`）；`PreInvocation` 视为在工作。
- **Ctrl+C 不会触发 Stop**（三家都实测过）：工作台发出 Ctrl+C 后，自己把状态设为「需要你」。
- **兜底**：分析终端输出，比如出现输入提示符、“esc to interrupt”这类忙碌标志，或者 15 秒没有输出。
- **区分“做完了”和“在等你”**：停下时读取最后一条 assistant 消息。Claude 和 Codex 从 hook 的 `last_assistant_message` 取；agy 的 payload 里没有，要从 `transcriptPath`（`transcript_full.jsonl`）里读 PLANNER_RESPONSE。消息里有结果卡片标记的进「待验收」，没有的进「需要你」。
- **识别额度用完**：
  - Claude：jsonl 里的 `isApiErrorMessage`、`apiError:"usage_limit_reached"`、`apiErrorParams.rate_limit_info{rateLimitType,resetsAt}`；
  - Codex：`token_count.rate_limits.rate_limit_reached_type`，还没有真实样本；
  - agy：还没有样本。
  - 所有 hook payload 和终端原始输出都落盘，用来补齐样本。
- 实现（M3，`server/quota.ts`）：只对 claude 自动识别。`StopFailure` 的 `error` 为 `rate_limit` 或 `billing_error`，或 `Stop` 的最后回复匹配 `/hit your .*limit/i`，就记到会话的 `limit` 上，这一轮不生成结果卡片；重置时间从 transcript 末尾的 `apiErrorParams.rate_limit_info.resetsAt` 读。之后收到任何“在工作”事件就清掉 `limit`。界面在终端上方显示额度横条和「换 agent」按钮，侧栏显示“额度用完”。codex 和 agy 没有样本，只能手动换 agent。

### 6.4 结果卡片

- 实现（M2）：每轮结束（Stop hook）时，用最后一条 assistant 回复生成结果卡片，任务进入「待验收」。启动时不追加格式说明，也不写 `result.md`，避免改变 agent 的原生行为。
- 回复来源：claude、codex 取 payload 的 `last_assistant_message`；agy 从 `transcriptPath` 中读最后一条 PLANNER_RESPONSE。
- 卡片内容就是回复原文。需要固定格式（结论、changed files、commands、checks、unverified、risk、验收入口）时，由各 CLI 的全局规则约束，工作台不解析格式。

### 6.5 交接卡片（换 agent 或开新会话时用）

- **数据来源**：任务需求、最近一次结果卡片、反馈记录，以及旧会话的原始记录。
- **生成方式**：用一个还有额度、比较便宜的模型读取上面这些内容，写出交接卡片，包括目标、已完成、正在做的、关键决策、踩过的坑、下一步、必须先读的文件。这是一次短调用，虾哥已经同意这部分消耗。
- **按接手模型的能力分级**：能力强的模型只拿卡片和原始记录的路径；能力弱一些的模型再加上必读文件清单、一句话写清楚的下一步和验收方法。
- **参考 T3 Code**：生成交接卡片失败时退一步，按 token 预算选取原始记录：先保留第一条和最后一条需求，再从最近的对话往前补，并标明哪些内容被省略了。

M3 实现（`server/handoff.ts`、`server/transcript.ts`、`POST /api/tasks/:id/switch`）：
- **生成器就是接手的 agent**，用它的 headless 模式跑一次短调用。这样不需要另配“便宜模型”的凭据，接手方有额度就一定能生成：
  - claude：`claude.exe -p --model haiku --tools "" --no-session-persistence`，prompt 走 stdin；
  - codex：`codex.js exec --ephemeral --skip-git-repo-check -s read-only -c model_reasoning_effort="low" -o <file> -`，会触发虾哥自己的 codex hooks（无害）；
  - agy：`agy.exe -p <prompt> --effort low --print-timeout 2m --disable-slash-commands`（不读 stdin）。
  - 超时 120 秒；失败或输出为空时用兜底卡片。
- **生成器的输入**：任务需求、最近的结果卡片、上一张交接卡片、反馈和转发记录、虾哥的补充说明，加上从旧会话 transcript（claude/codex 的 jsonl、agy 的 `transcript_full.jsonl`）摘录的对话。摘录保留第一条和最后一条需求，再从最近往前补，标出省略了多少条。整个 prompt 不超过 20000 字符。
- **不做能力分级**：三家接手的都是主力模型，卡片统一包含目标、已完成、正在做的、关键决策、踩过的坑、下一步、必须先读的文件、验收方法。
- **兜底卡片**：以“（自动整理失败……）”开头，内容是任务需求、最近的结果（6000 字以内）、最近 3 条反馈和对话摘录（12000 字以内），界面提示“已按记录摘录”。
- **新会话的第一条消息**：说明从谁手里接过来、为什么换（额度用完 / 虾哥决定换人），然后是交接卡片、虾哥的补充和旧 transcript 路径（让它按需去查，不要整份读）。超过 8000 字符时照常写进 prompt 文件。
- 同一任务同时只能有一个换 agent 请求（第二个返回 409）；生成期间任务被删除返回 404，不留下新会话。交接卡片存为 `kind: handoff`，`meta` 为 `{from, to, generated}`，在面板顶部显示成可展开的细条。

### 6.6 往会话里发指令（注入卡片、转发、反馈）

参考 Parallel Code 的 `writeAgentPrompt`：先用 bracketed paste 把整段内容贴进去，等一下再单独发一个回车。如果 agent 正在忙、虾哥有没发出去的草稿、或者虾哥最近 5 秒在打字，就先排队，过后再发。

M2 实现（`server/sessions.ts`）：
- 投递条件：状态为「需要你」至少 1.5 秒；没有权限提示；虾哥 5 秒内没在该会话打字；距上次投递至少 2 秒。每 250ms 检查一次。
- 粘贴：粘贴后 300ms 再单独发 `\r`。
- 换行：
  - 粘贴里不用 `\r`，因为 Codex 在粘贴里遇到 `\r` 也会提交。
  - claude、agy 用 `\n`。
  - codex 用 win32-input-mode 的 Ctrl+J 按键记录。原因：Windows 上的 Codex 读的是按键事件，`\n` 只在它的 ASCII 粘贴突发判断里才算换行，纯中文后面的 `\n` 会被丢掉。
  - CLI 没开 bracketed paste 时，换行压成空格。
- 未实现：「没发出去的草稿」检测，目前只判断 5 秒内有没有打字。

M3 转发（`POST /api/cards/:id/forward`）：结果卡片的「转发」可以发到另一个任务或新任务。发送的内容是附言（默认“下面是另一个任务的结果，供你参考。”）、来源标题行和卡片原文，弹窗里预览的就是最终文本。发到已有任务时走上面的排队投递，目标在忙就显示“消息排队中”；目标会话已退出时按反馈的规则续接，续接不了就提示转发到新任务。目标任务存一张 `kind: forward` 卡片，`meta` 记录来源任务和卡片；源任务的状态不变。

### 6.7 数据模型（草案）

- Project：id、name、path、color
- Task：id、projectId、title、prompt、color、status（running / needs_you / review / done / archived）、worktreePath?、createdAt
- Session：id、taskId、agent、nativeSessionId、mode（new / resume / handoff）、startedAt、endedAt、endReason
- Card：id、taskId、sessionId、kind（result / handoff / feedback / forward）、body、createdAt、meta?（handoff：from、to、generated；forward：sourceTaskId、sourceCardId）
- 会话运行时信息（M3）：transcriptPath（从 hook payload 取）、limit（message、resetsAt、at）
- Event：id、sessionId、source（hook / heuristic / user）、type、payload、at

## 7. 里程碑和验收标准

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 技术验证（已通过）** | 在网页里通过 node-pty 运行三家原生 CLI；每次启动时注入 hooks；测试中文输入法 | 三家 CLI 界面显示正常、中文能输入、Ctrl+C 有效；三家的“停下”事件都能准确送到服务端；能拿到三家的会话 ID；收集到额度用完时的输出样本。任何一项不通过，就先调整方案 |
| **M1 工作台骨架（已通过）** | 项目和任务列表、颜色区分、主区域、状态显示、``Alt+` `` | e2e 测试：用假 CLI 同时跑 6 个会话，状态正确；切换会话后输入一定进入当前显示的那个会话 |
| **M2 验收闭环（已通过）** | 结果卡片、「待验收」队列、反馈后开新会话或续接旧会话、持久化 | e2e 测试：做完进「待验收」→ 写反馈 → 开新会话收到卡片；重启工作台后能续接旧会话 |
| **M3 换 agent 和转发（已通过）** | 交接卡片、换 agent、转发 | e2e 测试：模拟额度用完 → 换 agent → 新会话收到交接卡片；转发的内容完整送达；目标会话正在忙时会排队 |
| M4 worktree | 可选开 worktree、确认弹窗、链接 node_modules、合并和清理 | 开之前一定弹窗确认；在 Windows 上链接 node_modules 不需要管理员权限（用 junction） |

每个里程碑都要保存测试工件（执行的命令、输入、日志、截图）到 `.tmp/<milestone>/`。

## 8. 风险

- **xterm.js 加 ConPTY 的显示和中文输入法**：M0 已验证通过。
- **Codex 的 hooks 需要虾哥信任一次**：只要还有未信任的 hook，每次启动都会弹审核框；工作台识别出来后交给虾哥处理。
- **agy 的 hook 路径不能含空格**：因为命令里不能加引号。目前的安装路径 `G:\Workspace\agent-workbench` 满足要求，启动时要检查一下。
- **Codex 和 agy 的额度耗尽样本缺失**：识别规则先只按 Claude 的写，其他两家等实际使用中采到样本再补。
- **CLI 升级后输出格式变化，导致终端分析失效**：所以以 hooks 为主，终端分析只作兜底。Codex 要关掉启动时的更新检查。

## 9. 参考

- DeepSeek super-agent 文章和原型：https://github.com/deepseek-ai/dsh-superagent-prototype
- Parallel Code（PTY、hooks、状态检测、发送指令的方式、worktree）：https://github.com/johannesjo/parallel-code
- T3 Code（交接预算算法、数据模型、手机端鉴权）：https://github.com/pingdotgg/t3code
- 源码快照：`.tmp/ref/`（只读参考，不运行）
