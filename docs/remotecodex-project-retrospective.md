# RemoteCodex Project Retrospective

Last updated: 2026-06-16

RemoteCodex was an experimental Discord bridge for local Windows Codex sessions. Its original purpose was to make a local Codex session usable from Discord before official multi-device Codex remote access was available.

As of 2026-06-16, the practical direction has changed. The official ChatGPT app can now connect to multiple PC Codex instances, and direct JSONL/session-file manipulation appears to be blocked or no longer reliable. RemoteCodex should therefore be treated as a legacy experiment and possible foundation for a future personal operations console, not as the primary Codex remote path.

## Current Status

- Primary Codex remote path: official ChatGPT app multi-PC Codex connection.
- RemoteCodex status: legacy/experimental.
- Recommended use of this repository: reference implementation, historical record, or future Discord-based personal ops bot.
- Not recommended: continuing to rely on Codex JSONL tailing or direct session file mutation as a core integration strategy.

## Original Goal

The initial goal was to use Discord as a near-equivalent remote chat surface for Windows Codex:

- Map one Discord channel to one local Windows Codex session.
- Forward Discord messages to Codex through the local Codex CLI.
- Reflect Codex responses back into Discord.
- Allow local Codex-created sessions to create Discord channels.
- Keep the initial scope chat-only.
- Defer non-chat Codex features.
- Skip serious security hardening because the target was a private Discord server.

Later, the goal expanded to:

- Multi-PC host routing for `pc1` and `pc2`.
- Heartbeat visibility.
- Discord command-channel operations.
- Packaging and self-update.
- Image attachment forwarding.
- Experimental use as a possible personal-site operations console.

## Timeline

### 2026-05-07 to 2026-05-11: Requirements and Discord Verification

The project began as a Windows Codex to Discord bridge concept.

Major decisions from this phase:

- Discord channels represent Codex sessions.
- Channel creation from Discord would not remain a core feature.
- Codex session creation should belong to Windows Codex.
- Discord channel deletion can archive or deactivate the mapped session.
- Chat was the only required Codex feature for the first version.
- Webhook rendering was used to make migrated user/assistant history feel closer to real Discord conversation.

Important lessons:

- Discord can act as a decent chat surface, but exact identity mirroring is limited.
- User messages can be approximated with webhooks, but they are still not truly sent by the user account.
- Streaming commentary and final answers need separate handling to avoid duplicates.
- Directly tailing Codex JSONL is powerful but fragile.

### 2026-05-12: Initial MVP

Commit:

```text
75f3ffb Initial RemoteCodex MVP
```

This established the first working structure:

- Discord bot gateway.
- Session bridge.
- Codex CLI resume integration.
- Session mapping state.
- Transcript migration/tailing.
- Basic Windows-oriented setup.

The project shape became:

- `src/bridge.ts`: Discord message to Codex routing.
- `src/codexCli.ts`: Codex CLI adapter.
- `src/discordBot.ts`: Discord adapter.
- `src/transcriptTailer.ts`: Codex session JSONL tailing.
- `.remotecodex/sessions.json`: local mapping state.

### 2026-05-12: Discord-Driven Session Creation Removed

Commit:

```text
22409b0 Remove Discord-driven Codex session creation
```

The design changed so Discord no longer creates Codex sessions automatically.

Reason:

- Codex-side session creation from Discord was unreliable.
- It also blurred responsibility between Windows Codex and RemoteCodex.
- The safer model was: create sessions in Windows Codex, then bind/import them into Discord.

Final principle:

```text
Codex owns Codex sessions.
RemoteCodex owns Discord mapping and routing.
```

### 2026-05-13: Packaging, Secrets, and Self-Update

Commits:

```text
b5c45e2 Ignore local secret files
b36ac58 Add Discord-triggered self update
9cd5f1a Bump version to 0.2.0
9fbd11d Report update version transitions
```

This phase focused on making the bot usable across two PCs.

Implemented:

- `_local-secrets` exclusion.
- Deploy key support.
- Zip packaging.
- Git-backed update flow.
- `!version`.
- `!update <hostId|all>`.
- Update completion reporting.

Important design choice:

- A zip-installed host can initialize `.git` once and then keep using Git for future updates.
- `.env`, `_local-secrets`, and `.remotecodex` stay local and are preserved.

Multi-PC model:

- Each PC has its own host id.
- Each session has an owner host.
- If a message is sent to a session owned by an offline host, another host can report that the owner is offline.
- Session histories remain independent per PC.

### 2026-05-14: Duplicate Message Fixes

Commits:

```text
9414b19 Avoid duplicate live session final messages
fa99e99 Restore final answers after live session timeouts
48b3161 Avoid transcript final answer duplicates
9902793 Delay live final answer tailing
```

This was the most delicate part of the bridge.

Problem:

- Codex JSONL records can contain both streamed/final event records and response records for the same assistant output.
- Discord bridge could send the direct Codex CLI response.
- The tailer could also see the final answer in JSONL and send it again.

Fixes introduced:

- Live sessions no longer tail ordinary assistant chat turns.
- Live sessions still use tailing as a repair path when the CLI times out but the final answer appears later in JSONL.
- Fresh live final answers are delayed so the bridge has time to send the primary response first.
- Transcript mappings and live-session mappings use different final-answer policies.

