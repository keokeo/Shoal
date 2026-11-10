# Shoal

[English](README.md) | 简体中文

本机多 agent 工作台：在一个网页（或 Tauri 桌面端）里同时管理 Claude Code、Codex、agy 的原生交互式会话（node-pty + ConPTY），用颜色区分任务，用 hooks 判断每个会话是在工作还是在等你。需求与方案见 [docs/v1-spec.md](docs/v1-spec.md)（[English](docs/v1-spec.en.md)）。

> [!WARNING]
> 三家 CLI 都以完全权限启动（跳过审批，codex 关闭沙箱），agent 可以直接改文件、跑命令。只在你信任的项目目录里使用，详见下文「权限」。

当前进度：M3（换 agent 和转发）。agent 每轮做完，最后一条回复成为结果卡片，任务进入「待验收」；可以写反馈让它继续，或者通过。额度用完或想换人时，可以把任务交给另一家 CLI，接手方会收到自动整理的交接卡片；结果卡片可以转发给别的任务。项目、任务、会话和卡片持久化在 `<stateDir>/state.json`；重启服务后旧任务显示「已退出」，可手动续接。

## 运行

要求：Windows，Node 24（直接运行 `.ts`），已安装并登录要用的 CLI；工作台路径不能含空格（agy 的 hook 命令不能加引号）。

```sh
npm install
npm run build
npm start            # 打开 http://127.0.0.1:47800
```

一键启动 / 停止：双击项目根目录的 `start.cmd`、`stop.cmd`，或在 PowerShell 里运行：

```powershell
scripts\workbench.ps1 start|stop|restart|status [-Port <n>] [-Force] [-NoBrowser]
```

- `start`：缺 `node_modules` 时先 `npm install`，前端源码比 `web/dist` 新时先构建，然后在独立的隐藏控制台后台启动服务，就绪后打开浏览器（`-NoBrowser` 不打开）。已在运行时只报告，不重启。关掉启动用的窗口不影响服务。
- `stop`：连同服务启动的 agent 进程一起结束。还有 agent 会话在运行时先确认（`-Force` 跳过），之后可在面板里续接。
- `status`：显示 PID、启动时间和在运行的会话数；未运行时退出码 3。
- 日志：`<stateDir>\server.log`、`server.err.log`。端口被别的程序占用时会报出占用者。

桌面端（Tauri 2 薄壳，`desktop/`）：在 WebView2 窗口里打开工作台，服务仍由系统 Node 运行。

```sh
npm run desktop:build   # 需要 Rust；产出 desktop\src-tauri\target\release\bundle\nsis\Shoal_<版本>_x64-setup.exe
```

- 启动时服务没在运行就调用 `workbench.ps1 start -NoBrowser` 拉起来（失败时窗口里显示原因和「重试」），已在运行就直接连上。端口同样读 `WORKBENCH_PORT`。
- 关窗口或托盘「退出」会连服务一起停掉（不管服务是外壳还是 `start` 拉起的）；还有 agent 在跑时先弹确认，「全部退出」走和服务端 `Ctrl+C` 相同的流程，之后可在面板里续接。外壳崩溃或被强杀时服务和 agent 继续运行。托盘菜单另有显示、在浏览器中打开、重新加载。再次启动会唤出已有窗口。
- `Ctrl+W`、`Ctrl+F`、`Ctrl+R`、`F5`、`Ctrl+P` 等交给页面和终端，不再被浏览器拦截；刷新用托盘的「重新加载」。终端里的网页链接用默认浏览器打开。
- 外壳从哪个仓库构建，就启动哪个仓库的 `scripts\workbench.ps1`（编译时写入；可用 `WORKBENCH_ROOT` 覆盖）。缩放、折叠、隐私模式等存在浏览器本地的设置与 Chrome 里的不共享。

