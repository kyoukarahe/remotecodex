# RemoteCodex

RemoteCodex maps Discord text channels to local Windows Codex sessions.

V1 scope is intentionally chat-only:

- Discord channel creation does not create a local Codex session. Session creation belongs to Windows Codex only.
- A local Codex session can create a matching Discord channel through `SessionBridge.handleCodexSessionCreated`.
- Running bot instances poll Codex session metadata and create Discord channels for new local Codex sessions observed after startup.
- The command channel can import or bind existing Codex sessions, but it cannot create Codex sessions.
- One Discord channel maps to one Codex session.
- Deleting a Discord channel archives the mapped Codex session locally.
- Calling `SessionBridge.handleCodexSessionArchived` deletes the mapped Discord channel. The default watcher does not infer archive from missing session-index entries because Codex indexing can lag or be unavailable.
- Discord messages are forwarded to `codex exec resume`, then the final Codex response is posted back.
- Codex session history migration renders a transcript into a Discord channel while keeping transcript identity separate from the underlying Discord channel id.
- Runtime Discord events are filtered to `DISCORD_GUILD_ID` so other servers that contain the same bot are ignored.

## Transcript Migration Notes

- Full-history transcript migration is the default whenever the source session file is parseable.
- Migrated transcripts preserve source turn order with explicit speaker roles for `user`, `assistant`, `system`, and `tool`.
- Discord transport chunking is explicit: long source turns are split into ordered transcript chunks, each tagged with transcript id, source turn index, role, and chunk position.
- Rendering uses plain-text labels such as `User:` and `Codex:` while keeping the underlying role in transcript chunk metadata.
- Binary attachments are not imported. If attachment-derived content is skipped, the transcript is marked `partial`.
- Reduced-scope migration is not automatic. The only supported fallback is an explicitly approved `recent15Pairs` mode, which is marked `reduced_scope`.
- Source references must resolve unambiguously. A session id must match exactly one indexed session, while an explicit filesystem path is treated as the storage path and remains distinct from the logical session id discovered from file contents.

## Setup

```powershell
npm.cmd install
Copy-Item .env.example .env
```

If you use WSL or another non-Windows runtime against a Windows-created checkout, reinstall dependencies on that runtime before running tests. Optional native packages such as `rolldown` and `esbuild` are platform-specific and will fail if `node_modules` was copied across platforms.

Fill `.env` with a Discord bot token and guild id, then run:

```powershell
npm.cmd run dev
```

For a Windows-friendly launcher, you can also run:

```powershell
scripts\start-remotecodex.bat
```

For the normal packaged runtime, build once and run the compiled bot:

```powershell
npm.cmd run build
npm.cmd start
```

PowerShell may block `npm.ps1` on this machine, so the examples use `npm.cmd`.

For multi-PC routing, set a unique `REMOTE_CODEX_HOST_ID` per machine and a shared `REMOTE_CODEX_DEFAULT_OWNER_HOST_ID`. A channel name prefix such as `pc1--my-session` or `pc2--my-session` overrides the default owner for that channel.

## Discord Notes

Discord normal text channels do not have a native archive state like threads. For v1, RemoteCodex treats Codex-side archive as Discord channel deletion. If you prefer retained history later, the Discord adapter can be changed to move channels to an archive category instead.

RemoteCodex uses `remote-codex-hosts` as the command input channel by default. Each host also maintains a `heartbeat` channel under its own category, keeping only the latest bot-authored status message there.

Supported command-channel commands:

```text
!help
!status
!version [hostId]
!update <hostId|all>
!import <hostId> <latest|sessionId>
!bind <hostId> <channelId> <sessionId>
```

## Updates

RemoteCodex can update a target host from the command channel:

```text
!version [hostId]
!update <hostId|all>
```

For update support, configure each host with:

```env
REMOTE_CODEX_REPO_URL=git@github.com:kyoukarahe/remotecodex.git
REMOTE_CODEX_UPDATE_BRANCH=master
REMOTE_CODEX_DEPLOY_KEY_PATH=_local-secrets/remotecodex_deploy_key
REMOTE_CODEX_UPDATE_ENABLED=true
```

When a zip-installed host has no `.git` directory, the updater initializes Git in place, configures `origin`, fetches the configured branch, then keeps `.git` for later updates. Local runtime files such as `.env`, `_local-secrets`, and `.remotecodex` are ignored and preserved.

The update command starts `scripts/update-remotecodex.ps1` as a detached PowerShell process, then exits the bot. The updater fetches the repo, resets to the fetched branch, runs `npm ci` and `npm run build`, restarts the bot, and writes a status file so the restarted bot can post the result back to Discord.

## Codex Notes

The Codex adapter auto-detects the installed Codex CLI, preferring `codex.cmd`, then `codex.exe`, then `codex`:

- Chat turns: `codex exec resume --json <sessionId> <message>`

RemoteCodex does not create Codex sessions or append to Codex's session index. Create sessions in Windows Codex, then let the watcher discover them or import them explicitly from the command channel.

Codex CLI does not currently expose a stable archive command in `codex --help`, so archiving is recorded in RemoteCodex state and prevents additional routing.

By default, the watcher treats existing Codex sessions as a startup baseline so it does not create a Discord channel for every historical session. Import historical sessions explicitly from the command channel.

## Windows Startup

To register the bot in Windows startup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

This creates a Startup shortcut that runs `scripts\start-remotecodex-hidden.vbs`, which launches the bot without leaving a visible console window open.

To remove it later:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-startup.ps1
```

## Packaging

Create a zip package for another Windows PC:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-remotecodex.ps1
```

The package is written to `output\packages\remotecodex-<version>.zip`. It excludes local runtime state such as `.env`, `.remotecodex`, `node_modules`, and logs.

On the second PC:

```powershell
Expand-Archive .\remotecodex-<version>.zip C:\repos\remotegpt
cd C:\repos\remotegpt
.\install-remotecodex.bat -HostId pc2 -DefaultOwnerHostId pc2 -RegisterStartup
notepad .env
scripts\start-remotecodex.bat
```

Edit `.env` before starting if `DISCORD_TOKEN` or `DISCORD_GUILD_ID` still contains placeholder values.

## Verification

- Build: `./node_modules/.bin/tsc -p tsconfig.json`
- Tests: `./node_modules/.bin/vitest run`

If Vitest fails during startup with missing native bindings such as `@rolldown/binding-linux-x64-gnu` or the wrong `esbuild` package for the current platform, remove `node_modules` and reinstall dependencies on the same platform where the commands will run.
