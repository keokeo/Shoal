# Antigravity CLI（`agy`）输出与排版优化指南

默认配置下的 Antigravity CLI（`agy`）在长任务或 Windows 终端（ConPTY / xterm.js）中容易出现四类体验问题：

1. **工具命令刷屏**：默认 `verbosity: "medium"` 会把每次 `run_command` 展开为 `Ran (node -e ...)` 或冗长的 PowerShell 管道；加上 `agy` 从默认基线移除了 `grep_search` / `find_by_name` / `list_dir`，模型常手写内联脚本查文件，导致屏幕被代码碎片占满。
2. **TUI Markdown 渲染破损**：
   - 模型习惯给日期、数字、百分比、普通英文词加行内反引号，在终端里变成满屏碎灰底色块；
   - `**中文（含全角括号或引号）**` 会触发 CommonMark 右侧边界判定失效，在终端直接裸露 `**`；
   - 正文句子中间穿插 `[文件名](file:///...)` 时，`agy` TUI 会忽略短标题并把完整 `file:///C:/...` 展开成超长蓝字下划线，打断整段阅读；
   - 单次回复动辄数百行，把核心结论淹没在滚屏里。
3. **“Thought for 20m 32s” 静默黑盒**：当系统规则同时要求“不输出完整推理”与“持续执行到完成”时，模型会在连续几十轮工具调用期间只发 `tool_calls` 不发文本，`agy` 将整段墙钟耗时折叠成单行 `Thought for 20m+`，用户无法判断是在干活还是卡死。
4. **Windows ConPTY 挤压闪烁**：在多面板工作台中，若状态条或确认卡片用 Flex 流动态改变终端容器高度，会触发 `FitAddon` 与 ConPTY 全屏重绘清屏。

下面整理我们在实战中验证有效的五层优化方案。如果你使用 **Shoal**，可以直接在 **设置 → Antigravity CLI 输出与排版优化 → 一键优化 → 确定** 一键完成配置（自动备份原文件并无损保留已有模型、权限与 MCP 配置）。

---

## 一键优化（Shoal 内置）

1. 打开 Shoal 右上角 **设置**（滑块图标）。
2. 找到 **Antigravity CLI 输出与排版优化** 卡片，点击 **一键优化**，确认提示后点击 **确定**。
3. Shoal 会自动备份原配置（生成 `.shoal.bak`），并无损写入以下三项全局优化（新开或重连的 `agy` 会话立即生效）：
   - 更新 `~/.gemini/antigravity-cli/settings.json` 中的 `verbosity` 与 `colorScheme`；
   - 写入全局常驻规则 `~/.gemini/config/rules/shoal-output-style.md`（若 `~/.gemini/GEMINI.md` 已含同名排版规范则自动复用，不重复注入）；
   - 部署零依赖只读检索服务 `~/.gemini/config/mcp-servers/shoal-fast-tools/index.mjs` 并注册到 `~/.gemini/config/mcp_config.json`。

---

## 手动配置方法（五层拆解）

### 1. CLI 原生配置降噪与配色（`settings.json`）

编辑 `~/.gemini/antigravity-cli/settings.json`，将 `verbosity` 设为 `"low"` 折叠连续工具输出（需要看详情时在 TUI 内按 `Ctrl+O` 展开），并将默认生硬的 `"dark"` 配色切换为层次更柔和的 `"tokyo night"`：

```json
{
  "$schema": "https://antigravity.google/schemas/v1/settings.json",
  "colorScheme": "tokyo night",
  "verbosity": "low",
  "model": "Gemini 4 Carbon (Medium)"
}
```

- **模型建议**：日常多轮交互固定单模型（如 `Gemini 4 Carbon (Medium)`）可维持 `92%+` 隐式前缀缓存命中率，避免每轮跨模型切换清零缓存。

### 2. 终端清爽排版规则（修复 TUI 渲染痛点）

新建 `~/.gemini/config/rules/shoal-output-style.md`（使用 `trigger: always_on` 让所有会话自动加载，且不侵入主 `GEMINI.md`）：