- `--port <n>` 或 `WORKBENCH_PORT` 改端口；`WORKBENCH_STATE_DIR` 改状态目录（默认 `%LOCALAPPDATA%\Shoal`；该目录不存在而改名前的 `%LOCALAPPDATA%\agent-workbench` 存在时，沿用旧目录；里面有 hook 配置和 `events.jsonl`）。
- 服务只监听 `127.0.0.1`，校验 Host 和 Origin；hook 回调用每次启动随机生成的 token。
- 开发前端：用 `npm start` 跑服务端（不要用 `node --watch`，重启会杀掉所有在跑的 agent），`WORKBENCH_DEV=1` 时允许 `npm run dev:web`（Vite，5173 端口）。
- 项目、任务和会话元数据写入 `<stateDir>/state.json`；服务重启后旧任务显示「已退出」，不会自动续接（避免一次性消耗额度）。文件损坏时会改名为 `state.json.corrupt-<时间戳>` 并从空状态启动。

## 使用

- 「新建项目」填名称和已存在的目录（也可点「浏览…」在本机目录里选）。
- 移除项目：悬停项目名，点 `+` 左边的垃圾桶。确认后项目和它的全部任务（含已归档）从工作台移除，在跑的会话被结束；项目目录、CLI 对话记录和 Token 统计不删（统计里标「已删除」）。工作台里的任务和结果卡片不能恢复，可以用「新建项目」重新添加同一目录。
- 新建任务有三种方式：
  - 项目右边的 `+`：选 agent 直接启动，不弹窗；上次在该项目用的 agent 排第一。
  - `Alt+N`：在当前聚焦会话所在的项目里，用上次的 agent 立即新建。
  - 侧栏顶部「新建任务」：完整对话框，可选项目、agent、写初始需求。
