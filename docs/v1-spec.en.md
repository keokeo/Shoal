# Shoal v1 Requirements and Design

English | [简体中文](v1-spec.md)

> The project was originally called Agent Workbench. This is the design record from development; the Chinese original calls the author by the nickname "虾哥".

Status: draft; M0 technical validation passed (2026-11-08, report in `.tmp/m0/REPORT.md`); M1 passed (2026-11-08, see `.tmp/m1/RUN.md`); M2 passed (2026-11-09, see `.tmp/m2/RUN.md`)

## 1. Problem to solve

The author usually runs 3–9 agent sessions at once (Claude Code, Codex, agy) across several projects. Current pain points:

1. The more terminal splits, the less each one shows; opening multiple windows crowds the taskbar.
2. Windows look too alike, focus fails to switch over, and instructions go to the wrong session.
3. When one vendor's quota runs out and the work must move to another agent, the new agent has to read the old session's transcript, which costs time and tokens.
4. Passing results between agents can only be done by copy and paste or intermediate files.

## 2. Positioning

A web workbench that runs locally and is centered on tasks. The author assigns work and reviews it; an agent owns a task from start to finish, and the author does not care about the development and testing steps in between.

In the first version the author assigns the work. Following the layering of the DeepSeek super-agent: the author acts as the Router layer that dispatches work, and each agent session is a Worker layer that does it.

## 3. Hard constraints

- **Drive only each vendor's native interactive CLI** (`claude`, `codex`, `agy`), running inside a PTY. Do not use headless mode, SDKs, app-server or ACP for the main work, because measurements showed these consume more quota.
- **Native Windows**: Windows 11, no dependency on WSL, `/bin/sh`, `curl` or `which`.
- **Local use only**: listen on `127.0.0.1` only; design the API and authentication with later phone access in mind, but v1 is not exposed externally.
- **Do not break existing configuration**: existing hooks (token-tracker, Codex `notify`, computer-use, etc.) may only be appended to, never overwritten.

## 4. Core flow

```
New task (「新建任务」): pick a project directory → pick an agent → write the requirement → (optional) create a worktree, with a confirmation dialog before creating it
  → In progress: the PTY runs in the background; click to open the full terminal and type to intervene directly
  → Stopped: a hook or the terminal output detects that the agent is waiting for a person
      ├─ Waiting mid-task for your answer or authorization → "Needs you" (「需要你」) queue
      └─ Task finished → "Awaiting review" (「待验收」) queue, showing a result card
  → Review: if it passes, archive it
            if there are problems, write feedback → by default a new session is opened with the task card and feedback injected; you can also choose to resume the old session
  → Quota exhausted: generate a handoff card → one click to let another agent continue
  → Forward: send a result card plus one sentence of instruction to another task or agent
```

## 5. Feature scope

### Required in v1

| Feature | Description |
|---|---|
| Project and task list | The left side lists tasks grouped by project; each task shows its current agent, status and waiting time |
| Visual distinction between sessions | Each task has a fixed color, used for the main area's border, title bar and input prompt; the title reads "project / task / agent" |
| Input follows the main area | Only the session shown in the main area receives keyboard input; the title flashes when switching sessions; no send-confirmation dialog |
| Main area | Shows 1 session by default, can be switched to 2 side by side; sessions are not shrunk just because there are many |
| "Needs you" and "Awaiting review" queues | Sorted by waiting time; ``Alt+` `` jumps to the next session waiting for you (Chrome does not hand `Ctrl+Tab` to web pages) |
| Result card | Uniform format: conclusion, links or run entry points that can be opened, which files changed, which checks were run and their results, what is not yet verified, risks |
| Feedback and continuation | Opens a new session with context injected by default; a "Resume old session" (「续接旧会话」) button is kept |
| Switch agent | Automatically generates a handoff card and continues in the same directory with another vendor's CLI |
| Forward | Adds one sentence of instruction to a result card and pastes it into the target session |
| Optional worktree | Each task decides for itself whether to create one, with a confirmation dialog first; placed at `<repo>/.worktrees/<branch>` |
| Persistence | After closing and reopening the workbench, tasks, session IDs and cards are still there; PTY processes are not kept, and on reopening sessions are restored with the resume command |

### Later

Letting an agent act as the overall dispatcher to assign work, automatic flow between multiple agents, phone access, Watchdog monitoring, packaging as a desktop app, multiple machines.

## 6. Technical design

### 6.1 Tech stack

- Server: Node 24 + TypeScript, `node-pty` (ConPTY on Windows), HTTP + WebSocket, `node:sqlite` for persistence.
- Frontend: React + Vite, `@xterm/xterm` with the fit, webgl and search addons.
- Testing: Vitest for pure logic; Playwright with a fake agent CLI for e2e; one smoke test for each of the three real CLIs.

### 6.2 Launching the CLIs on Windows (verified in M0)

- Do not go through `.cmd` wrappers; launch the real programs directly: Claude uses `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, Codex uses `node %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`, agy uses `%LOCALAPPDATA%\agy\bin\agy.exe`.
- Launch command table (hook arguments are in 6.3):

