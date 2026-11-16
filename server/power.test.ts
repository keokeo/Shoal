import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPowerBlocker } from './power.ts';

class FakeChild extends EventEmitter {
  killed = false;
  stdinEnded = false;
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  unref() {}
  kill() {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

describe('windows power blocker', () => {
  it('acquires ES_CONTINUOUS | ES_SYSTEM_REQUIRED on sync(true) and releases cleanly on dispose', () => {
    const spawned: { file: string; args: string[]; proc: FakeChild }[] = [];
    const blocker = createPowerBlocker({
      enabledByPlatform: true,
      spawnImpl: ((file: string, args: string[]) => {
        const proc = new FakeChild();
        spawned.push({ file, args, proc });
        return proc as never;
      }) as never,
    });

    expect(blocker.isActive()).toBe(false);
    blocker.sync(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toBe('powershell.exe');
    expect(spawned[0].args.join(' ')).toContain('SetThreadExecutionState');
    expect(spawned[0].args.join(' ')).toContain('2147483649');
    expect(blocker.isActive()).toBe(true);

    // Calling sync(true) again does not spawn duplicates.
    blocker.sync(true);
    expect(spawned).toHaveLength(1);

    blocker.dispose();
    expect(spawned[0].proc.stdinEnded).toBe(true);
    expect(spawned[0].proc.killed).toBe(true);
    expect(blocker.isActive()).toBe(false);
  });

  it('tracks logical state without spawning when platform lock is disabled', () => {
    let calls = 0;
    const blocker = createPowerBlocker({
      enabledByPlatform: false,
      spawnImpl: (() => {
        calls++;
        return new FakeChild() as never;
      }) as never,
    });
    blocker.sync(true);
    expect(calls).toBe(0);
    expect(blocker.isActive()).toBe(true);
    blocker.sync(false);
    expect(blocker.isActive()).toBe(false);
  });
});
