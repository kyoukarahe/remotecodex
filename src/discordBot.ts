import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  type TextChannel,
  type Webhook,
} from "discord.js";
import type { ChannelBindingMetadata, DiscordGateway, HostHeartbeat } from "./types.js";
import { SessionBridge, sanitizeChannelName } from "./bridge.js";
import { splitDiscordMessage } from "./discordMessage.js";

export class DiscordJsGateway implements DiscordGateway {
  private latestHumanAvatarUrl: string | undefined;
  private readonly commandChannelName: string;
  private readonly categoryHeartbeatChannelName: string;
  private readonly heartbeatChannelIdsByHost = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly categoryId?: string,
  ) {
    this.commandChannelName = process.env.REMOTE_CODEX_COMMAND_CHANNEL_NAME ?? "remote-codex-hosts";
    this.categoryHeartbeatChannelName = "heartbeat";
  }

  async createSessionChannel(name: string, options: { ownerHostId?: string } = {}) {
    const guild = await this.fetchGuild();
    const parent = await this.resolveSessionCategoryId(guild, options.ownerHostId);
    const channel = await guild.channels.create({
      name: sanitizeChannelName(name),
      type: ChannelType.GuildText,
      parent,
      reason: "RemoteCodex session created from Windows Codex",
    });
    return { id: channel.id, name: channel.name };
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased() && "delete" in channel) {
      await channel.delete("RemoteCodex linked Codex session archived");
    }
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel && typeof channel.send === "function") {
      for (const chunk of splitDiscordMessage(content)) {
        await channel.send(chunk);
      }
    }
  }

  async sendFiles(channelId: string, files: string[], content?: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (isTextChannel(channel)) {
      await channel.send({
        content,
        files,
        allowedMentions: { parse: [] },
      });
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (isTextChannel(channel)) {
      await channel.sendTyping();
    }
  }

  async fetchChannelMessages(channelId: string): Promise<Array<{ id: string; username: string; content: string; bot: boolean; webhook: boolean; avatarUrl: string }>> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextChannel(channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }

    const messages = [...(await channel.messages.fetch({ limit: 100 })).values()];

    return messages
      .sort((left, right) => Number(BigInt(left.id) - BigInt(right.id)))
      .map((message) => {
        const avatarUrl = humanAvatarUrl(message);
        if (!message.author.bot && !message.webhookId) {
          this.latestHumanAvatarUrl = avatarUrl;
        }
        return {
          id: message.id,
          username: message.author.username,
          content: message.content,
          bot: message.author.bot,
          webhook: Boolean(message.webhookId),
          avatarUrl,
        };
      });
  }

  async fetchLatestHumanAvatarUrl(): Promise<string | undefined> {
    if (this.latestHumanAvatarUrl) {
      return this.latestHumanAvatarUrl;
    }

    this.latestHumanAvatarUrl = await this.fetchFirstHumanMemberAvatarUrl();
    if (this.latestHumanAvatarUrl) {
      return this.latestHumanAvatarUrl;
    }

    const guild = await this.fetchGuild();
    const channels = [...(await guild.channels.fetch()).values()].filter(isTextChannel);
    const preferredChannels = this.categoryId
      ? channels.filter((channel) => channel.parentId === this.categoryId)
      : channels;
    const fallbackChannels = this.categoryId
      ? channels.filter((channel) => channel.parentId !== this.categoryId)
      : [];

    this.latestHumanAvatarUrl = await this.fetchLatestHumanAvatarUrlFromChannels([...preferredChannels, ...fallbackChannels]);
    return this.latestHumanAvatarUrl;
  }

  private async fetchFirstHumanMemberAvatarUrl(): Promise<string | undefined> {
    const guild = await this.fetchGuild();
    try {
      const owner = await guild.fetchOwner();
      if (!owner.user.bot) {
        return owner.displayAvatarURL({ extension: "png", size: 128 });
      }
      const members = [...(await guild.members.fetch({ limit: 100 })).values()]
        .filter((member) => !member.user.bot)
        .sort((left, right) => (left.joinedTimestamp ?? 0) - (right.joinedTimestamp ?? 0));
      const member = members[0];
      return member?.displayAvatarURL({ extension: "png", size: 128 });
    } catch (error) {
      console.warn("RemoteCodex could not fetch guild members for avatar fallback", error);
      return undefined;
    }
  }

  private async fetchLatestHumanAvatarUrlFromChannels(channels: TextChannel[]): Promise<string | undefined> {
    let latest: Message<true> | undefined;

    for (const channel of channels) {
      let messages: Message<true>[];
      try {
        messages = await fetchRecentChannelMessages(channel, 1000);
      } catch {
        continue;
      }
      for (const message of messages) {
        if (message.author.bot || message.webhookId) {
          continue;
        }
        if (!latest || BigInt(message.id) > BigInt(latest.id)) {
          latest = message;
        }
      }
    }

    return latest ? humanAvatarUrl(latest) : undefined;
  }

  async sendWebhookMessage(
    channelId: string,
    message: { username: string; content: string; avatarUrl?: string },
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextChannel(channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }

    const webhook = await this.getOrCreateTranscriptWebhook(channel);
    for (const chunk of splitDiscordMessage(message.content)) {
      await webhook.send({
        content: chunk,
        username: message.username,
        avatarURL: message.avatarUrl,
        allowedMentions: { parse: [] },
      });
    }
  }

  async fetchChannelDescriptor(channelId: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextChannel(channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return {
      id: channel.id,
      name: channel.name,
      parentId: channel.parentId,
      parentName: channel.parent?.name ?? null,
      topic: channel.topic,
    };
  }

  async readChannelBinding(channelId: string): Promise<ChannelBindingMetadata | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextChannel(channel)) {
      return null;
    }
    return parseChannelBinding(channel.topic);
  }

  async writeChannelBinding(channelId: string, binding: ChannelBindingMetadata): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextChannel(channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    const topic = serializeChannelBinding(binding);
    if (channel.topic !== topic) {
      await channel.setTopic(topic, "RemoteCodex channel ownership metadata sync");
    }
  }

  async publishHostHeartbeat(heartbeat: HostHeartbeat): Promise<void> {
    const channel = await this.ensureHeartbeatChannel(heartbeat.hostId);
    const messages = [...(await channel.messages.fetch({ limit: 100 })).values()]
      .sort((left, right) => Number(BigInt(left.id) - BigInt(right.id)));
    const aggregate = messages.map((message) => ({ message, payload: parseHeartbeatAggregate(message.content) }))
      .filter((item) => Boolean(item.payload));
    const latest = aggregate.at(-1);
    const state = latest?.payload ?? {};
    state[heartbeat.hostId] = heartbeat;
    const payload = serializeHeartbeatAggregate(state);
    if (latest) {
      if (latest.message.content !== payload) {
        await latest.message.edit(payload);
      }
      for (const duplicate of aggregate.slice(0, -1)) {
        await duplicate.message.delete().catch(() => undefined);
      }
      for (const stale of messages.filter((message) => !aggregate.some((item) => item.message.id === message.id))) {
        await stale.delete().catch(() => undefined);
      }
      return;
    }
    await channel.bulkDelete(messages, true).catch(() => undefined);
    await channel.send(payload);
  }

  async listHostHeartbeats(): Promise<HostHeartbeat[]> {
    const channels = await this.listHeartbeatChannels();
    const heartbeats: HostHeartbeat[] = [];
    for (const channel of channels) {
      const messages = [...(await channel.messages.fetch({ limit: 20 })).values()]
        .sort((left, right) => Number(BigInt(left.id) - BigInt(right.id)));
      const latest = messages.map((message) => parseHeartbeatAggregate(message.content)).filter(Boolean).at(-1);
      if (latest) {
        heartbeats.push(...Object.values(latest));
      }
    }
    return heartbeats;
  }

  private async fetchGuild(): Promise<Guild> {
    return this.client.guilds.fetch(this.guildId);
  }

  private async ensureHeartbeatChannel(hostId: string): Promise<TextChannel> {
    const cachedChannelId = this.heartbeatChannelIdsByHost.get(hostId);
    if (cachedChannelId) {
      const existing = await this.client.channels.fetch(cachedChannelId).catch(() => null);
      if (isTextChannel(existing)) {
        return existing;
      }
    }
    const guild = await this.fetchGuild();
    const channels = [...(await guild.channels.fetch()).values()].filter(isTextChannel);
    const categoryId = await this.resolveSessionCategoryId(guild, hostId);
    const existing = channels.find(
      (channel) => channel.name === this.categoryHeartbeatChannelName && channel.parentId === categoryId,
    );
    if (existing) {
      this.heartbeatChannelIdsByHost.set(hostId, existing.id);
      return existing;
    }
    const created = await guild.channels.create({
      name: sanitizeChannelName(this.categoryHeartbeatChannelName),
      type: ChannelType.GuildText,
      parent: categoryId,
      reason: "RemoteCodex host heartbeat control channel",
    });
    this.heartbeatChannelIdsByHost.set(hostId, created.id);
    return created;
  }

  private async listHeartbeatChannels(): Promise<TextChannel[]> {
    const guild = await this.fetchGuild();
    return [...(await guild.channels.fetch()).values()]
      .filter(isTextChannel)
      .filter((channel) => channel.name === this.categoryHeartbeatChannelName || channel.name === this.commandChannelName);
  }

  private async resolveSessionCategoryId(guild: Guild, ownerHostId?: string): Promise<string | undefined> {
    if (!ownerHostId) {
      return this.categoryId;
    }
    const normalizedOwner = sanitizeChannelName(ownerHostId);
    const channels = [...(await guild.channels.fetch()).values()];
    const category = channels.find(
      (channel) =>
        channel?.type === ChannelType.GuildCategory && sanitizeChannelName(channel.name) === normalizedOwner,
    );
    return category?.id ?? this.categoryId;
  }

  private async getOrCreateTranscriptWebhook(channel: TextChannel): Promise<Webhook> {
    const existing = (await channel.fetchWebhooks()).find((webhook) => webhook.name === "RemoteCodex Transcript");
    if (existing) {
      return existing;
    }
    return channel.createWebhook({
      name: "RemoteCodex Transcript",
      reason: "RemoteCodex transcript migration author rendering",
    });
  }
}