```markdown
---
trigger: always_on
---

# Antigravity CLI 终端清爽排版与进展播报规范

- **一屏控长与长文外置**：单次最终回复默认控制在一屏以内（3–5 行核心结论 + 紧凑 Markdown 表格或短列表，单条列表 <= 2 行，区块间留空行）；超过一屏的深度复盘、多方案对比或排查细节写入项目 `.md` 报告或 Artifact，聊天框只给结论与底部文件入口。
- **严控反引号灰底块**：正文中禁止对普通日期、纯数字、百分比、状态词或普通英文专有名词滥用行内反引号；行内反引号仅限真实命令、配置键名、commit hash 或代码标识符，单段不超过 3 处。
- **中文加粗防破损**：`**加粗**` 内部严禁包含全角括号 `（）`、引号 `“”` 或书名号（防 CommonMark 右侧边界判定失效在终端裸露 `**`；写成 `**方案 A**（说明）` 或在加粗两侧留半角空格）。
- **本地文件链接集中置底**：因 `agy` TUI 会将 `file:///...` 强制展开为长路径蓝字下划线，严禁在正文句子中间穿插 `file:///` 链接；正文只提简短文件名，完整绝对可点击 `file:///` 链接统一收纳在回复最底部的“相关文件”短列表中。
- **阶段心跳与中文摘要**：面向用户的工具参数（如 `toolSummary`）统一使用简短中文；执行多步工具任务时，每连续执行 4–5 个工具批次或切换阶段，必须在发起 `tool_calls` 的同一轮 `content` 中附带 1 行 <= 40 字的中文进展播报（严禁单独空转一轮只发进度，也严禁连续十余轮零文本静默执行）。
```

### 3. 阶段心跳纪律（消除 20 分钟零输出静默）

`agy` 的思考折叠器（`coalesceThinkingSteps`）会把没有正文输出的多轮工具调用合并计时。通过在规则中要求：
- 每次工具调用填写中文 `toolSummary`；
- 每 4–5 个工具批次在**发起 `tool_calls` 的同一轮**顺带输出 1 行 `<= 40` 字中文进展；

既不会额外多花一轮 API 请求，也不会破坏前缀缓存，同时让终端每隔半分钟就有清晰的阶段落点。

### 4. 挂载零依赖 `fast-tools` Eager MCP（告别 `node -e` 与 PowerShell 刷屏）

在 Windows 上，`pwsh.exe` 单次冷启动中位数约 `262ms`，而 `rg` 全仓检索仅需 `9–20ms`。通过 `~/.gemini/config/mcp_config.json` 挂载零依赖只读 Stdio MCP（暴露 `fast_search`、`fast_glob`、`fast_tree`、`read_files_batch` 四个 `eager: true` 工具，仓库内置脚本位于 `hooks/fast-tools.mjs`）：

```json
{
  "mcpServers": {
    "fast-tools": {
      "command": "node",
      "args": ["~/.gemini/config/mcp-servers/shoal-fast-tools/index.mjs"],
      "tools": {
        "fast_search": { "eager": true },
        "fast_glob": { "eager": true },
        "fast_tree": { "eager": true },
        "read_files_batch": { "eager": true }
      }
    }
  }
}
```

> 注意：`~/.gemini/config/mcp_config.json` 的 `args` 请填写展开后的绝对路径（`agy` 的 MCP JSON 配置不展开 `~`）。Shoal 的「一键优化」会自动写入当前系统的真实绝对路径。

挂载后，模型直接并发调用语义化只读工具（5 个文件切片 1 轮读完），终端不再滚屏打印内联脚本。

### 5. 工作台侧零闪烁 HUD 浮层（Shoal 内置）

在 Shoal 面板中，服务端直接增量解析 `transcript.jsonl`（自动解包二次 JSON 转义的 `toolSummary` 与读写文件列表），前端通过 `position: absolute` 的半透明 `<ActivityHud />` 浮层展示实时中文动作与秒表，点击改动文件可直跳右侧 Diff 面板，全程 `0` 次 PTY resize，彻底根除 Windows ConPTY 黑屏重绘闪烁。
