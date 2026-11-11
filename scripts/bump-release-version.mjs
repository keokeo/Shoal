// CI advances the desktop patch version beyond the source version and all existing release tags.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILES = [
  ['tauri.conf.json', /^(\s*"version":\s*")([^"]+)(")/m],
  ['Cargo.toml', /^(version = ")([^"]+)(")/m],
  ['Cargo.lock', /^(name = "shoal"\r?\nversion = ")([^"]+)(")/m],
];
const parts = version => {
  if (!SEMVER.test(version)) throw new Error('Invalid desktop version: ' + version);
  const result = version.split('.').map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error('Desktop version exceeds integer range');
  return result;
};
const compare = (a, b) => {
  const x = parts(a), y = parts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export function bumpReleaseVersion(root, tags) {
  const files = FILES.map(([name, pattern]) => {
    const file = path.join(root, 'desktop', 'src-tauri', name);
    const original = fs.readFileSync(file, 'utf8');
    const match = original.match(pattern);
    if (!match) throw new Error('Missing desktop version in ' + file);
    parts(match[2]);
    return { file, pattern, original, version: match[2] };
  });
  const current = files[0].version;
  if (files.some(file => file.version !== current)) throw new Error('Desktop version files disagree');
  const versions = tags.split(/\r?\n/).filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)).map(tag => tag.slice(1));
  const latest = [current, ...versions].sort(compare).at(-1);
  const [major, minor, patch] = parts(latest);
  if (!Number.isSafeInteger(patch + 1)) throw new Error('Desktop patch exceeds integer range');
  const next = [major, minor, patch + 1].join('.');
  try {
    for (const file of files) {
      fs.writeFileSync(file.file, file.original.replace(file.pattern, (_, head, _version, tail) => head + next + tail));
    }
  } catch (error) {
    for (const file of files) fs.writeFileSync(file.file, file.original);
    throw error;
  }
  return { current, next };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' });
  const { current, next } = bumpReleaseVersion(root, tags);
  console.log('[release] Shoal ' + current + ' -> ' + next);
}