- 标题：不填时，带需求则取需求第一行；不带需求则先叫「新任务 N」，你在终端里发出的第一句话（`/` 开头的命令除外）会自动成为标题。点任务行（悬停时出现）或面板标题旁的铅笔按钮改名，也可以双击标题（Enter 保存，Esc 取消），手动改过的标题不会再被自动替换。
- 贴图：`Ctrl+V` 或 `Alt+V` 粘贴剪贴板里的图片（交给 CLI 自己读系统剪贴板）；在资源管理器里复制的文件（视频、文档等）用 `Ctrl+V` 粘贴时插入它们的完整路径，含空格的加引号，多个用空格分隔（同 Windows Terminal）；拖入图片文件会保存到 `<state 目录>\attachments\` 并把路径粘贴进去（claude、codex 会识别为图片附件，agy 只收到路径文字）。Claude Code 的贴图键是 `chat:imagePaste`（默认 `alt+v`），改过绑定的话粘贴图片会失效。
- 终端里的链接：文件链接点击后用 VS Code 打开（带行号的会定位到该行，图片、PDF、网页用默认程序，程序和快捷方式只在资源管理器里选中，不会运行），网页链接在新标签页打开。可用环境变量 `WORKBENCH_EDITOR` 指定编辑器 exe。
- 选中即复制：在终端里拖选、双击选词或三击选行，松开鼠标就复制到系统剪贴板（同 Windows Terminal 的 copyOnSelect）；单击不复制。CLI 开了鼠标模式时按住 `Shift` 再拖选；不按 `Shift` 时由 CLI 自己选中，它通过 OSC 52 交来的文字同样会写进剪贴板。
- 鼠标点选：Claude Code 的全屏模式（`/tui fullscreen`，或 settings 里 `"tui": "fullscreen"`）会开鼠标模式，选项菜单可以直接点，滚轮也交给它处理。Claude 会把“全屏启动后 10 秒内进程就消失”当作一次崩溃，累计两次后该版本自动退出全屏（`~/.claude.json` 里出现 `fullscreenAutoDisabled`），之后点击就失效了，在 Claude 里运行一次 `/tui fullscreen` 即可恢复。工作台删除或归档刚启动的 Claude 任务、正常停止服务时，会等它满 10 秒再结束进程；但 `stop`/`restart` 是强杀，刚启动的 Claude 照样会被记一次。
- 点项目名折叠或展开；折叠状态保存在本机浏览器。折叠后如果组里有任务在等你，项目名旁会显示数量；用 ``Alt+` `` 跳过去时会自动展开。
- 拖动项目名（整行）可以调整项目在侧栏里的顺序，鼠标在目标行上半部放前面、下半部放后面；顺序保存在本机浏览器，新建的项目排在最后。
- 隐私模式：顶栏「隐私」按钮给项目名、任务标题、路径和验收摘要打码（终端除外），原本带这些内容的悬停提示也不再显示，方便截图分享；设置保存在本机浏览器。
- 双屏时窗格标题的文件夹标签显示该屏的项目，侧栏里正在显示的任务右侧标「左」或「右」；把任务行拖到某一屏上，就直接在那一屏打开（拖到另一屏正在显示的任务会两屏互换）。
- 每个任务前是对应 CLI 的图标（Claude Code / Codex / Antigravity），图标保留品牌色，图标左侧的细色条是任务色。图标来自 [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons)（MIT）。
- 缩放：顶栏右侧的 `−` / `+` 整体缩放界面和终端字号（80%–150%，每次 5%），也可以在上面滚动滚轮；点百分比数字恢复 100%。设置保存在本机浏览器。
- Token 统计：顶栏的「Token 统计」页签（「工作台」页签切回，终端不会断开）。数据来自三家 CLI 自己的对话记录，只统计工作台启动的会话，每小时汇总存进 `<stateDir>/usage.json`，删除任务后仍保留。
  - 时间：今天 / 近 7 天（默认）/ 近 30 天 / 全部 / 自定义日期（按本地时间，含结束日）。
  - 总量、输入、输出（含推理）、缓存读取、缓存写入、缓存命中率、请求数；趋势图按小时（2 天以内）或按天堆叠显示，悬停看精确数字。
  - 明细按任务、模型、厂商、agent、项目分组；已删除的任务标「已删除」。
  - 命中率 = 缓存读取 ÷（输入 + 缓存读取 + 缓存写入）。Claude 同一条消息只算一次。
  - 页签打开时每 10 秒刷新。不计入：换 agent 时的 headless 交接调用、Claude 内部的辅助小模型调用、Codex hook 未信任期间的会话。
