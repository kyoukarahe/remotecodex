import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionBridge } from "../src/bridge.js";
import { InMemorySessionStore } from "../src/store.js";
import type { CodexGateway, DiscordGateway } from "../src/types.js";
import { CodexSessionIndexWatcher, parseSessionIndex } from "../src/codexSessionIndex.js";
import { createDiscordClient, wireDiscordEvents } from "../src/discordBot.js";

function testRig() {
  const bindings = new Map<string, unknown>();
  const discord: DiscordGateway = {
    createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
    deleteChannel: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    fetchChannelDescriptor: vi.fn(async (channelId: string) => ({
      id: channelId,
      name: channelId === "discord-remote" ? "pc2--remote-codex" : "remote-codex",
      parentId: null,
      topic: null,
    })),
    readChannelBinding: vi.fn(async (channelId: string) => (bindings.get(channelId) as never) ?? null),
    writeChannelBinding: vi.fn(async (channelId, binding) => {
      bindings.set(channelId, binding);
    }),
    publishHostHeartbeat: vi.fn(async () => undefined),
    listHostHeartbeats: vi.fn(async () => []),
  };
  const codex: CodexGateway = {
    archiveSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => "codex response"),
  };
  const store = new InMemorySessionStore();
  const bridge = new SessionBridge(discord, codex, store, {
    hostId: "pc1",
    hostLabel: "pc1",
    defaultOwnerHostId: "pc1",
    now: () => new Date("2026-05-07T00:00:00.000Z"),
  });
  return { bridge, discord, codex, store };
}