export function createDiscordClient(options: { messageContentIntent?: boolean } = {}): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      ...(options.messageContentIntent ? [GatewayIntentBits.MessageContent] : []),
    ],
  });
}

export function wireDiscordEvents(
  client: Client,
  bridge: SessionBridge,
  options: {
    guildId: string;
    commandChannelName?: string;
    onCommand?: (channelId: string, content: string, authorIsBot: boolean) => Promise<void>;
  },
): void {
  const commandChannelName = sanitizeChannelName(options.commandChannelName ?? "remote-codex-hosts");

  client.on(Events.ChannelDelete, async (channel) => {
    if ("guildId" in channel && channel.guildId !== options.guildId) {
      return;
    }
    if ("name" in channel && channel.name === commandChannelName) {
      return;
    }
    await safely(`channel delete ${channel.id}`, () => bridge.handleDiscordChannelDeleted(channel.id));
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!isTextChannel(message.channel)) {
      return;
    }
    if (message.guildId !== options.guildId) {
      return;
    }
    if (message.channel.name === commandChannelName) {
      await safely(`command ${message.id}`, () =>
        options.onCommand?.(message.channel.id, message.content, message.author.bot) ?? Promise.resolve(),
      );
      return;
    }
    await safely(`message ${message.id}`, () =>
      bridge.handleDiscordMessage(message.channel.id, message.author.bot, message.content),
    );
  });
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return Boolean(channel && typeof channel === "object" && "type" in channel && channel.type === ChannelType.GuildText);
}

