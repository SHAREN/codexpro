# Local runtime and task recovery

Runtime tools are available in `standard` and `full` tool mode. File, Git and handoff tools keep their existing contracts. `bash` now uses managed process ownership so a long command cannot monopolize one MCP request indefinitely. No additional dependency or database is required.

## Interactive Bash handoff

The normal `bash` tool starts its process under the same runtime used by durable jobs. It waits synchronously only for the interactive budget (`CODEXPRO_INTERACTIVE_BASH_BUDGET_MS`, default 45 seconds). If the command finishes within that window, CodexPro returns the normal Bash result and removes the temporary job metadata/log files. If it is still running, CodexPro returns `status: running`, a stable `job_id`, a bounded output tail and the suggested `get_job` / `job_logs` / `cancel_job` actions. The process is **not replayed**: the same already-running job continues once in the background.

`timeout_ms` remains the maximum execution time for that command, not the MCP request duration. When omitted, managed Bash uses `CODEXPRO_BASH_JOB_TIMEOUT_MS` (default up to 600 seconds, bounded by `CODEXPRO_MAX_BASH_TIMEOUT_MS`). Thus the request can be released after about 45 seconds while the same command safely continues.

Client cancellation is propagated through the MCP `AbortSignal`. Request-owned Bash work terminates and reaps its process tree. Premature HTTP disconnects (`req.aborted` / response close) feed the same cancellation path. When the client supplies a progress token, long tool calls emit real `notifications/progress`; this is independent of local CodexPro request/tool logging and telemetry settings.

Nested background syntax such as `nohup`, `disown`, `setsid -f`, or a trailing `&` is rejected inside CodexPro Bash. Use `start_job` instead so process ownership, logs, cancellation and restart state remain explicit.

## Background jobs

Use `start_job({workspace_id, command: "npm run check", cwd: "."})`. It returns a stable `job_id` immediately. Poll `get_job({workspace_id, job_id})`; read `job_logs({workspace_id, job_id, stream: "stdout", offset: 0})` and repeat with `next_offset`. Omit `offset` for the latest tail. Select `stderr` separately. Each response is capped at 30 KB or the configured output limit, whichever is smaller. The response reports truncation. `cancel_job` terminates a job owned by the current server, using the same process-tree termination as `bash`. `remove_job` deletes metadata and logs for a terminal job; a running job must first complete or be cancelled.

Jobs store `<job-id>.json`, `<job-id>.stdout.log` and `<job-id>.stderr.log` under `$CODEXPRO_HOME/jobs` (default `~/.codexpro/jobs`). JSON updates use a temporary file and rename. Logs stream directly to file descriptors, so long output is not retained in server memory or limited by an MCP request. Logs remain local until explicitly read and are redacted on tool output; local log files may contain sensitive command output.

Explicit durable jobs, and normal Bash commands that were handed off after the interactive budget, survive MCP session disconnects and server exit while the machine remains running. Completed metadata survives restart. A job still recorded as running by a previous server is reported as `lost`: its process may still be executing, but this server cannot establish its identity or exit status. It never guesses success or kills a recovered PID. Read its saved logs and inspect the local process before deciding to run the command again. Recovery lists show the latest 100 jobs; older jobs remain available by ID.

## Persistent Bash

`open_shell({workspace_id, cwd: "."})` returns a `shell_id`. Send one command at a time with `shell_exec`; poll `shell_read` until `status` is `idle` before sending the next command. The response includes the command's exit code and bounded retained stdout/stderr. `close_shell` terminates the shell and its process tree.

Commands execute in the same ordinary Bash subprocess, preserving cwd and environment. For example, in trusted `bashMode=full`:

```text
shell_exec(shell_id, "cd src")
shell_exec(shell_id, "export EXAMPLE=value")
shell_exec(shell_id, "printf '%s' \"$EXAMPLE\"")
```

Use a separate literal `cd` command. Its target is checked through `PathGuard`, including workspace containment, blocked paths and symlinks. Environment setup such as `export`, PATH changes and sourcing a workspace venv activation script requires full mode, just as it does with `bash`. There are at most eight open shells. Graceful server shutdown closes them; shell sessions are not reattached after restart. No PTY, ConPTY, interactive TUI or terminal resize is provided. Windows uses the configured Bash runtime. Git for Windows Bash is supported, and explicit `CODEXPRO_BASH_RUNTIME=wsl` uses `wsl.exe` with Windows↔Linux path translation for cwd and job logs.

