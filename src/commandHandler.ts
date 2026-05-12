import { resolveIndexedCodexSession } from "./codexSessionIndex.js";
import type { DiscordGateway } from "./types.js";
import { SessionBridge, sanitizeChannelName } from "./bridge.js";

export class RemoteCodexCommandHandler {
  constructor(
    private readonly bridge: SessionBridge,
    private readonly discord: DiscordGateway,
    private readonly hostId: string,
  ) {}

  async handle(channelId: string, content: string, authorIsBot: boolean): Promise<void> {
    if (authorIsBot) {
      return;
    }
    const trimmed = content.trim();
    if (!trimmed.startsWith("!")) {
      return;
    }

    const [command, ...args] = trimmed.slice(1).split(/\s+/);
    switch (command.toLowerCase()) {
      case "help":
        await this.reply(channelId, commandHelp());
        return;
      case "status":
        await this.status(channelId);
        return;
      case "import":
        await this.importSession(channelId, args);
        return;
      case "new":
        await this.newSession(channelId, args);
        return;
      case "bind":
        await this.bind(channelId, args);
        return;
      default:
        await this.reply(channelId, `Unknown command: !${command}\n\n${commandHelp()}`);
    }
  }

  private async status(channelId: string): Promise<void> {
    const heartbeats = (await this.discord.listHostHeartbeats?.()) ?? [];
    if (heartbeats.length === 0) {
      await this.reply(channelId, "No RemoteCodex hosts are reporting heartbeat.");
      return;
    }
    await this.reply(
      channelId,
      heartbeats
        .sort((left, right) => left.hostId.localeCompare(right.hostId))
        .map((heartbeat) => `${heartbeat.hostId}: ${formatKst(heartbeat.lastSeenAt)}`)
        .join("\n"),
    );
  }

  private async importSession(channelId: string, args: string[]): Promise<void> {
    const [targetHostId, reference = "latest"] = args;
    if (!targetHostId) {
      await this.reply(channelId, "Usage: !import <hostId> <latest|sessionId>");
      return;
    }
    if (targetHostId !== this.hostId) {
      await this.replyIfOffline(channelId, targetHostId);
      return;
    }

    const session = await resolveIndexedCodexSession(reference);
    if (!session) {
      await this.reply(channelId, `No Codex session found for: ${reference}`);
      return;
    }
    await this.bridge.handleCodexSessionCreated(session.id, session.threadName, session.storagePath ?? null);
    await this.reply(channelId, `Imported ${session.id} as ${sanitizeChannelName(session.threadName)}.`);
  }

  private async newSession(channelId: string, args: string[]): Promise<void> {
    const [targetHostId, ...rest] = args;
    if (!targetHostId || rest.length === 0) {
      await this.reply(channelId, "Usage: !new <hostId> <cwd>");
      return;
    }
    if (targetHostId !== this.hostId) {
      await this.replyIfOffline(channelId, targetHostId);
      return;
    }

    const cwd = rest.join(" ");
    const label = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "codex-session";
    const mapping = await this.bridge.createLocalSessionFromCommand({ label, cwd });
    await this.reply(channelId, `Created ${mapping.codexSessionId} in channel ${mapping.discordChannelId}.`);
  }

  private async bind(channelId: string, args: string[]): Promise<void> {
    const [targetHostId, targetChannelId, sessionId] = args;
    if (!targetHostId || !targetChannelId || !sessionId) {
      await this.reply(channelId, "Usage: !bind <hostId> <channelId> <sessionId>");
      return;
    }
    if (targetHostId !== this.hostId) {
      await this.replyIfOffline(channelId, targetHostId);
      return;
    }

    const session = await resolveIndexedCodexSession(sessionId);
    await this.bridge.bindExistingSession({
      channelId: targetChannelId,
      sessionId,
      sourceSessionPath: session?.storagePath ?? null,
      label: session?.threadName,
    });
    await this.reply(channelId, `Bound ${targetChannelId} to ${sessionId}.`);
  }

  private async replyIfOffline(channelId: string, targetHostId: string): Promise<void> {
    if (!(await this.bridge.isRemoteHostOnline(targetHostId))) {
      await this.reply(channelId, `${targetHostId} is offline.`);
    }
  }

  private async reply(channelId: string, content: string): Promise<void> {
    await this.discord.sendMessage(channelId, content);
  }
}

function commandHelp(): string {
  return [
    "RemoteCodex commands:",
    "!status",
    "!import <hostId> <latest|sessionId>",
    "!new <hostId> <cwd>",
    "!bind <hostId> <channelId> <sessionId>",
  ].join("\n");
}

function formatKst(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  const hours = String(kst.getUTCHours()).padStart(2, "0");
  const minutes = String(kst.getUTCMinutes()).padStart(2, "0");
  const seconds = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;
}
