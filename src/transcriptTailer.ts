import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DiscordGateway, RemoteCodexMapping, SessionStore } from "./types.js";
import { readCodexSessionJsonl } from "./codexSessionReader.js";
import { renderTranscriptChunks, selectTurnsForMigration, type TranscriptRenderableTurn } from "./sessionMigration.js";
import { discoverImageAttachments } from "./imageAttachments.js";

interface TailState {
  channels: Record<string, { sentKeys: string[]; sentAttachmentKeys?: string[]; lastSourceRecordIndex?: number }>;
}

export interface TranscriptTailerOptions {
  statePath?: string;
  intervalMs?: number;
  speakerLabels?: {
    user?: string;
    assistant?: string;
  };
  onError?: (error: unknown) => void;
  onDebug?: (message: string, details?: Record<string, unknown>) => void;
}

export class TranscriptTailer {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  constructor(
    private readonly store: SessionStore,
    private readonly discord: DiscordGateway,
    private readonly options: TranscriptTailerOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.tickInProgress) {
      this.options.onDebug?.("Transcript tailer tick skipped because previous tick is still running");
      return;
    }
    this.tickInProgress = true;
    try {
      await this.tickOnce();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const mappings = (await this.store.list()).filter(isTailableMapping);
    await this.pruneStateToActiveChannels(mappings.map((mapping) => mapping.discordChannelId));
    for (const mapping of mappings) {
      try {
        await this.syncMapping(mapping);
      } catch (error) {
        if (isUnknownDiscordChannelError(error)) {
          await this.archiveMissingDiscordChannel(mapping);
          continue;
        }
        if (isMissingSourceSessionError(error)) {
          continue;
        }
        this.options.onError?.(error);
      }
    }
  }