Both execution APIs use the existing command policy, restricted environment and optional required `session_id`. `bashMode=off` hides execution tools; connection-test mode disables mutations. As with existing `bash`, safe mode trusts allowlisted repository scripts, and full mode executes trusted arbitrary local code. These policies are **not an OS filesystem sandbox**: a trusted script or full-mode command can access what the OS user can access. Do not enable execution for untrusted repositories. The guarded `cwd` parameter does not sandbox code launched by the shell.

## Search budget and client-stall telemetry

Workspace `search` has its own interactive budget (`CODEXPRO_INTERACTIVE_SEARCH_BUDGET_MS`, default 45 seconds). Cancellation propagates through ripgrep, the Node file traversal fallback, and structured repository inventory/extraction/search loops. If the budget expires, CodexPro stops the work and returns guidance to narrow `path`, `glob`, or the query instead of leaving the MCP call open for a minute or more.

HTTP session heartbeat telemetry distinguishes `request_active`, ordinary `idle_between_requests`, and `client_stall_candidate`. The last state is emitted when there are no active MCP requests, the last completed JSON-RPC request was a concrete `tools/call`, and no next request arrives for `CODEXPRO_CLIENT_STALL_MS` (default 30 seconds). This identifies the case where CodexPro already returned the tool result but the ChatGPT turn did not continue; it is diagnostic only and does not cause the server to invent or replay a client request.

## Recovery tasks

`create_task({workspace_id, title, goal, plan})` creates:

```text
.ai-bridge/tasks/<task-id>/
  task.json
  plan.md
  checkpoints.jsonl
  execution.log
```

The configured `CODEXPRO_CONTEXT_DIR` replaces `.ai-bridge` when customized. Task writes honor `writeMode`: enabled in workspace/handoff mode and disabled in off/connection-test mode. The existing current plan and agent handoff files are not overwritten.

Use `checkpoint_task` with a `checkpoint` containing `summary`, `completed`, `remaining`, `decisions`, `tests` (command/result pairs) and `known_issues`. Optionally associate `related_jobs` and `related_shell`. Branch, HEAD and changed file summaries are captured from Git. Test results are the caller's recorded evidence; job exit codes remain separate runtime observations.

`get_task` reads saved state. `resume_task({workspace_id, task_id})` returns that task with fresh Git, job and shell state, the latest checkpoint, applicable AGENTS instructions and bounded handoff excerpts. It does not switch branches or execute remaining work. `task_context({workspace_id, target_path})` selects the most recently updated active task and returns the same recovery context in one call. Checkpoint branch/HEAD remain distinct from current Git state. Use existing `show_changes` for the full diff. `finish_task` marks the task completed or cancelled without deleting its history. No conversation transcript is copied.

Workspace registration and runtime resources are shared across HTTP MCP sessions; each session keeps its own current workspace selection. After a server restart, call `open_workspace` again for a nonconfigured nested workspace, then use its stable ID to recover saved tasks/jobs.

## Runtime Console

With the existing HTTP server running, open `http://127.0.0.1:8787/runtime` (replace the port if configured). It uses the same server token as `/setup`; an initial local URL may include `?codexpro_token=YOUR_EXISTING_TOKEN`. The page removes the token from the visible URL and keeps it in tab session storage for authenticated requests. Do not share token-bearing URLs.

The Console is local only, rejects forwarded requests and cross-origin access, and is not exposed through the public tunnel. It polls the existing runtime state every three seconds. It shows workspaces, active task/checkpoint, jobs, shells, Git changes, validation and agent/handoff notes. Buttons read stdout/stderr, cancel a job and close a shell. It is an observation surface, not another source of task state. Mutations are unavailable in minimal/connection-test mode.

For stdio users, job/shell/task tools are available without HTTP; the Console is served by the HTTP process and displays the shells owned by that process. Run the HTTP transport when you need both MCP and the Console over the same live runtime.

## Verification

`npm run build`, `node scripts/runtime-smoke.mjs`, `node scripts/cancellation-smoke.mjs`, and `node scripts/telemetry-smoke.mjs` exercise real local subprocesses and HTTP MCP sessions: command completion/failure, managed handoff without replay, transient-job cleanup, explicit durable-job removal, exit codes, bounded log reads, Stop/cancellation, HTTP disconnect cleanup, MCP progress, reconnect/restart semantics, WSL path handling, policy checks, persistent environment/cwd, client-stall classification, checkpoint recovery, and authenticated Console routes/actions. These smoke tests are part of `npm run smoke`; no separate QA pipeline is required.
