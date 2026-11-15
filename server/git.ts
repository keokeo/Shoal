import type { GitInfo } from '../shared/protocol.ts';
import { readGitInfo } from './workspace.ts';

// Output of `git status --porcelain=v2 --branch`. null when there is no branch header (garbage / empty).
export function parseGitStatus(out: string): GitInfo | null {
  let head: string | undefined;
  let oid = '';
  let dirty = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim();
    else if (!line.startsWith('#')) dirty++;
  }
  if (!head) return null;
  if (head === '(detached)') return { branch: oid && oid !== '(initial)' ? oid.slice(0, 7) : 'HEAD', detached: true, dirty };
  return { branch: head, detached: false, dirty };
}

let warnedMissing = false;

// null when dir is not a git repo, git is missing, it times out or fails: never throws.
// Reuses workspace porcelain snapshot (--no-optional-locks, -z, --untracked-files=all) so sidebar dirty counts match Inspector 100%.
export async function gitInfo(dir: string): Promise<GitInfo | null> {
  try {
    const res = await readGitInfo(dir);
    if (res.enoent && !warnedMissing) {
      warnedMissing = true;
      console.warn('[git] 找不到 git，侧栏不显示分支');
    }
    return res.git;
  } catch {
    return null;
  }
}
