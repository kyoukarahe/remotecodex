import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionBridge } from "./bridge.js";
import { CodexSessionMigrationService, type SessionMigrationOptions } from "./sessionMigration.js";
import { createDiscordClient, DiscordJsGateway } from "./discordBot.js";
import { JsonFileSessionStore } from "./store.js";
import type { CodexGateway } from "./types.js";

class NoopCodexGateway implements CodexGateway {
  async archiveSession(): Promise<void> {
    throw new Error("Migration CLI does not archive live Codex sessions");
  }

  async sendMessage(): Promise<string> {
    throw new Error("Migration CLI does not forward chat messages");
  }
}

const args = parseArgs(process.argv.slice(2));
const token = requiredEnv("DISCORD_TOKEN");
const guildId = requiredEnv("DISCORD_GUILD_ID");
const statePath = process.env.REMOTE_CODEX_STATE_PATH ?? ".remotecodex/sessions.json";

const filePath = args.file ?? (args.latest ? await findLatestCodexSessionFile() : undefined);
if (!filePath) {
  throw new Error("Provide --file <session.jsonl> or --latest");
}
if (!existsSync(filePath)) {
  throw new Error(`Codex session file does not exist: ${filePath}`);
}

const client = createDiscordClient({
  messageContentIntent: true,
});
const discord = new DiscordJsGateway(client, guildId);
const bridge = new SessionBridge(discord, new NoopCodexGateway(), new JsonFileSessionStore(statePath), {
  streamingEnabled: false,
});
const migration = new CodexSessionMigrationService(bridge, discord);

try {
  await client.login(token);
  await onceReady(client);

  const options: SessionMigrationOptions = {
    mode: args.recent15Approved ? "recent15Pairs" : "fullHistory",
    approvedRecent15PairsFallback: args.recent15Approved,
    attachmentOmissionSemantic: args.attachmentMarkers ? "represented_by_absence_marker" : undefined,
    speakerLabels: {
      user: args.userName,
      assistant: args.codexName,
    },
  };
  const result = await migration.migrateFile(filePath, options);

  console.log(
    JSON.stringify(
      {
        ok: true,
        filePath,
        channelId: result.mapping.discordChannelId,
        transcriptId: result.transcriptId,
        transcriptKind: result.transcriptKind,
        completenessStatus: result.completenessStatus,
        migratedTurns: result.migratedTurns,
        discordMessagesSent: result.discordMessagesSent,
      },
      null,
      2,
    ),
  );
} finally {
  client.destroy();
}

function parseArgs(values: string[]): {
  file?: string;
  latest: boolean;
  recent15Approved: boolean;
  attachmentMarkers: boolean;
  userName: string;
  codexName: string;
} {
  const parsed = {
    file: undefined as string | undefined,
    latest: false,
    recent15Approved: false,
    attachmentMarkers: false,
    userName: "User",
    codexName: "Codex",
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--file") {
      parsed.file = values[index + 1];
      index += 1;
      continue;
    }
    if (value === "--latest") {
      parsed.latest = true;
      continue;
    }
    if (value === "--recent15-approved") {
      parsed.recent15Approved = true;
      continue;
    }
    if (value === "--attachment-markers") {
      parsed.attachmentMarkers = true;
      continue;
    }
    if (value === "--user-name") {
      parsed.userName = values[index + 1];
      index += 1;
      continue;
    }
    if (value === "--codex-name") {
      parsed.codexName = values[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return parsed;
}

async function findLatestCodexSessionFile(): Promise<string> {
  const sessionsDir = join(requiredEnv("USERPROFILE"), ".codex", "sessions");
  const files = await listJsonlFiles(sessionsDir);
  const newest = files
    .map((filePath) => ({ filePath, mtimeMs: existsSync(filePath) ? statMtimeMs(filePath) : 0 }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!newest) {
    throw new Error(`No Codex session JSONL files found under ${sessionsDir}`);
  }
  return newest.filePath;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsonlFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

function statMtimeMs(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).mtimeMs : 0;
}

function onceReady(client: { once: (event: "ready", listener: () => void) => void; isReady: () => boolean }): Promise<void> {
  if (client.isReady()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => client.once("ready", resolve));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
