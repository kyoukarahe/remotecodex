import "dotenv/config";
import { Events } from "discord.js";
import { SessionBridge } from "./bridge.js";
import { CodexCliGateway } from "./codexCli.js";
import { CodexSessionIndexWatcher } from "./codexSessionIndex.js";
import { RemoteCodexCommandHandler } from "./commandHandler.js";
import { createDiscordClient, DiscordJsGateway, wireDiscordEvents } from "./discordBot.js";
import { JsonFileSessionStore } from "./store.js";
import { TranscriptTailer } from "./transcriptTailer.js";

const token = requiredEnv("DISCORD_TOKEN");
const guildId = requiredEnv("DISCORD_GUILD_ID");
const statePath = process.env.REMOTE_CODEX_STATE_PATH ?? ".remotecodex/sessions.json";
const debugEnabled = process.env.REMOTE_CODEX_DEBUG === "true";
const heartbeatIntervalMs = Number(process.env.REMOTE_CODEX_HEARTBEAT_INTERVAL_MS ?? 10000);
const hostId = process.env.REMOTE_CODEX_HOST_ID ?? process.env.COMPUTERNAME ?? "default-host";
const commandChannelName = process.env.REMOTE_CODEX_COMMAND_CHANNEL_NAME ?? "remote-codex-hosts";

const client = createDiscordClient({
  messageContentIntent: true,
});
const discord = new DiscordJsGateway(client, guildId);
const codex = new CodexCliGateway();
const store = new JsonFileSessionStore(statePath);
const bridge = new SessionBridge(discord, codex, store, {
  streamingEnabled: false,
  hostId,
});
const watcher = new CodexSessionIndexWatcher(bridge, {
  intervalMs: Number(process.env.CODEX_SESSION_POLL_INTERVAL_MS ?? 5000),
  syncExistingOnStart: false,
  syncSubagents: false,
  onError: (error) => console.error("Codex session watcher failed", error),
  onDebug: (message, details) => console.log(message, details ?? ""),
});
const transcriptTailer = new TranscriptTailer(store, discord, {
  intervalMs: Number(process.env.REMOTE_CODEX_TRANSCRIPT_TAIL_INTERVAL_MS ?? 5000),
  onError: (error) => console.error("Transcript tailer failed", error),
  onDebug: debugEnabled ? (message, details) => console.log(message, details ?? "") : undefined,
});
const commandHandler = new RemoteCodexCommandHandler(bridge, discord, hostId);

wireDiscordEvents(client, bridge, {
  guildId,
  commandChannelName,
  onCommand: (channelId, content, authorIsBot) => commandHandler.handle(channelId, content, authorIsBot),
});

client.once(Events.ClientReady, async () => {
  console.log(`RemoteCodex connected as ${client.user?.tag ?? "unknown bot"}`);
  console.log("RemoteCodex host configuration", {
    hostId,
    defaultOwnerHostId: process.env.REMOTE_CODEX_DEFAULT_OWNER_HOST_ID,
    commandChannelName,
    syncExistingOnStart: false,
    syncSubagents: false,
  });
  await bridge.publishHeartbeat();
  const heartbeatTimer = setInterval(() => {
    void bridge.publishHeartbeat();
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  await watcher.start();
  await transcriptTailer.start();
});

await client.login(token);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
