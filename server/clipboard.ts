import { execFile } from 'node:child_process';

// Files copied in Explorer (a file drop list on the system clipboard). The browser's paste event carries them without
// their paths, so the page asks the server, which runs on the same machine and shares the clipboard.
const SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';

export function clipboardFiles(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(new Error(`读取剪贴板失败：${err.message}`));
      else resolve(stdout.split(/\r?\n/).filter(Boolean));
    });
  });
}
