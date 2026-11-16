import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgyOptimizeStatus } from '../shared/protocol.ts';
import { ROOT } from './agents.ts';

const REQUIRED_FAST_TOOLS = ['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch'] as const;
const RULE_MARKER = '终端清爽排版规范';
const DEFAULT_SCHEMA = 'https://antigravity.google/schemas/v1/settings.json';
const DEFAULT_MODEL = 'Gemini 4 Carbon (Medium)';

const SHOAL_OUTPUT_STYLE_CONTENT = `---
trigger: always_on
---

# ${RULE_MARKER}（Shoal 一键优化）

1. **一屏控长与长文外置**：单次最终回复默认控制在一屏以内（3–5 行核心结论 + 紧凑表格或短列表，单条 \`<= 2\` 行，区块间留空行）；超过一屏的深度分析或长方案写入项目 \`.md\` 或 Artifact，聊天框只给结论与底部文件入口。
2. **严控反引号灰底块**：正文中禁止对普通日期、纯数字、百分比、状态词或普通英文专有名词滥用行内反引号；行内反引号仅限真实命令、配置键名、commit hash 或代码标识符，单段不超过 3 处。
3. **中文加粗防破损**：\`**加粗**\` 内部严禁包含全角括号 \`（）\`、引号 \`“”\` 或书名号（防 CommonMark 右侧边界判定失效在终端裸露 \`**\`；改为 \`**方案 A**（说明）\` 或两侧留半角空格）。
4. **本地文件链接集中置底**：严禁在正文句子中间穿插 \`file:///\` 链接（防 TUI 展开长路径蓝字下划线打断阅读）；正文只提简短文件名，完整绝对可点击 \`file:///\` 链接统一收纳在回复最底部的“相关文件”短列表中。
5. **阶段心跳与中文摘要**：面向用户的工具参数（如 \`toolSummary\`）使用简短中文；连续执行多步工具时，每 4–5 个工具批次或切换阶段，在发起 \`tool_calls\` 的同一轮 \`content\` 中附带 1 行 \`<= 40\` 字中文进展播报，严禁连续十余轮零文本静默执行。
`;

export class AgyOptimizeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function agyHomeDir(): string {
  if (process.env.AGY_HOME_DIR) return path.resolve(process.env.AGY_HOME_DIR);
  if (process.env.AGY_CONFIG_DIR) return path.dirname(path.resolve(process.env.AGY_CONFIG_DIR));
  return path.join(os.homedir(), '.gemini');
}