describe("SessionBridge", () => {
  it("creates a Discord channel when a Codex session is created", async () => {
    const { bridge, discord, store } = testRig();

    const mapping = await bridge.handleCodexSessionCreated("codex-42", "My Codex Session", "C:/codex/codex-42.jsonl");

    expect(discord.createSessionChannel).toHaveBeenCalledWith("my-codex-session", { ownerHostId: "pc1" });
    expect(mapping).toMatchObject({
      mappingKind: "live_session",
      discordChannelId: "channel-my-codex-session",
      codexSessionId: "codex-42",
      transcriptId: null,
      sourceSessionPath: "C:/codex/codex-42.jsonl",
      mappingState: "active",
      origin: "codex",
    });
    expect(await store.list()).toHaveLength(1);
  });

  it("archives the Codex session when the Discord channel is deleted", async () => {
    const { bridge, codex, store } = testRig();
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    await bridge.handleDiscordChannelDeleted("channel-remote-codex");

    expect(codex.archiveSession).toHaveBeenCalledWith("codex-1");
    expect((await store.list())[0]).toMatchObject({
      mappingState: "archived",
      archivedAt: "2026-05-07T00:00:00.000Z",
      terminationMode: "delete",
    });
  });

  it("deletes the Discord channel when the Codex session is archived", async () => {
    const { bridge, discord, store } = testRig();
    await bridge.handleCodexSessionCreated("codex-42", "remote-codex");

    await bridge.handleCodexSessionArchived("codex-42");

    expect(discord.deleteChannel).toHaveBeenCalledWith("channel-remote-codex");
    expect((await store.list())[0]).toMatchObject({
      mappingState: "archived",
      terminationMode: "archive",
    });
  });

  it("does not archive a source Codex session when a transcript channel is deleted", async () => {
    const { bridge, codex, store } = testRig();
    const mapping = await bridge.handleTranscriptCreated({
      transcriptId: "transcript-1",
      sourceSessionId: "codex-42",
      sourceSessionPath: "C:/codex/codex-42.jsonl",
      label: "codex transcript",
    });

    await bridge.handleDiscordChannelDeleted(mapping.discordChannelId);

    expect(codex.archiveSession).not.toHaveBeenCalled();
    expect((await store.list())[0]).toMatchObject({
      mappingKind: "transcript",
      mappingState: "archived",
      terminationMode: "delete",
    });
  });

  it("routes Discord chat messages to Codex and posts the response", async () => {
    const { bridge, codex, discord, store } = testRig();
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    await bridge.handleDiscordMessage("channel-remote-codex", false, "hello");

    expect(codex.sendMessage).toHaveBeenCalledWith(
      "codex-1",
      "hello",
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
    expect(discord.sendTyping).toHaveBeenCalledWith("channel-remote-codex");
    expect(discord.sendMessage).toHaveBeenCalledWith("channel-remote-codex", "codex response");
  });

  it("posts streamed Codex events for live Discord chat without duplicating the final response", async () => {
    const { bridge, codex, discord } = testRig();
    vi.mocked(codex.sendMessage).mockImplementation(async (_sessionId, _content, options) => {
      await options?.onEvent?.({ kind: "thinking", content: "checking state" });
      await options?.onEvent?.({ kind: "assistant", content: "partial response" });
      return "partial response";
    });
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    await bridge.handleDiscordMessage("channel-remote-codex", false, "hello");

    expect(discord.sendMessage).toHaveBeenCalledWith("channel-remote-codex", "Thinking: checking state");
    expect(discord.sendMessage).toHaveBeenCalledWith("channel-remote-codex", "partial response");
    expect(discord.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps Discord typing active while waiting for a Codex response", async () => {
    vi.useFakeTimers();
    const { bridge, codex, discord } = testRig();
    let resolveResponse: (response: string) => void = () => undefined;
    vi.mocked(codex.sendMessage).mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    const pending = bridge.handleDiscordMessage("channel-remote-codex", false, "hello");
    await vi.advanceTimersByTimeAsync(16000);
    resolveResponse("codex response");
    await pending;
    await vi.advanceTimersByTimeAsync(8000);

    expect(discord.sendTyping).toHaveBeenCalledTimes(3);
    expect(discord.sendMessage).toHaveBeenCalledWith("channel-remote-codex", "codex response");
    vi.useRealTimers();
  });

  it("routes transcript channel messages to Codex but lets the transcript tailer render the response", async () => {
    const { bridge, codex, discord, store } = testRig();
    await bridge.handleTranscriptCreated({
      transcriptId: "transcript-1",
      sourceSessionId: "codex-42",
      sourceSessionPath: "C:/codex/codex-42.jsonl",
      label: "codex transcript",
    });
    const mappings = await store.list();
    await store.saveAll(mappings.map((mapping) => ({ ...mapping, chatEnabled: true })));

    await bridge.handleDiscordMessage("channel-codex-transcript", false, "continue here");

    expect(codex.sendMessage).toHaveBeenCalledWith("codex-42", "continue here", {
      sourceSessionPath: "C:/codex/codex-42.jsonl",
    });
    expect(discord.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores bot messages and empty messages", async () => {
    const { bridge, codex, discord } = testRig();
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    await bridge.handleDiscordMessage("channel-remote-codex", true, "hello");
    await bridge.handleDiscordMessage("channel-remote-codex", false, "   ");

    expect(codex.sendMessage).not.toHaveBeenCalled();
    expect(discord.sendTyping).not.toHaveBeenCalled();
  });

  it("replies with an offline notice when the owner host is offline", async () => {
    const { bridge, codex, discord } = testRig();

    await bridge.handleDiscordMessage("discord-remote", false, "hello");

    expect(codex.sendMessage).not.toHaveBeenCalled();
    expect(discord.sendMessage).toHaveBeenCalledWith(
      "discord-remote",
      "This session belongs to host pc2, which is currently offline.",
    );
  });
});

describe("parseSessionIndex", () => {
  it("reads Codex session ids and thread names from jsonl", () => {
    expect(
      parseSessionIndex(
        [
          '{"id":"session-1","thread_name":"Windows Codex","storage_path":"C:/codex/session-1.jsonl","updated_at":"2026-05-07T00:00:00Z"}',
          '{"id":"session-2"}',
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "session-1",
        threadName: "Windows Codex",
        storagePath: "C:/codex/session-1.jsonl",
        updatedAt: "2026-05-07T00:00:00Z",
      },
      {
        id: "session-2",
        threadName: "codex-session-2",
        storagePath: undefined,
        updatedAt: undefined,
      },
    ]);
  });
});

describe("CodexSessionIndexWatcher", () => {
  it("does not archive active bridge mappings just because a session is absent from the index", async () => {
    const { bridge, codex, store } = testRig();
    const watcher = new CodexSessionIndexWatcher(bridge, {
      indexPath: "unused",
      onError: () => undefined,
    });
    await bridge.handleCodexSessionCreated("codex-1", "remote-codex");

    await watcher["sync"]([]);

    expect(codex.archiveSession).not.toHaveBeenCalled();
    expect((await store.list())[0].mappingState).toBe("active");
  });

  it("skips Codex subagent sessions by default", async () => {
    const { bridge, discord, store } = testRig();
    const dir = await mkdtemp(join(tmpdir(), "remotecodex-"));
    const sessionPath = join(dir, "subagent.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "subagent-1",
            thread_source: "subagent",
            source: { subagent: { thread_spawn: { parent_thread_id: "parent-1" } } },
            agent_role: "worker",
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    const watcher = new CodexSessionIndexWatcher(bridge, {
      indexPath: "unused",
      onError: () => undefined,
    });

    await watcher["sync"]([
      {
        id: "subagent-1",
        threadName: "Worker Session",
        storagePath: sessionPath,
      },
    ]);

    expect(discord.createSessionChannel).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(0);
  });
});

describe("wireDiscordEvents", () => {
  it("can be configured for a single guild", () => {
    const { bridge } = testRig();
    const client = createDiscordClient();

    wireDiscordEvents(client, bridge, { guildId: "guild-1" });

    expect(client.listenerCount("channelCreate")).toBe(0);
    expect(client.listenerCount("channelDelete")).toBe(1);
    expect(client.listenerCount("messageCreate")).toBe(1);
  });
});