- 键盘输入只进入当前聚焦面板对应的会话；点侧栏的任务切换。
- 归档：悬停任务行点 `×`，结束它的会话进程并移到项目下的「已归档」里（点它展开）；agent 还在工作时先确认。已归档任务旁的「恢复」把任务移回列表，再点「续接」打开原对话。已归档任务上的 `×` 是永久删除（删掉任务和卡片，先确认）。
- 续接：已退出的任务在侧栏显示「续接」，面板底部有「续接上次会话」和「新开会话」。续接用原 CLI 的恢复命令打开上次的对话（claude `--resume`、codex `resume`、agy `--conversation`），会话 ID 不变，在原面板打开；在 CLI 里用 `/resume` 切换过对话，续接会打开切换后的那段对话；上次没有对话记录（没发过消息）时面板只能新开，侧栏「续接」会先询问是否新开会话（新开会替换旧会话的终端内容），取消则保持原样。旧会话的终端内容由新会话替换。
- 「单屏 / 双屏」切换；双屏时点侧栏会替换当前聚焦的面板（顶部有任务色细线）。
- ``Alt+` `` 跳到等你最久的会话（Chrome 不把 `Ctrl+Tab` 交给网页）。
- 权限：三家 CLI 一律以完全权限启动（新建和续接都是），不再弹审批：claude `--dangerously-skip-permissions`、codex `--dangerously-bypass-approvals-and-sandbox`（同时关闭沙箱）、agy `--dangerously-skip-permissions`。agent 可以直接改文件、跑命令，只在信任的项目目录里用。
- 状态：启动中 / 工作中 / 需要你（琥珀色，显示已等多久）/ 待验收 / 已通过 / 已退出。Codex 首次启动如果提示 “Hooks need review”，在终端里按提示信任一次。
- 待验收：agent 一轮结束（Stop hook），它最后一条回复就成为结果卡片，任务进入「待验收」，顶栏「待验收」计数加一，点它跳到等验收最久的任务。面板底部显示卡片摘要，可以「展开」看全文。你在终端里继续对话，任务会回到进行中，下一轮结束后再生成新卡片。
  - 「通过」：任务离开「待验收」，留在列表里显示「已通过」，也不计入「需要你」；在终端里继续对话会回到进行中。通过不会归档。
  - 「写反馈」后有两种发法：
    - 「新会话继续」（`Ctrl+Enter`）：在原面板开一个新会话，初始需求包括原任务需求、上一轮结果和你的反馈。
    - 「发到原会话」：把反馈整段贴进原会话，多行反馈作为一条消息发出。agent 正在工作、有权限提示、你 5 秒内在这个会话里打过字，或者一轮刚结束不到 1.5 秒时，反馈先排队（面板显示「消息排队中」），条件满足后自动发送。原会话已退出时，工作台先续接再发；没有对话记录的会话只能新会话继续。
- 额度用完：claude 报额度用完（rate limit / billing，或回复 “You've hit your … limit”）时，这一轮不生成结果卡片，面板顶部出现额度横条，侧栏显示「额度用完」。codex 和 agy 还没有额度用完的样本，不会自动识别，需要时手动换 agent。
- 换 agent：面板标题栏的「换 agent」或额度横条上的按钮。选接手的 CLI，可写补充说明，提交（`Ctrl+Enter`）后工作台用接手的 CLI 跑一次 headless 短调用（几秒到二十几秒，会用少量额度），读任务需求、结果和反馈卡片、旧会话的对话记录，写出交接卡片；然后在原面板用新 CLI 开新会话，第一条消息是交接卡片、你的补充和旧对话记录的路径。生成失败时改用按记录摘录的兜底卡片，并提示“已按记录摘录”。面板顶部的「交接」细条可以展开看卡片。
- 转发：「待验收」栏的「转发」把这张结果卡片发给另一个任务或新建的任务。弹窗里可以写附言（不写就用默认附言），并预览将发送的完整内容。发给已有任务时和「发到原会话」一样排队投递：目标还在工作时，顶部提示“消息排队中”，侧栏该任务显示「排队」，直到发出；目标会话已退出时先续接，续接不了会提示改为转发到新任务。转发不改变源任务的状态。

## 测试

```sh
npm run typecheck
npm test                                                    # vitest 单测
npm run e2e                                                 # 假 CLI 的 e2e，工件在 .tmp/m1/、.tmp/m2/、.tmp/m3/、.tmp/ui-redesign/ 和 .tmp/token-stats/
npx vite build; if ($?) { npx playwright test -c e2e-real/playwright.real.config.ts }   # 真实 CLI 冒烟，会用少量额度，工件在 .tmp/m2/real/
npx vite build; if ($?) { npx playwright test -c e2e-real/playwright.handoff.config.ts }   # 真实 CLI 换 agent（claude→codex→agy→claude），工件在 .tmp/m3/real/
```

e2e 用 `test/fixtures/fake-agent.mjs` 模拟交互式 CLI（需要 `WORKBENCH_FAKE_AGENT=1`，playwright 配置里已设置），Playwright 用本机 Chrome（`channel: 'chrome'`）。

## 许可

[MIT](LICENSE)。Claude Code、Codex、Antigravity 分别是 Anthropic、OpenAI、Google 的产品，本项目与它们没有关联。
