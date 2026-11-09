import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findEditor, OpenError, openAction, resolveOpenTarget, runOpen } from './open.ts';

let dir: string;
let ts: string; // <dir>\带 空格 中文.ts
let plain: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-open-'));
  ts = path.join(dir, '带 空格 中文.ts');
  plain = path.join(dir, 'a.ts');
  fs.writeFileSync(ts, 'x');
  fs.writeFileSync(plain, 'x');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fail = (target: string): OpenError => {
  try {
    resolveOpenTarget(target);
  } catch (e) {
    expect(e).toBeInstanceOf(OpenError);
    return e as OpenError;
  }
  throw new Error(`expected ${target} to be rejected`);
};

describe('resolveOpenTarget', () => {
  it('resolves a file URI, decoding percent-encoded Chinese and spaces', () => {
    const uri = pathToFileURL(ts).href;
    expect(uri).toContain('%');
    expect(resolveOpenTarget(uri)).toEqual({ path: ts });
  });

  it('accepts file://localhost/ and a bare path with either slash', () => {
    expect(resolveOpenTarget(pathToFileURL(plain).href.replace('file:///', 'file://localhost/'))).toEqual({ path: plain });
    expect(resolveOpenTarget(plain)).toEqual({ path: plain });
    expect(resolveOpenTarget(plain.replaceAll('\\', '/'))).toEqual({ path: plain });
  });

  it('takes line and column from a fragment, a colon suffix, or a hash suffix when the full path does not exist', () => {
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}#L12`)).toEqual({ path: plain, line: 12 });
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}#L12C3`)).toEqual({ path: plain, line: 12, col: 3 });
    expect(resolveOpenTarget(`${plain}:12`)).toEqual({ path: plain, line: 12 });
    expect(resolveOpenTarget(`${plain}:12:3`)).toEqual({ path: plain, line: 12, col: 3 });
    expect(resolveOpenTarget(`${plain}#L7C2`)).toEqual({ path: plain, line: 7, col: 2 });
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}:12:3`)).toEqual({ path: plain, line: 12, col: 3 });
  });

  it('prefers the full path over stripping a suffix when it exists', () => {
    const odd = path.join(dir, 'odd#L5');
    fs.writeFileSync(odd, 'x');
    expect(resolveOpenTarget(odd)).toEqual({ path: odd });
  });

  it('resolves a directory', () => {
    expect(resolveOpenTarget(dir)).toEqual({ path: dir });
  });

  it('404s on a missing file, naming the path', () => {
    const missing = path.join(dir, 'nope.ts');
    const e = fail(missing);
    expect(e.status).toBe(404);
    expect(e.message).toBe(`文件不存在：${missing}`);
    expect(fail(`${missing}:3`).status).toBe(404);
  });

  it('400s on UNC, remote host, relative paths, other schemes and junk', () => {
    expect(fail('\\\\host\\share\\a.ts').status).toBe(400);
    expect(fail('//host/share/a.ts').status).toBe(400);
    expect(fail('file://host/share/a.ts').status).toBe(400);
    expect(fail('file:////host/share/a.ts').status).toBe(400);
    expect(fail('src/a.ts').status).toBe(400);
    expect(fail('.\\a.ts').status).toBe(400);
    expect(fail('C:a.ts').status).toBe(400);
    expect(fail('/etc/passwd').status).toBe(400);
    expect(fail('ftp://x/a').status).toBe(400);
    expect(fail('javascript:alert(1)').status).toBe(400);
    expect(fail('file:///a/b').status).toBe(400);
    expect(fail('  ').status).toBe(400);
  });
});

describe('openAction', () => {
  const editor = 'D:\\VS\\Code.exe';
  const at = (p: string, line?: number, col?: number) => ({ path: p, ...(line && { line }), ...(col && { col }) });

  it('opens directories in Explorer', () => {
    expect(openAction(at('C:\\d'), true, editor)).toEqual({ kind: 'dir', cmd: 'explorer.exe', args: ['C:\\d'] });
  });

  it('opens images, pdf and html with the default program', () => {
    for (const ext of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'html', 'htm']) {
      expect(openAction(at(`C:\\d\\a.${ext}`), false, editor)).toEqual({ kind: 'default', cmd: 'explorer.exe', args: [`C:\\d\\a.${ext}`] });
    }
  });

  it('only selects binaries and shortcuts, even with an editor', () => {
    for (const ext of ['exe', 'com', 'msi', 'lnk', 'url', 'scr', 'cpl', 'dll', 'sys', 'appref-ms', 'EXE']) {
      expect(openAction(at(`C:\\d\\a.${ext}`, 3), false, editor)).toEqual({ kind: 'select', cmd: 'explorer.exe', args: [`/select,"C:\\d\\a.${ext}"`], verbatim: true });
    }
  });

  it('opens code files in the editor, with --goto when there is a line', () => {
    expect(openAction(at('C:\\d\\a.ts'), false, editor)).toEqual({ kind: 'editor', cmd: editor, args: ['C:\\d\\a.ts'] });
    expect(openAction(at('C:\\d\\a.ts', 12), false, editor).args).toEqual(['--goto', 'C:\\d\\a.ts:12']);
    expect(openAction(at('C:\\d\\a.bat', 12, 3), false, editor)).toEqual({ kind: 'editor', cmd: editor, args: ['--goto', 'C:\\d\\a.bat:12:3'] });
    for (const ext of ['cmd', 'ps1', 'js', 'py', 'md', 'json', 'noext']) {
      expect(openAction(at(`C:\\d\\a.${ext}`), false, editor).kind).toBe('editor');
    }
  });

  it('falls back to selecting the file without an editor', () => {
    expect(openAction(at('C:\\d\\a.ts', 12), false, null)).toEqual({ kind: 'select', cmd: 'explorer.exe', args: ['/select,"C:\\d\\a.ts"'], verbatim: true });
  });
});

describe('findEditor and runOpen', () => {
  it('prefers WORKBENCH_EDITOR', () => {
    expect(findEditor({ WORKBENCH_EDITOR: 'X:\\e.exe', PATH: '' })).toBe('X:\\e.exe');
  });

  it('finds Code.exe next to bin\\code.cmd on PATH, never the .cmd', () => {
    const root = path.join(dir, 'vs');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'code.cmd'), '');
    expect(findEditor({ PATH: path.join(root, 'bin') })).toBeNull();
    fs.writeFileSync(path.join(root, 'Code.exe'), '');
    expect(findEditor({ PATH: `C:\\nowhere;${path.join(root, 'bin')}` })).toBe(path.join(root, 'Code.exe'));
  });

  it('logs instead of spawning when WORKBENCH_OPEN_LOG is set', () => {
    const log = path.join(dir, 'log', 'open.jsonl');
    runOpen({ kind: 'select', cmd: 'explorer.exe', args: ['/select,C:\\a'] }, { WORKBENCH_OPEN_LOG: log });
    runOpen({ kind: 'dir', cmd: 'explorer.exe', args: ['C:\\b'] }, { WORKBENCH_OPEN_LOG: log });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ cmd: 'explorer.exe', args: ['/select,C:\\a'] }, { cmd: 'explorer.exe', args: ['C:\\b'] }]);
  });
});