| agent | New session | Resume | How to get the session ID |
|---|---|---|---|
| Claude | `claude.exe --session-id <uuid>` | `claude.exe --resume <uuid>` | The workbench generates the UUID itself |
| Codex | `codex.js -c check_for_update_on_startup=false` | `codex.js resume <id> ...` | `session_id` in the hook payload; SessionStart does not fire until the first prompt is submitted |
| agy | `agy.exe` | `agy.exe --conversation <id>` | `conversationId` in the hook payload |

- Environment variables: inject `WORKBENCH_SESSION_ID`, `WORKBENCH_PORT` and `WORKBENCH_HOOK_TOKEN`; remove `CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_SANDBOX*`, `CODEX_THREAD*` and `AGY_SESSION*` inherited from the parent process, so the session is not detected as nested.
- **Startup dialogs must not be answered blindly**: trusting the directory (Claude's default option is "No, exit"), Codex's "Hooks need review", update prompts, login prompts. When the workbench recognizes such a dialog, it puts the session into "Needs you" for the author to handle.

### 6.3 State detection: hooks first, terminal output as backup

- **Inject hooks at every launch; do not modify the global hooks files**. All three vendors run `node <workbench>/hooks/notify.mjs <agent> <event>`, and this script POSTs the payload to `127.0.0.1:<port>/hook`:
  - Claude: `--settings <tmp.json>`, with content `{hooks:{Stop:[{hooks:[{type:"command",command,timeout}]}], ...}}`. It is merged with the user's existing hooks, not overwriting them.
  - Codex: `-c 'hooks.<Event>=[{hooks=[{type="command",command=...,timeout=5}]}]'`. **The author must trust it once in `/hooks` the first time**; the trust record's key is `<session-flags>:<event>:0:0`, independent of any particular session, so trusting once stays valid. `--dangerously-bypass-hook-trust` is not used, because it also runs hooks the user has not trusted.
  - agy: `--add-dir <dir>`, with `.agents/hooks.json` placed under dir, in the format `{workbench:{Stop:[{type:"command",command,timeout}]}}`. agy runs commands through `cmd /c`, and **the command cannot contain quotes**, so the workbench's install path must not contain spaces.
- Event mapping:
  - Claude: `Stop` and `StopFailure` count as stopped; `Notification` and `PermissionRequest` count as waiting for you; `UserPromptSubmit` and `PreToolUse` count as working.
  - Codex: `Stop` counts as stopped; `PermissionRequest` counts as waiting for you; `UserPromptSubmit` counts as working. The OSC 7501 `state=done|idle:app=codex` in the terminal output serves as a secondary signal.
  - agy: `Stop` counts as stopped (with `terminationReason`, `fullyIdle`, `error`); `PreInvocation` counts as working.
- **Ctrl+C does not trigger Stop** (verified on all three): after the workbench sends Ctrl+C, it sets the state to "Needs you" itself.
- **Fallback**: analyze terminal output, for example the appearance of an input prompt, busy markers such as "esc to interrupt", or 15 seconds without output.
- **Telling "finished" from "waiting for you"**: on stop, read the last assistant message. For Claude and Codex it comes from the hook's `last_assistant_message`; agy's payload does not have it, so read the PLANNER_RESPONSE from `transcriptPath` (`transcript_full.jsonl`). If the message contains the result card marker, the task goes to "Awaiting review"; otherwise to "Needs you".
- **Detecting quota exhaustion**:
  - Claude: `isApiErrorMessage`, `apiError:"usage_limit_reached"` and `apiErrorParams.rate_limit_info{rateLimitType,resetsAt}` in the jsonl;
  - Codex: `token_count.rate_limits.rate_limit_reached_type`, no real sample yet;
  - agy: no sample yet.
  - All hook payloads and raw terminal output are written to disk to fill in samples.
- Implementation (M3, `server/quota.ts`): automatic detection for claude only. If `StopFailure`'s `error` is `rate_limit` or `billing_error`, or the last reply of `Stop` matches `/hit your .*limit/i`, it is recorded on the session's `limit`, and no result card is generated for that turn; the reset time is read from `apiErrorParams.rate_limit_info.resetsAt` at the end of the transcript. After that, any "working" event clears `limit`. The UI shows a quota banner and a "Switch agent" (「换 agent」) button above the terminal, and the sidebar shows "Quota exhausted" (「额度用完」). codex and agy have no samples, so switching agent is manual only.

### 6.4 Result card

- Implementation (M2): at the end of each turn (Stop hook), a result card is generated from the last assistant reply and the task enters "Awaiting review". No format instructions are appended at launch and no `result.md` is written, to avoid changing the agent's native behavior.
- Reply source: claude and codex take the payload's `last_assistant_message`; agy reads the last PLANNER_RESPONSE from `transcriptPath`.
- The card content is the reply text itself. When a fixed format is needed (conclusion, changed files, commands, checks, unverified, risk, acceptance entry point), it is enforced by each CLI's global rules; the workbench does not parse the format.

### 6.5 Handoff card (used when switching agent or opening a new session)

- **Data sources**: the task requirement, the latest result card, the feedback record, and the old session's raw transcript.
- **How it is generated**: a cheaper model that still has quota reads the above and writes the handoff card, including goal, done, in progress, key decisions, pitfalls, next steps, and files that must be read first. This is a short call, and the author has agreed to this consumption.
- **Tiered by the receiving model's capability**: a strong model gets only the card and the path to the raw transcript; a weaker model additionally gets the must-read file list, a one-sentence next step and the acceptance method.
- **Drawing on T3 Code**: if generating the handoff card fails, fall back by selecting the raw transcript within a token budget: keep the first and the last requirement, then fill in from the most recent conversation backwards, and mark what was omitted.

M3 implementation (`server/handoff.ts`, `server/transcript.ts`, `POST /api/tasks/:id/switch`):
- **The generator is the receiving agent itself**, run once in its headless mode as a short call. This avoids configuring separate credentials for a "cheaper model", and as long as the receiver has quota, generation will work:
  - claude: `claude.exe -p --model haiku --tools "" --no-session-persistence`, with the prompt via stdin;
  - codex: `codex.js exec --ephemeral --skip-git-repo-check -s read-only -c model_reasoning_effort="low" -o <file> -`, which triggers the author's own codex hooks (harmless);
  - agy: `agy.exe -p <prompt> --effort low --print-timeout 2m --disable-slash-commands` (does not read stdin).
  - Timeout is 120 seconds; on failure or empty output, the fallback card is used.
- **Generator input**: the task requirement, the latest result card, the previous handoff card, the feedback and forwarding records, the author's added notes, plus a conversation excerpt from the old session's transcript (claude/codex jsonl, agy's `transcript_full.jsonl`). The excerpt keeps the first and the last requirement, then fills in from the most recent backwards, and states how many entries were omitted. The whole prompt does not exceed 20000 characters.
- **No capability tiering**: all three receivers are flagship models, and the card uniformly contains goal, done, in progress, key decisions, pitfalls, next steps, files that must be read first, and acceptance method.
- **Fallback card**: begins with "(Auto-summary failed…)" (「（自动整理失败……）」), followed by the task requirement, the latest result (within 6000 characters), the latest 3 feedback entries and a conversation excerpt (within 12000 characters); the UI shows "Excerpted from the record" (「已按记录摘录」).
- **First message of the new session**: states whom it is taking over from and why the switch happened (quota exhausted / the author decided to switch), then the handoff card, the author's added notes and the old transcript path (so it can look things up as needed rather than read the whole file). If it exceeds 8000 characters, it is written to a prompt file as usual.
- Only one switch-agent request may be in progress per task (a second one returns 409); if the task is deleted during generation, 404 is returned and no new session is left behind. The handoff card is stored as `kind: handoff` with `meta` of `{from, to, generated}`, and appears at the top of the panel as an expandable thin bar.

### 6.6 Sending instructions into a session (injecting cards, forwarding, feedback)

Drawing on Parallel Code's `writeAgentPrompt`: paste the whole content in using bracketed paste, wait a moment, then send a separate Enter. If the agent is busy, the author has an unsent draft, or the author typed within the last 5 seconds, queue it first and send later.

M2 implementation (`server/sessions.ts`):
- Delivery conditions: the state has been "Needs you" for at least 1.5 seconds; there is no permission prompt; the author has not typed in that session within 5 seconds; at least 2 seconds since the last delivery. Checked every 250ms.
- Paste: send a separate `\r` 300ms after pasting.
- Newlines:
  - Do not use `\r` inside the paste, because Codex also submits when it meets `\r` in a paste.
  - claude and agy use `\n`.
  - codex uses a win32-input-mode Ctrl+J key record. Reason: Codex on Windows reads key events, and `\n` counts as a newline only inside its ASCII paste-burst detection, so a `\n` following pure Chinese text gets dropped.
  - When the CLI has not enabled bracketed paste, newlines are collapsed into spaces.
- Not implemented: "unsent draft" detection; for now it only checks whether there was typing within 5 seconds.

M3 forwarding (`POST /api/cards/:id/forward`): a result card's "Forward" (「转发」) can send to another task or a new task. The content sent is the note (default "Below is the result of another task, for your reference."), the source title line and the card text; what the dialog previews is the final text. When sending to an existing task, it goes through the queued delivery above, and if the target is busy it shows "Message queued" (「消息排队中」); if the target session has exited, it is resumed under the feedback rules, and if it cannot be resumed the user is prompted to forward to a new task. The target task stores a `kind: forward` card, with `meta` recording the source task and card; the source task's state is unchanged.

### 6.7 Data model (draft)

- Project: id, name, path, color
- Task: id, projectId, title, prompt, color, status (running / needs_you / review / done / archived), worktreePath?, createdAt
- Session: id, taskId, agent, nativeSessionId, mode (new / resume / handoff), startedAt, endedAt, endReason
- Card: id, taskId, sessionId, kind (result / handoff / feedback / forward), body, createdAt, meta? (handoff: from, to, generated; forward: sourceTaskId, sourceCardId)
- Session runtime info (M3): transcriptPath (taken from the hook payload), limit (message, resetsAt, at)
- Event: id, sessionId, source (hook / heuristic / user), type, payload, at

## 7. Milestones and acceptance criteria

| Milestone | Content | Acceptance criteria |
|---|---|---|
| **M0 Technical validation (passed)** | Run the three native CLIs in a web page through node-pty; inject hooks at every launch; test Chinese input methods | All three CLI UIs render correctly, Chinese can be typed, Ctrl+C works; the "stop" events of all three reach the server accurately; session IDs of all three can be obtained; output samples from quota exhaustion are collected. If any item fails, adjust the design first |
| **M1 Workbench skeleton (passed)** | Project and task list, color distinction, main area, status display, ``Alt+` `` | e2e test: run 6 sessions at once with a fake CLI, states are correct; after switching sessions, input always goes to the session currently shown |
| **M2 Review loop (passed)** | Result card, "Awaiting review" queue, opening a new session or resuming the old one after feedback, persistence | e2e test: finished goes to "Awaiting review" → write feedback → the new session receives the card; after restarting the workbench the old session can be resumed |
| **M3 Switch agent and forward (passed)** | Handoff card, switch agent, forward | e2e test: simulate quota exhaustion → switch agent → the new session receives the handoff card; forwarded content arrives intact; it is queued when the target session is busy |
| M4 worktree | Optional worktree, confirmation dialog, linking node_modules, merge and cleanup | A confirmation dialog always appears before creating; linking node_modules on Windows does not need administrator rights (use a junction) |

Every milestone must save its test artifacts (commands run, inputs, logs, screenshots) to `.tmp/<milestone>/`.

## 8. Risks

- **xterm.js plus ConPTY rendering and Chinese input methods**: verified in M0.
- **Codex hooks need the author to grant trust once**: as long as any hook is still untrusted, a review dialog appears at every launch; the workbench recognizes it and hands it to the author.
- **agy's hook path cannot contain spaces**: because quotes cannot be used in the command. The current install path `G:\Workspace\agent-workbench` satisfies this; check it at startup.
- **No quota-exhaustion samples for Codex and agy**: the detection rules are written for Claude only for now, and the other two will be added once samples are collected in real use.
- **CLI upgrades changing output formats and breaking terminal analysis**: hence hooks come first and terminal analysis is only a fallback. Codex's startup update check must be turned off.

## 9. References

- DeepSeek super-agent article and prototype: https://github.com/deepseek-ai/dsh-superagent-prototype
- Parallel Code (PTY, hooks, state detection, how instructions are sent, worktree): https://github.com/johannesjo/parallel-code
- T3 Code (handoff budget algorithm, data model, mobile authentication): https://github.com/pingdotgg/t3code
- Source snapshots: `.tmp/ref/` (read-only reference, not run)