  private async syncMapping(mapping: RemoteCodexMapping): Promise<void> {
    if (!mapping.sourceSessionPath) {
      return;
    }

    const state = await this.readState();
    const channelState = state.channels[mapping.discordChannelId] ?? { sentKeys: [] };
    const sentKeys = new Set(channelState.sentKeys);
    const sentAttachmentKeys = new Set(channelState.sentAttachmentKeys ?? []);
    const existingDiscordContents = new Set<string>();
    let latestHumanAvatarUrl: string | undefined;
    const startedAt = Date.now();
    this.options.onDebug?.("Transcript tailer sync started", {
      channelId: mapping.discordChannelId,
      codexSessionId: mapping.codexSessionId,
      mappingKind: mapping.mappingKind,
      sourceSessionPath: mapping.sourceSessionPath,
      sentKeyCount: sentKeys.size,
      sentAttachmentKeyCount: sentAttachmentKeys.size,
      lastSourceRecordIndex: channelState.lastSourceRecordIndex,
    });
    let fetchedMessageCount = 0;
    let fetchedHumanMessageCount = 0;
    if (this.discord.fetchChannelMessages) {
      for (const message of await this.discord.fetchChannelMessages(mapping.discordChannelId)) {
        fetchedMessageCount += 1;
        sentKeys.add(messageKey(message.username, message.content));
        if ((message.webhook || (!message.bot && !message.webhook)) && message.username === userSpeakerLabel(this.options)) {
          sentKeys.add(turnMessageKey("user", message.content));
        } else if (message.bot && !message.webhook) {
          sentKeys.add(turnMessageKey("assistant", message.content));
        }
        if (!message.bot && !message.webhook) {
          fetchedHumanMessageCount += 1;
          existingDiscordContents.add(normalizeContent(message.content));
          latestHumanAvatarUrl = message.avatarUrl ?? latestHumanAvatarUrl;
        }
      }
    }
    latestHumanAvatarUrl ??= await this.discord.fetchLatestHumanAvatarUrl?.();
    this.options.onDebug?.("Transcript tailer channel snapshot loaded", {
      channelId: mapping.discordChannelId,
      fetchedMessageCount,
      fetchedHumanMessageCount,
      hasLatestHumanAvatarUrl: Boolean(latestHumanAvatarUrl),
      latestHumanAvatarUrl,
    });

    const history = await readCodexSessionJsonl(mapping.sourceSessionPath);
    const rawRecords = await readRawRecordsAfter(mapping.sourceSessionPath, channelState.lastSourceRecordIndex);
    let changed = false;
    const allTurns = selectTurnsForMigration(history).filter(isTranscriptChatTurn);
    const chatTurns =
      channelState.lastSourceRecordIndex === undefined
        ? allTurns
        : allTurns.filter((turn) => turn.sourceRecordIndex > channelState.lastSourceRecordIndex!);
    const turns = mapping.mappingKind === "live_session" ? [] : chatTurns;
    const streamTurns = rawRecords
      .map(({ record, sourceRecordIndex }) => streamTurnFromRawRecord(record, sourceRecordIndex))
      .filter((turn): turn is TranscriptRenderableTurn => Boolean(turn));
    const pendingTurns = [...turns, ...streamTurns].sort(
      (left, right) => left.sourceRecordIndex - right.sourceRecordIndex || left.sourceSequenceIndex - right.sourceSequenceIndex,
    );
    let sentMessageCount = 0;
    let skippedSentKeyCount = 0;
    let skippedDiscordEchoCount = 0;
    let sentAttachmentCount = 0;
    let skippedAttachmentKeyCount = 0;
    let maxSourceRecordIndex = channelState.lastSourceRecordIndex ?? -1;
    this.options.onDebug?.("Transcript tailer history loaded", {
      channelId: mapping.discordChannelId,
      codexSessionId: mapping.codexSessionId,
      totalChatTurnCount: allTurns.length,
      pendingChatTurnCount: turns.length,
      historySourceRecordMax: allTurns.at(-1)?.sourceRecordIndex,
    });
    if (this.discord.sendFiles) {
      const attachments = await discoverImageAttachments({
        textFragments: turns.filter((turn) => turn.speakerRole === "assistant").map((turn) => turn.textualContent),
        rawRecords: rawRecords.map((item) => item.record),
        sourceSessionPath: mapping.sourceSessionPath,
        sourceSessionId: mapping.codexSessionId,
        mappingCreatedAt: mapping.createdAt,
      });
      this.options.onDebug?.("Transcript tailer image attachments discovered", {
        channelId: mapping.discordChannelId,
        codexSessionId: mapping.codexSessionId,
        discoveredAttachmentCount: attachments.length,
        discoveredAttachments: attachments.map((attachment) => ({
          path: attachment.path,
          source: attachment.source,
          alreadySent: sentAttachmentKeys.has(attachment.key),
        })),
      });
      for (const attachment of attachments) {
        if (sentAttachmentKeys.has(attachment.key)) {
          skippedAttachmentKeyCount += 1;
          continue;
        }
        await withDiscordTimeout(
          this.discord.sendFiles(mapping.discordChannelId, [attachment.path]),
          "send image attachment",
        );
        sentAttachmentKeys.add(attachment.key);
        changed = true;
        sentAttachmentCount += 1;
      }
    }
    for (const turn of pendingTurns) {
      maxSourceRecordIndex = Math.max(maxSourceRecordIndex, turn.sourceRecordIndex);
      for (const chunk of renderTranscriptChunks(turn, mapping.transcriptId ?? "transcript", "codex_full_transcript", {
        speakerLabels: {
          user: this.options.speakerLabels?.user ?? process.env.REMOTE_CODEX_USER_LABEL ?? "User",
          assistant: this.options.speakerLabels?.assistant ?? process.env.REMOTE_CODEX_CODEX_LABEL ?? "Codex",
        },
      })) {
        const key = turnMessageKey(turn.speakerRole, chunk.content);
        if (sentKeys.has(key)) {
          skippedSentKeyCount += 1;
          continue;
        }
        if (mapping.chatEnabled && turn.speakerRole === "user" && existingDiscordContents.has(normalizeContent(chunk.content))) {
          sentKeys.add(key);
          changed = true;
          skippedDiscordEchoCount += 1;
          continue;
        }
        if (turn.speakerRole === "assistant") {
          await withDiscordTimeout(this.discord.sendMessage(mapping.discordChannelId, chunk.content), "send assistant message");
        } else if (this.discord.sendWebhookMessage) {
          const avatarUrl = latestHumanAvatarUrl ?? chunk.avatarUrl;
          this.options.onDebug?.("Transcript tailer sending webhook message", {
            channelId: mapping.discordChannelId,
            codexSessionId: mapping.codexSessionId,
            username: chunk.username,
            hasAvatarUrl: Boolean(avatarUrl),
            avatarUrl,
          });
          await withDiscordTimeout(
            this.discord.sendWebhookMessage(mapping.discordChannelId, {
              username: chunk.username,
              content: chunk.content,
              avatarUrl,
            }),
            "send webhook message",
          );
        } else {
          continue;
        }
        sentKeys.add(key);
        changed = true;
        sentMessageCount += 1;
      }
    }

    const nextLastSourceRecordIndex = Math.max(
      maxSourceRecordIndex,
      allTurns.at(-1)?.sourceRecordIndex ?? -1,
      rawRecords.at(-1)?.sourceRecordIndex ?? -1,
    );
    const compactedSentKeys = compactSentKeys(sentKeys);
    if (
      changed ||
      !state.channels[mapping.discordChannelId] ||
      channelState.lastSourceRecordIndex !== nextLastSourceRecordIndex ||
      compactedSentKeys.length !== channelState.sentKeys.length
    ) {
      state.channels[mapping.discordChannelId] = {
        sentKeys: compactedSentKeys,
        sentAttachmentKeys: [...sentAttachmentKeys],
        lastSourceRecordIndex: nextLastSourceRecordIndex >= 0 ? nextLastSourceRecordIndex : undefined,
      };
      await this.writeState(state);
    }
    this.options.onDebug?.("Transcript tailer sync finished", {
      channelId: mapping.discordChannelId,
      codexSessionId: mapping.codexSessionId,
      durationMs: Date.now() - startedAt,
      sentMessageCount,
      sentAttachmentCount,
      skippedSentKeyCount,
      skippedDiscordEchoCount,
      skippedAttachmentKeyCount,
      nextLastSourceRecordIndex,
    });
  }

