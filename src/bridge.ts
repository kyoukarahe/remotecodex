import type {
  ChannelBindingMetadata,
  CodexGateway,
  CodexStreamEvent,
  DiscordGateway,
  HostHeartbeat,
  RemoteCodexMapping,
  SessionStore,
} from "./types.js";

export interface SessionBridgeOptions {
  streamingEnabled?: boolean;
  typingIndicatorIntervalMs?: number;
  hostId?: string;
  hostLabel?: string;
  defaultOwnerHostId?: string;
  offlineResponseTemplate?: string;
  ownerHeartbeatTtlMs?: number;
  now?: () => Date;
}

export class SessionBridge {
  private readonly streamingEnabled: boolean;
  private readonly typingIndicatorIntervalMs: number;
  private readonly hostId: string;
  private readonly hostLabel: string;
  private readonly defaultOwnerHostId: string;
  private readonly offlineResponseTemplate: string;
  private readonly ownerHeartbeatTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly discord: DiscordGateway,
    private readonly codex: CodexGateway,
    private readonly store: SessionStore,
    options: SessionBridgeOptions = {},
  ) {
    this.streamingEnabled = options.streamingEnabled ?? false;
    this.typingIndicatorIntervalMs = options.typingIndicatorIntervalMs ?? 8000;
    this.hostId = options.hostId ?? process.env.REMOTE_CODEX_HOST_ID ?? hostnameFallback();
    this.hostLabel = options.hostLabel ?? this.hostId;
    this.defaultOwnerHostId =
      options.defaultOwnerHostId ?? process.env.REMOTE_CODEX_DEFAULT_OWNER_HOST_ID ?? this.hostId;
    this.offlineResponseTemplate =
      options.offlineResponseTemplate ??
      process.env.REMOTE_CODEX_OFFLINE_RESPONSE_TEMPLATE ??
      "This session belongs to host {hostId}, which is currently offline.";
    this.ownerHeartbeatTtlMs = options.ownerHeartbeatTtlMs ?? Number(process.env.REMOTE_CODEX_HEARTBEAT_TTL_MS ?? 30000);
    this.now = options.now ?? (() => new Date());
  }

  async handleCodexSessionCreated(
    sessionId: string,
    label = `codex-${sessionId.slice(0, 8)}`,
    sourceSessionPath: string | null = null,
  ): Promise<RemoteCodexMapping> {
    const existing = await this.findActiveLiveSession(sessionId);
    if (existing) {
      return existing;
    }

    const channel = await this.discord.createSessionChannel(sanitizeChannelName(label), { ownerHostId: this.hostId });
    const mapping = await this.addMapping({
      mappingKind: "live_session",
      discordChannelId: channel.id,
      codexSessionId: sessionId,
      transcriptId: null,
      sourceSessionPath,
      origin: "codex",
      ownerHostId: this.hostId,
    });
    await this.writeBinding(mapping, "active");
    return mapping;
  }

  async handleTranscriptCreated(input: {
    transcriptId: string;
    sourceSessionId: string;
    sourceSessionPath?: string;
    label?: string;
  }): Promise<RemoteCodexMapping> {
    const existing = await this.findActiveTranscript(input.transcriptId);
    if (existing) {
      return existing;
    }

    const channel = await this.discord.createSessionChannel(
      sanitizeChannelName(input.label ?? `transcript-${input.sourceSessionId.slice(0, 8)}`),
      { ownerHostId: this.hostId },
    );
    const mapping = await this.addMapping({
      mappingKind: "transcript",
      discordChannelId: channel.id,
      codexSessionId: input.sourceSessionId,
      transcriptId: input.transcriptId,
      sourceSessionPath: input.sourceSessionPath ?? null,
      origin: "codex",
      chatEnabled: false,
      lifecycleSyncEnabled: false,
      ownerHostId: this.hostId,
    });
    await this.writeBinding(mapping, "active");
    return mapping;
  }

  async bindExistingSession(input: {
    channelId: string;
    sessionId: string;
    sourceSessionPath?: string | null;
    label?: string;
  }): Promise<RemoteCodexMapping> {
    const mapping = await this.addMapping({
      mappingKind: "live_session",
      discordChannelId: input.channelId,
      codexSessionId: input.sessionId,
      transcriptId: null,
      sourceSessionPath: input.sourceSessionPath ?? null,
      origin: "codex",
      ownerHostId: this.hostId,
    });
    await this.writeBinding(mapping, "active");
    return mapping;
  }

  async handleDiscordChannelDeleted(channelId: string): Promise<void> {
    const mapping = await this.findActiveByChannel(channelId);
    if (!mapping) {
      return;
    }

    if (mapping.mappingKind === "live_session") {
      await this.codex.archiveSession(mapping.codexSessionId);
    }
    await this.markArchived(mapping, "delete");
    await this.writeBinding(mapping, "archived");
  }

  async handleCodexSessionArchived(sessionId: string): Promise<void> {
    const mapping = await this.findActiveLiveSession(sessionId);
    if (!mapping) {
      return;
    }

    await this.discord.deleteChannel(mapping.discordChannelId);
    await this.markArchived(mapping, "archive");
    await this.writeBinding(mapping, "archived");
  }

  async handleDiscordMessage(channelId: string, authorIsBot: boolean, content: string): Promise<void> {
    if (authorIsBot || content.trim().length === 0) {
      return;
    }

    let mapping = await this.findActiveByChannel(channelId);
    let binding = await this.discord.readChannelBinding?.(channelId);
    if (!binding) {
      binding = await this.bindingFromChannel(channelId);
    }
    const resolvedOwnerHostId = binding?.ownerHostId ?? mapping?.ownerHostId ?? this.hostId;
    if (resolvedOwnerHostId !== this.hostId) {
      if (!(await this.isHostOnline(resolvedOwnerHostId))) {
        await this.discord.sendMessage(channelId, this.renderOfflineResponse(resolvedOwnerHostId));
      }
      return;
    }
    if (!mapping && binding?.codexSessionId) {
      mapping = await this.addMapping({
        mappingKind: binding.mappingKind,
        discordChannelId: channelId,
        codexSessionId: binding.codexSessionId,
        transcriptId: binding.transcriptId ?? null,
        sourceSessionPath: null,
        origin: "discord",
        ownerHostId: this.hostId,
      });
    }
    if (!mapping) {
      return;
    }
    if (!mapping.chatEnabled) {
      return;
    }

    const stopTyping = this.startTypingIndicator(channelId);
    const streamedContents = new Set<string>();
    const sendOptions =
      mapping.mappingKind === "live_session"
        ? {
            sourceSessionPath: mapping.sourceSessionPath,
            onEvent: async (event: CodexStreamEvent) => {
              const rendered = renderCodexStreamEvent(event);
              if (!rendered || streamedContents.has(normalizeStreamContent(rendered))) {
                return;
              }
              streamedContents.add(normalizeStreamContent(rendered));
              await this.discord.sendMessage(channelId, rendered);
            },
          }
        : { sourceSessionPath: mapping.sourceSessionPath };
    let response: string;
    try {
      response = await this.codex.sendMessage(mapping.codexSessionId, content, sendOptions);
    } finally {
      stopTyping();
    }
    if (mapping.mappingKind === "transcript") {
      return;
    }
    if (response.trim().length > 0 && !streamedContents.has(normalizeStreamContent(response))) {
      await this.discord.sendMessage(channelId, response);
    }
  }

  async listActiveMappings(): Promise<RemoteCodexMapping[]> {
    return (await this.store.list()).filter((mapping) => mapping.mappingState === "active");
  }

  async publishHeartbeat(): Promise<void> {
    const heartbeat: HostHeartbeat = {
      hostId: this.hostId,
      label: this.hostLabel,
      lastSeenAt: this.now().toISOString(),
    };
    await this.discord.publishHostHeartbeat?.(heartbeat);
  }

  private async addMapping(input: {
    mappingKind: "live_session" | "transcript";
    discordChannelId: string;
    codexSessionId: string;
    transcriptId: string | null;
    sourceSessionPath: string | null;
    origin: "discord" | "codex";
    chatEnabled?: boolean;
    lifecycleSyncEnabled?: boolean;
    ownerHostId?: string;
  }): Promise<RemoteCodexMapping> {
    const mappings = await this.store.list();
    const existing = mappings.find(
      (mapping) =>
        mapping.discordChannelId === input.discordChannelId &&
        mapping.codexSessionId === input.codexSessionId &&
        mapping.mappingState === "active",
    );
    if (existing) {
      return existing;
    }
    const mapping: RemoteCodexMapping = {
      mappingKind: input.mappingKind,
      discordChannelId: input.discordChannelId,
      codexSessionId: input.codexSessionId,
      transcriptId: input.transcriptId,
      sourceSessionPath: input.sourceSessionPath,
      mappingState: "active",
      origin: input.origin,
      chatEnabled: input.chatEnabled ?? true,
      streamingEnabled: this.streamingEnabled,
      lifecycleSyncEnabled: input.lifecycleSyncEnabled ?? true,
      createdAt: this.now().toISOString(),
      archivedAt: null,
      terminationMode: null,
      ownerHostId: input.ownerHostId ?? this.hostId,
    };

    await this.store.saveAll([...mappings, mapping]);
    return mapping;
  }

  private async markArchived(mapping: RemoteCodexMapping, terminationMode: "archive" | "delete"): Promise<void> {
    const mappings = await this.store.list();
    await this.store.saveAll(
      mappings.map((item) =>
        item.discordChannelId === mapping.discordChannelId && item.codexSessionId === mapping.codexSessionId
          ? {
              ...item,
              mappingState: "archived",
              archivedAt: this.now().toISOString(),
              terminationMode,
            }
          : item,
      ),
    );
  }

  private async findActiveByChannel(channelId: string): Promise<RemoteCodexMapping | undefined> {
    return (await this.store.list()).find(
      (mapping) => mapping.discordChannelId === channelId && mapping.mappingState === "active",
    );
  }

  private async findActiveLiveSession(sessionId: string): Promise<RemoteCodexMapping | undefined> {
    return (await this.store.list()).find(
      (mapping) =>
        mapping.mappingKind === "live_session" &&
        mapping.codexSessionId === sessionId &&
        mapping.mappingState === "active",
    );
  }

  private async findActiveTranscript(transcriptId: string): Promise<RemoteCodexMapping | undefined> {
    return (await this.store.list()).find(
      (mapping) =>
        mapping.mappingKind === "transcript" &&
        mapping.transcriptId === transcriptId &&
        mapping.mappingState === "active",
    );
  }

  private startTypingIndicator(channelId: string): () => void {
    if (!this.discord.sendTyping) {
      return () => undefined;
    }

    void this.discord.sendTyping(channelId);
    const timer = setInterval(() => {
      void this.discord.sendTyping?.(channelId);
    }, this.typingIndicatorIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private resolveOwnerHostId(channelName: string, parentCategoryName?: string | null): string {
    if (parentCategoryName) {
      return sanitizeChannelName(parentCategoryName);
    }
    const normalized = channelName.toLowerCase();
    const explicit = normalized.match(/^([a-z0-9_-]+)--/i)?.[1];
    return explicit || this.defaultOwnerHostId;
  }

  private async bindingFromChannel(channelId: string): Promise<ChannelBindingMetadata | null> {
    const channel = await this.discord.fetchChannelDescriptor?.(channelId);
    if (!channel) {
      return null;
    }
    return {
      ownerHostId: this.resolveOwnerHostId(channel.name, channel.parentName),
      mappingKind: "live_session",
      state: "pending",
      updatedAt: this.now().toISOString(),
    };
  }

  private async isHostOnline(hostId: string): Promise<boolean> {
    if (hostId === this.hostId) {
      return true;
    }
    const heartbeats = (await this.discord.listHostHeartbeats?.()) ?? [];
    const heartbeat = heartbeats
      .filter((item) => item.hostId === hostId)
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0];
    if (!heartbeat) {
      return false;
    }
    return this.now().getTime() - Date.parse(heartbeat.lastSeenAt) <= this.ownerHeartbeatTtlMs;
  }

  async isRemoteHostOnline(hostId: string): Promise<boolean> {
    return this.isHostOnline(hostId);
  }

  private renderOfflineResponse(hostId: string): string {
    return this.offlineResponseTemplate.replaceAll("{hostId}", hostId);
  }

  private async writeBinding(mapping: RemoteCodexMapping, state: "active" | "archived"): Promise<void> {
    await this.discord.writeChannelBinding?.(mapping.discordChannelId, {
      ownerHostId: mapping.ownerHostId ?? this.hostId,
      mappingKind: mapping.mappingKind,
      state,
      codexSessionId: mapping.mappingKind === "live_session" ? mapping.codexSessionId : undefined,
      transcriptId: mapping.mappingKind === "transcript" ? mapping.transcriptId : undefined,
      updatedAt: this.now().toISOString(),
    });
  }
}

function renderCodexStreamEvent(event: CodexStreamEvent): string | null {
  const content = event.content.trim();
  if (!content) {
    return null;
  }
  if (event.kind === "thinking") {
    return `Thinking: ${content}`;
  }
  return content;
}

function normalizeStreamContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

export function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "codex-session";
}

function hostnameFallback(): string {
  return process.env.COMPUTERNAME || "default-host";
}
