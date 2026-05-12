export type MappingState = "active" | "archived" | "deleted";
export type MappingOrigin = "discord" | "codex";
export type TerminationMode = "archive" | "delete";
export type MappingKind = "live_session" | "transcript";
export type ChannelBindingState = "pending" | "active" | "archived";

export interface RemoteCodexMapping {
  mappingKind: MappingKind;
  discordChannelId: string;
  codexSessionId: string;
  transcriptId: string | null;
  sourceSessionPath: string | null;
  mappingState: MappingState;
  origin: MappingOrigin;
  chatEnabled: boolean;
  streamingEnabled: boolean;
  lifecycleSyncEnabled: boolean;
  createdAt: string;
  archivedAt: string | null;
  terminationMode: TerminationMode | null;
  ownerHostId?: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
}

export interface DiscordChannelDescriptor {
  id: string;
  name: string;
  parentId?: string | null;
  parentName?: string | null;
  topic?: string | null;
}

export interface ChannelBindingMetadata {
  ownerHostId: string;
  mappingKind: MappingKind;
  state: ChannelBindingState;
  codexSessionId?: string | null;
  transcriptId?: string | null;
  updatedAt: string;
}

export interface HostHeartbeat {
  hostId: string;
  label: string;
  lastSeenAt: string;
 }

export type CodexStreamEventKind = "assistant" | "thinking";

export interface CodexStreamEvent {
  kind: CodexStreamEventKind;
  content: string;
}

export interface CodexSendMessageOptions {
  onEvent?: (event: CodexStreamEvent) => Promise<void> | void;
  sourceSessionPath?: string | null;
}

export interface DiscordGateway {
  createSessionChannel(name: string, options?: { ownerHostId?: string }): Promise<DiscordChannel>;
  deleteChannel(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<void>;
  sendFiles?(channelId: string, files: string[], content?: string): Promise<void>;
  sendTyping?(channelId: string): Promise<void>;
  fetchChannelMessages?(
    channelId: string,
  ): Promise<Array<{ id: string; username: string; content: string; bot?: boolean; webhook?: boolean; avatarUrl?: string }>>;
  fetchLatestHumanAvatarUrl?(): Promise<string | undefined>;
  fetchChannelDescriptor?(channelId: string): Promise<DiscordChannelDescriptor>;
  readChannelBinding?(channelId: string): Promise<ChannelBindingMetadata | null>;
  writeChannelBinding?(channelId: string, binding: ChannelBindingMetadata): Promise<void>;
  publishHostHeartbeat?(heartbeat: HostHeartbeat): Promise<void>;
  listHostHeartbeats?(): Promise<HostHeartbeat[]>;
  sendWebhookMessage?(
    channelId: string,
    message: {
      username: string;
      content: string;
      avatarUrl?: string;
    },
  ): Promise<void>;
}

export interface CodexGateway {
  archiveSession(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, content: string, options?: CodexSendMessageOptions): Promise<string>;
}

export interface SessionStore {
  list(): Promise<RemoteCodexMapping[]>;
  saveAll(mappings: RemoteCodexMapping[]): Promise<void>;
}