Lesson:

```text
Any bridge that mixes active request/response handling with passive log tailing needs a strict ownership rule for each event type.
```

### 2026-05-28: User Turn Tailing and Image Upload Loop

Commits:

```text
aa513a3 Tail live Codex user turns
6b07070 Prevent repeated image attachment uploads
```

Two issues were addressed.

First, Codex-app-origin user messages were not visible in Discord for live sessions.

Fix:

- Live-session tailing was adjusted to include user turns.
- Regular assistant turns remained excluded to avoid duplicate final responses.

Second, image attachment forwarding entered a retry loop.

Observed behavior:

- A Discord channel received thousands of repeated image attachments.
- Many were project assets or generated report files, not intentional Codex output images.
- When Discord rejected an oversized file, the tailer stopped before saving state.
- Already uploaded images were retried on the next tick.

Fix:

- Generic command output strings are no longer scanned as image payloads.
- Attachment keys are persisted immediately after each successful upload.
- Oversized Discord uploads are recorded as skipped so they are not retried forever.

Lesson:

```text
File attachment automation needs narrow discovery rules and partial-progress persistence. Otherwise one bad file can cause an infinite replay loop.
```

### 2026-06-16: Project Direction Changed

The user reported two important changes:

- Direct JSONL modification/tailing appears to no longer work reliably.
- The official ChatGPT app now supports connecting to multiple PC Codex instances.

Conclusion:

- RemoteCodex is no longer the best path for Codex remote operation.
- The official app should be used for remote Codex control.
- This repository should be preserved as a completed experiment and possible base for a Discord operations bot.

## Final Architecture Snapshot

At the end of the active experiment, RemoteCodex included:

- Discord bot integration.
- Local Codex CLI resume integration.
- Channel-to-session binding.
- Host ownership and heartbeat.
- Command channel.
- Import/bind existing sessions.
- Self-update.
- Windows startup support.
- Packaging for another PC.
- Transcript migration and tailing.
- Limited image attachment forwarding.

Core commands:

```text
!help
!status
!version [hostId]
!update <hostId|all>
!import <hostId> <latest|sessionId>
!bind <hostId> <channelId> <sessionId>
```

## Known Fragile Areas

### Codex JSONL Dependency

The project depends heavily on Codex's local session JSONL format. This is an internal implementation detail, not a stable API.

Fragile behaviors:

- Session storage layout can change.
- Event names can change.
- Direct mutation can be blocked.
- Duplicate event forms can appear.
- CLI output timing can differ from JSONL write timing.

### Discord Identity Approximation

Discord cannot make the bot truly speak as the user's real account. Webhooks can approximate display name and avatar, but they remain webhook messages.

### Attachment Discovery

Automatically discovering image paths from logs is risky.

Safe future rule:

- Only upload explicit Codex-generated artifacts.
- Avoid scanning whole repo output, `public`, `dist`, or `reports` by default.
- Treat large files and repeated assets conservatively.

### Multi-PC Routing

The host ownership model worked, but it is operationally subtle.

The safe model is:

- Each channel/session has one owner host.
- Only the owner host should execute Codex work.
- Other hosts may report owner offline status.
- Heartbeat is advisory, not a distributed consensus system.

## What Worked Well

- Discord channels were a useful mental model for individual Codex sessions.
- Host heartbeat and owner routing were practical for PC1/PC2 usage.
- `!version` and `!update` made cross-PC package management much easier.
- Webhook rendering improved transcript readability.
- The project produced reusable patterns for a future personal automation bot.

## What Did Not Age Well

- Direct JSONL tailing as the core integration.
- Trying to mirror full Codex chat semantics into Discord.
- Automatic image attachment discovery from broad payload scans.
- Treating Discord as a long-term replacement for an official Codex remote client.

## Recommended Future Direction

Do not continue RemoteCodex as the primary Codex remote bridge.

Recommended path:

1. Use the official ChatGPT app for multi-PC Codex remote control.
2. Keep this repository archived or clearly labeled as legacy experimental.
3. Reuse selected parts for a Discord-based personal operations console.

Potential future Discord bot scope:

- Personal homepage deployment.
- Static site status checks.
- GitHub update/deploy commands.
- CloudFront/S3 deployment reporting.
- Scheduled health checks.
- Lightweight notifications from local automation.

The future bot should avoid depending on Codex internals. It can call public CLIs, Git, deployment scripts, or project-specific commands, but it should not tail or mutate Codex session files as a primary mechanism.

## Preservation Notes

Useful code to preserve:

- Discord gateway and command-channel patterns.
- Host heartbeat model.
- Windows startup scripts.
- Packaging and update scripts.
- State file conventions.

Code to treat as historical only:

- JSONL transcript tailing.
- Codex session mutation assumptions.
- Broad image attachment discovery.

## Final Takeaway

RemoteCodex was valuable as an exploration. It proved the Discord workflow, exposed the hard edges of local Codex integration, and produced reusable operational tooling. The right next move is not to fight the official remote path, but to let RemoteCodex become a reference and evolve any surviving pieces into a narrower, more stable personal operations console.