export function agyCliDir(): string {
  if (process.env.AGY_CONFIG_DIR) return path.resolve(process.env.AGY_CONFIG_DIR);
  return path.join(agyHomeDir(), 'antigravity-cli');
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function readJsonSafe(filePath: string): { exists: boolean; ok: boolean; data?: JsonObject } {
  if (!fs.existsSync(filePath)) return { exists: false, ok: true, data: {} };
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    if (!raw.trim()) return { exists: true, ok: true, data: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { exists: true, ok: false };
    return { exists: true, ok: true, data: parsed };
  } catch {
    return { exists: true, ok: false };
  }
}

function readJsonStrict(filePath: string, label: string): { exists: boolean; data: JsonObject } {
  const res = readJsonSafe(filePath);
  if (!res.ok) {
    throw new AgyOptimizeError(400, `${label} JSON 格式损坏，已中止修改以保护原配置`);
  }
  return { exists: res.exists, data: res.data ?? {} };
}

function ensureBackup(filePath: string, backupsCreated: string[]): void {
  if (!fs.existsSync(filePath)) return;
  const bakPath = `${filePath}.shoal.bak`;
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(filePath, bakPath);
    backupsCreated.push(bakPath);
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(filePath: string, obj: JsonObject): void {
  writeFileAtomic(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

function detectNodeCommand(): string {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return 'node';
    } catch { /* ignore */ }
  }
  return process.execPath.replaceAll('\\', '/');
}

function checkCliSettings(settingsPath: string): AgyOptimizeStatus['cliSettings'] {
  const res = readJsonSafe(settingsPath);
  if (!res.exists || !res.ok || !res.data) {
    return { optimized: false, path: settingsPath };
  }
  const verbosity = typeof res.data.verbosity === 'string' ? res.data.verbosity : undefined;
  const colorScheme = typeof res.data.colorScheme === 'string' ? res.data.colorScheme : undefined;
  const optimized = verbosity === 'low' && typeof colorScheme === 'string' && colorScheme.toLowerCase() === 'tokyo night';
  return {
    optimized,
    path: settingsPath,
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(colorScheme !== undefined ? { colorScheme } : {}),
  };
}

function hasRuleFileContent(content: string): boolean {
  return /trigger:\s*always_on/i.test(content) && content.includes(RULE_MARKER);
}

function checkOutputRule(home: string): AgyOptimizeStatus['outputRule'] {
  const rulePath = path.join(home, 'config', 'rules', 'shoal-output-style.md');
  const geminiMdPath = path.join(home, 'GEMINI.md');

  try {
    if (fs.existsSync(rulePath)) {
      const content = stripBom(fs.readFileSync(rulePath, 'utf8'));
      if (hasRuleFileContent(content)) {
        return { optimized: true, source: 'rule_file', path: rulePath };
      }
    }
  } catch { /* ignore */ }

  try {
    if (fs.existsSync(geminiMdPath)) {
      const content = stripBom(fs.readFileSync(geminiMdPath, 'utf8'));
      if (content.includes(RULE_MARKER)) {
        return { optimized: true, source: 'gemini_md', path: geminiMdPath };
      }
    }
  } catch { /* ignore */ }

  return { optimized: false, source: 'none', path: rulePath };
}

function hasValidFastToolsTarget(entry: JsonObject): { valid: boolean; scriptPath?: string } {
  const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : '';
  if (url) return { valid: true };
  const cmd = typeof entry.command === 'string' && entry.command.trim() ? entry.command.trim() : '';
  const args = Array.isArray(entry.args) ? entry.args : [];
  const firstArg = typeof args[0] === 'string' && args[0].trim() ? args[0].trim() : '';
  if (cmd && firstArg) {
    try {
      if (fs.existsSync(firstArg) && fs.statSync(firstArg).isFile()) {
        return { valid: true, scriptPath: firstArg };
      }
    } catch { /* ignore */ }
  }
  return { valid: false, ...(firstArg ? { scriptPath: firstArg } : {}) };
}

function checkFastToolsMcp(mcpPath: string): AgyOptimizeStatus['fastToolsMcp'] {
  const res = readJsonSafe(mcpPath);
  if (!res.exists || !res.ok || !res.data) {
    return { optimized: false, path: mcpPath };
  }
  const servers = isPlainObject(res.data.mcpServers) ? res.data.mcpServers : null;
  const entry = servers && isPlainObject(servers['fast-tools']) ? servers['fast-tools'] : null;
  if (!entry) return { optimized: false, path: mcpPath };

  const target = hasValidFastToolsTarget(entry);
  const tools = isPlainObject(entry.tools) ? entry.tools : null;
  const allEager = tools !== null && REQUIRED_FAST_TOOLS.every((name) => {
    const t = tools[name];
    return isPlainObject(t) && t.eager === true;
  });

  return {
    optimized: target.valid && allEager,
    path: mcpPath,
    ...(target.scriptPath ? { scriptPath: target.scriptPath } : {}),
  };
}

function buildStatus(
  cliSettings: AgyOptimizeStatus['cliSettings'],
  outputRule: AgyOptimizeStatus['outputRule'],
  fastToolsMcp: AgyOptimizeStatus['fastToolsMcp'],
  appliedChanges?: string[],
  backupsCreated?: string[],
): AgyOptimizeStatus {
  return {
    optimized: cliSettings.optimized && outputRule.optimized && fastToolsMcp.optimized,
    cliSettings,
    outputRule,
    fastToolsMcp,
    ...(appliedChanges ? { appliedChanges } : {}),
    ...(backupsCreated ? { backupsCreated } : {}),
  };
}

export function getAgyOptimizeStatus(): AgyOptimizeStatus {
  const home = agyHomeDir();
  const cliDir = agyCliDir();
  return buildStatus(
    checkCliSettings(path.join(cliDir, 'settings.json')),
    checkOutputRule(home),
    checkFastToolsMcp(path.join(home, 'config', 'mcp_config.json')),
  );
}

export function applyAgyOptimization(): AgyOptimizeStatus {
  const home = agyHomeDir();
  const cliDir = agyCliDir();
  const settingsPath = path.join(cliDir, 'settings.json');
  const mcpPath = path.join(home, 'config', 'mcp_config.json');
  const rulePath = path.join(home, 'config', 'rules', 'shoal-output-style.md');
  const geminiMdPath = path.join(home, 'GEMINI.md');

  // Validate both JSON files before making any disk changes so corrupt config aborts atomically.
  const settingsRead = readJsonStrict(settingsPath, 'settings.json');
  const mcpRead = readJsonStrict(mcpPath, 'mcp_config.json');

  const appliedChanges: string[] = [];
  const backupsCreated: string[] = [];

  // 1. CLI settings.json
  const currentSettings = settingsRead.data;
  const currentCliStatus = checkCliSettings(settingsPath);
  if (!currentCliStatus.optimized) {
    ensureBackup(settingsPath, backupsCreated);
    const nextSettings: JsonObject = {
      ...currentSettings,
      $schema: typeof currentSettings.$schema === 'string' && currentSettings.$schema.trim()
        ? currentSettings.$schema
        : DEFAULT_SCHEMA,
      verbosity: 'low',
      colorScheme: 'tokyo night',
    };
    if (typeof currentSettings.model !== 'string' || !currentSettings.model.trim()) {
      nextSettings.model = DEFAULT_MODEL;
    }
    writeJsonAtomic(settingsPath, nextSettings);
    appliedChanges.push('cliSettings');
  }

  // 2. Output style rule (never touch GEMINI.md; reuse if it already contains the marker and rule file is absent)
  let geminiHasRule = false;
  try {
    if (fs.existsSync(geminiMdPath)) {
      geminiHasRule = stripBom(fs.readFileSync(geminiMdPath, 'utf8')).includes(RULE_MARKER);
    }
  } catch { /* ignore */ }

  const ruleExists = fs.existsSync(rulePath);
  if (!(geminiHasRule && !ruleExists)) {
    let alreadyGood = false;
    if (ruleExists) {
      try {
        alreadyGood = hasRuleFileContent(stripBom(fs.readFileSync(rulePath, 'utf8')));
      } catch { /* ignore */ }
    }
    if (!alreadyGood) {
      ensureBackup(rulePath, backupsCreated);
      writeFileAtomic(rulePath, SHOAL_OUTPUT_STYLE_CONTENT);
      appliedChanges.push('outputRule');
    }
  }

  // 3. fast-tools Eager MCP
  const currentMcpStatus = checkFastToolsMcp(mcpPath);
  if (!currentMcpStatus.optimized) {
    ensureBackup(mcpPath, backupsCreated);
    const nextMcp: JsonObject = { ...mcpRead.data };
    const prevServers = isPlainObject(mcpRead.data.mcpServers) ? mcpRead.data.mcpServers : {};
    const prevFastTools = isPlainObject(prevServers['fast-tools']) ? prevServers['fast-tools'] : {};

    const target = hasValidFastToolsTarget(prevFastTools);
    const prevTools = isPlainObject(prevFastTools.tools) ? prevFastTools.tools : {};
    const nextTools: JsonObject = { ...prevTools };
    for (const toolName of REQUIRED_FAST_TOOLS) {
      const existingTool = isPlainObject(nextTools[toolName]) ? nextTools[toolName] : {};
      nextTools[toolName] = { ...existingTool, eager: true };
    }

    let nextFastTools: JsonObject;
    if (target.valid) {
      nextFastTools = {
        ...prevFastTools,
        tools: nextTools,
      };
    } else {
      const srcScript = path.join(ROOT, 'hooks', 'fast-tools.mjs');
      const destScript = path.join(home, 'config', 'mcp-servers', 'shoal-fast-tools', 'index.mjs');
      fs.mkdirSync(path.dirname(destScript), { recursive: true });
      fs.copyFileSync(srcScript, destScript);

      nextFastTools = {
        ...prevFastTools,
        command: detectNodeCommand(),
        args: [destScript.replaceAll('\\', '/')],
        tools: nextTools,
      };
    }

    nextMcp.mcpServers = {
      ...prevServers,
      'fast-tools': nextFastTools,
    };
    writeJsonAtomic(mcpPath, nextMcp);
    appliedChanges.push('fastToolsMcp');
  }

  return buildStatus(
    checkCliSettings(settingsPath),
    checkOutputRule(home),
    checkFastToolsMcp(mcpPath),
    appliedChanges,
    backupsCreated,
  );
}