function humanAvatarUrl(message: Message<true>): string {
  return (
    message.member?.displayAvatarURL({ extension: "png", size: 128 }) ??
    message.author.displayAvatarURL({ extension: "png", size: 128 })
  );
}

async function fetchRecentChannelMessages(channel: TextChannel, maxMessages: number): Promise<Message<true>[]> {
  const messages: Message<true>[] = [];
  let before: string | undefined;
  while (messages.length < maxMessages) {
    const batch = [...(await channel.messages.fetch({ limit: Math.min(100, maxMessages - messages.length), before })).values()];
    if (batch.length === 0) {
      break;
    }
    messages.push(...batch);
    before = batch.at(-1)?.id;
    if (batch.length < 100) {
      break;
    }
  }
  return messages;
}

async function safely(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`RemoteCodex event failed: ${label}`, error);
  }
}

function serializeChannelBinding(binding: ChannelBindingMetadata): string {
  return `RCMETA ${JSON.stringify(binding)}`;
}

function parseChannelBinding(topic: string | null | undefined): ChannelBindingMetadata | null {
  if (!topic?.startsWith("RCMETA ")) {
    return null;
  }
  try {
    return JSON.parse(topic.slice("RCMETA ".length)) as ChannelBindingMetadata;
  } catch {
    return null;
  }
}

function serializeHeartbeatAggregate(heartbeats: Record<string, HostHeartbeat>): string {
  return Object.entries(heartbeats)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostId, heartbeat]) => `${hostId.toUpperCase()} - lastSeenAt:${formatKst(heartbeat.lastSeenAt)}`)
    .join("\n");
}

function parseHeartbeatAggregate(content: string): Record<string, HostHeartbeat> | null {
  return parseReadableHeartbeatAggregate(content);
}

function parseReadableHeartbeatAggregate(content: string): Record<string, HostHeartbeat> | null {
  const heartbeats: Record<string, HostHeartbeat> = {};
  for (const line of content.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(/^(.+?)\s+-\s+lastSeenAt:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\s*KST)?$/);
    if (!match) {
      return null;
    }
    const hostId = match[1].trim().toLowerCase();
    const lastSeenAt = parseKst(match[2]);
    if (!hostId || !lastSeenAt) {
      return null;
    }
    heartbeats[hostId] = {
      hostId,
      label: hostId,
      lastSeenAt,
    };
  }
  return Object.keys(heartbeats).length > 0 ? heartbeats : null;
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
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function parseKst(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hours, minutes, seconds] = match;
  const utcTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours) - 9,
    Number(minutes),
    Number(seconds),
  );
  if (Number.isNaN(utcTime)) {
    return null;
  }
  return new Date(utcTime).toISOString();
}
