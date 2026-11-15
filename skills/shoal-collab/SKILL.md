---
name: shoal-collab
description: Collaborate with peer CLI agents (Claude Code, Codex, Antigravity) inside the same Shoal project—read silent PEERS.md turn snapshots or send/ask tasks via `shoal` CLI. Use only when the user explicitly asks to inspect another task/pane/agent, pass work to a peer agent, or request a review/round-trip answer.
---

# Shoal Peer Collaboration (`shoal`)

You are running inside a **Shoal** workbench session. You can read peer outputs passively or contact another CLI session in the **same project** without blocking.

## 1. Passive Reading (Zero Disturbance)

- Check `WORKBENCH_PEERS_FILE` (`<stateDir>/collab/<projectId>/PEERS.md`) for an index of active tasks in this project, their `#index`, `taskId`, agent kind, status, and snapshot file paths (`turns/<taskId>-latest.md`).
- Read the referenced `turns/<taskId>-latest.md` directly when you only need another task's latest conclusion without interrupting it.

## 2. Active Peer Messaging (`shoal` CLI)

The `<stateDir>/bin` directory is already on your `Path`/`PATH`, along with `WORKBENCH_PEER_TOKEN`, `WORKBENCH_PORT`, and `WORKBENCH_NODE`.

### List peers in the current project
```sh
shoal peers
```

### One-way send (fire-and-forget)
```sh
shoal send <target> -m "short single-line note"
shoal send <target> --file path/to/message.md
```

### Round-trip request (auto reply-back once)
```sh
shoal ask <target> -m "please review docs/collab-spec.md and point out risks"
```
Or pipe multi-line content over `--stdin`:
```sh
shoal ask codex --stdin <<'EOF'
Please review the changes in server/sessions.ts and reply with blocking issues only.
EOF
```

## 3. Rules & Safety Constraints

1. **No `@` prefix on PowerShell**: pass `#2`, `codex`, `claude`, `agy`, a task ID, or a unique task title directly (e.g. `shoal ask codex ...`, never unquoted `@codex` in PowerShell, which gets swallowed as a splat variable).
2. **Multiline safety**: on Windows `.cmd`, NEVER pass literal newlines inside `-m "..."`; use `--file <path>` (inside project dir or `WORKBENCH_COLLAB_DIR`) or `--stdin`.
3. **End your turn after `shoal ask`**: `shoal ask` returns immediately after queuing delivery. Stop your turn and wait—Shoal will automatically paste the peer's single reply back into your session once its turn finishes. Never write `sleep`/polling loops.
4. **Target resolution**:
   - `#1`, `#2`, ... (from `shoal peers`), exact/prefix `taskId`, or unique title substring targets an existing task.
   - An agent name (`claude`, `codex`, `agy`) hits the single matching task in this project, spawns a new peer task automatically if none exists (or with `--new`), and asks you to pick `#index` if multiple tasks of that agent already exist.
5. **Hard loop caps**: automatic round-trip chains stop at 4 hops and block duplicate bursts within one turn.