  private async readState(): Promise<TailState> {
    try {
      return JSON.parse(await readFile(this.statePath(), "utf8")) as TailState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { channels: {} };
      }
      throw error;
    }
  }

  private async writeState(state: TailState): Promise<void> {
    const path = this.statePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf8");
  }

  private async pruneStateToActiveChannels(activeChannelIds: string[]): Promise<void> {
    const state = await this.readState();
    const active = new Set(activeChannelIds);
    const channels = Object.fromEntries(Object.entries(state.channels).filter(([channelId]) => active.has(channelId)));
    if (Object.keys(channels).length !== Object.keys(state.channels).length) {
      await this.writeState({ channels });
    }
  }

  private statePath(): string {
    return this.options.statePath ?? process.env.REMOTE_CODEX_TRANSCRIPT_TAIL_STATE_PATH ?? ".remotecodex/transcript-tail.json";
  }

  private async archiveMissingDiscordChannel(mapping: RemoteCodexMapping): Promise<void> {
    const mappings = await this.store.list();
    const archivedAt = new Date().toISOString();
    await this.store.saveAll(
      mappings.map((current) =>
        current.discordChannelId === mapping.discordChannelId && current.codexSessionId === mapping.codexSessionId
          ? {
              ...current,
              mappingState: "archived",
              archivedAt: current.archivedAt ?? archivedAt,
              terminationMode: current.terminationMode ?? "delete",
            }
          : current,
      ),
    );
  }
}

function isTailableMapping(mapping: RemoteCodexMapping): boolean {
  return (
    mapping.mappingState === "active" &&
    Boolean(mapping.sourceSessionPath) &&
    (mapping.mappingKind === "transcript" || (mapping.mappingKind === "live_session" && mapping.origin === "codex"))
  );
}

function messageKey(username: string, content: string): string {
  return hashedMessageKey("discord", username, content);
}

function userSpeakerLabel(options: TranscriptTailerOptions): string {
  return options.speakerLabels?.user ?? process.env.REMOTE_CODEX_USER_LABEL ?? "User";
}

function turnMessageKey(speakerRole: string, content: string): string {
  return hashedMessageKey("turn", speakerRole, content);
}

function normalizeContent(content: string): string {
  return content.trim();
}

function hashedMessageKey(namespace: string, author: string, content: string): string {
  const digest = createHash("sha256").update(normalizeContent(content)).digest("base64url");
  return `${namespace}:${author}:${digest}`;
}

function compactSentKeys(sentKeys: Set<string>): string[] {
  return [...sentKeys].filter((key) => key.startsWith("discord:") || key.startsWith("turn:")).slice(-500);
}

async function withDiscordTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  const timeoutMs = Number(process.env.REMOTE_CODEX_DISCORD_SEND_TIMEOUT_MS ?? 15000);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Discord operation timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isTranscriptChatTurn(turn: { speakerRole: string }): boolean {
  return turn.speakerRole === "user" || turn.speakerRole === "assistant";
}

async function readRawRecordsAfter(
  filePath: string,
  lastSourceRecordIndex: number | undefined,
): Promise<Array<{ sourceRecordIndex: number; record: unknown }>> {
  const minIndex = lastSourceRecordIndex === undefined ? 0 : lastSourceRecordIndex + 1;
  const records: Array<{ sourceRecordIndex: number; record: unknown }> = [];
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index < minIndex || !line.trim()) {
      return;
    }
    try {
      records.push({ sourceRecordIndex: index, record: JSON.parse(line) });
    } catch {
      return;
    }
  });
  return records;
}

function streamTurnFromRawRecord(record: unknown, sourceRecordIndex: number): TranscriptRenderableTurn | null {
  const current = objectValue(record);
  if (current?.type !== "event_msg") {
    return null;
  }
  const payload = objectValue(current.payload);
  if (payload?.type !== "agent_message") {
    return null;
  }
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return null;
  }
  const phase = typeof payload.phase === "string" ? payload.phase : "";
  return {
    logicalTurnKind: "source_turn",
    speakerRole: "assistant",
    textualContent: phase === "final_answer" ? message : `${message}\n\u200B`,
    sourceSequenceIndex: sourceRecordIndex,
    sourceRecordIndex,
    omittedAttachmentContent: false,
    preserveTextFormatting: true,
  };
}

function isUnknownDiscordChannelError(error: unknown): boolean {
  return hasErrorCode(error, 10003);
}

function isMissingSourceSessionError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string | number): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
