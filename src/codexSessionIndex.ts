import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionBridge } from "./bridge.js";

export interface IndexedCodexSession {
  id: string;
  threadName: string;
  storagePath?: string;
  updatedAt?: string;
  threadSource?: string;
}

export interface CodexSessionIndexWatcherOptions {
  indexPath?: string;
  intervalMs?: number;
  syncExistingOnStart?: boolean;
  syncSubagents?: boolean;
  onError?: (error: unknown) => void;
  onDebug?: (message: string, details?: unknown) => void;
}

export class CodexSessionIndexWatcher {
  private knownIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bridge: SessionBridge,
    private readonly options: CodexSessionIndexWatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    const current = await this.readSessions();
    this.options.onDebug?.("Codex session watcher started", {
      currentSessionCount: current.length,
      syncExistingOnStart: this.options.syncExistingOnStart ?? false,
      syncSubagents: this.options.syncSubagents ?? false,
      indexPath: this.options.indexPath ?? defaultSessionIndexPath(),
    });
    if (this.options.syncExistingOnStart) {
      await this.sync(current);
    } else {
      this.knownIds = new Set(current.map((session) => session.id));
    }

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
    try {
      await this.sync(await this.readSessions());
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async sync(current: IndexedCodexSession[]): Promise<void> {
    for (const session of current) {
      if (!this.knownIds.has(session.id)) {
        const sourceSessionPath = session.storagePath ?? (await findSessionJsonlPath(session.id, session.updatedAt));
        if (await this.shouldSkipSession({ ...session, storagePath: sourceSessionPath ?? undefined })) {
          continue;
        }
        this.options.onDebug?.("Codex session watcher discovered session", {
          sessionId: session.id,
          threadName: session.threadName,
          sourceSessionPath,
        });
        await this.bridge.handleCodexSessionCreated(session.id, session.threadName, sourceSessionPath);
      }
    }

    this.knownIds = new Set([...this.knownIds, ...current.map((session) => session.id)]);
  }

  private async shouldSkipSession(session: IndexedCodexSession): Promise<boolean> {
    if (this.options.syncSubagents) {
      return false;
    }
    if (session.threadSource === "subagent") {
      this.options.onDebug?.("Codex session watcher skipped subagent session", { sessionId: session.id });
      return true;
    }
    if (!session.storagePath) {
      return false;
    }
    const metadata = await readSessionMetadata(session.storagePath);
    if (metadata?.threadSource === "subagent" || metadata?.hasSubagentSource) {
      this.options.onDebug?.("Codex session watcher skipped subagent session", {
        sessionId: session.id,
        sourceSessionPath: session.storagePath,
        agentRole: metadata.agentRole,
        agentNickname: metadata.agentNickname,
      });
      return true;
    }
    return false;
  }

  private async readSessions(): Promise<IndexedCodexSession[]> {
    return readCodexSessionIndex(this.options.indexPath);
  }
}

export async function readCodexSessionIndex(indexPath = defaultSessionIndexPath()): Promise<IndexedCodexSession[]> {
  const raw = await readFile(indexPath, "utf8");
  return parseSessionIndex(raw);
}

export async function resolveIndexedCodexSession(
  reference: string,
  indexPath = defaultSessionIndexPath(),
): Promise<IndexedCodexSession | null> {
  const sessions = await readCodexSessionIndex(indexPath);
  const selected =
    reference === "latest"
      ? sessions
          .filter((session) => session.threadSource !== "subagent")
          .sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""))[0]
      : sessions.find((session) => session.id === reference);
  if (!selected) {
    return null;
  }
  return {
    ...selected,
    storagePath: selected.storagePath ?? (await findSessionJsonlPath(selected.id, selected.updatedAt)) ?? undefined,
  };
}

export function parseSessionIndex(raw: string): IndexedCodexSession[] {
  const sessions: IndexedCodexSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as {
      id?: unknown;
      thread_name?: unknown;
      storage_path?: unknown;
      path?: unknown;
      file_path?: unknown;
      updated_at?: unknown;
      thread_source?: unknown;
    };
    if (typeof parsed.id === "string") {
      const session: IndexedCodexSession = {
        id: parsed.id,
        threadName: typeof parsed.thread_name === "string" ? parsed.thread_name : `codex-${parsed.id}`,
        storagePath: firstString(parsed.storage_path, parsed.path, parsed.file_path),
        updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
      };
      if (typeof parsed.thread_source === "string") {
        session.threadSource = parsed.thread_source;
      }
      sessions.push(session);
    }
  }
  return sessions;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function defaultSessionIndexPath(): string {
  return join(homedir(), ".codex", "session_index.jsonl");
}

async function readSessionMetadata(filePath: string): Promise<{
  threadSource?: string;
  hasSubagentSource: boolean;
  agentRole?: string;
  agentNickname?: string;
} | null> {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const firstLine = raw.split(/\r?\n/, 1)[0];
  if (!firstLine.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: {
        thread_source?: unknown;
        source?: unknown;
        agent_role?: unknown;
        agent_nickname?: unknown;
      };
    };
    if (parsed.type !== "session_meta" || !parsed.payload) {
      return null;
    }
    return {
      threadSource: typeof parsed.payload.thread_source === "string" ? parsed.payload.thread_source : undefined,
      hasSubagentSource: hasSubagentSource(parsed.payload.source),
      agentRole: typeof parsed.payload.agent_role === "string" ? parsed.payload.agent_role : undefined,
      agentNickname: typeof parsed.payload.agent_nickname === "string" ? parsed.payload.agent_nickname : undefined,
    };
  } catch {
    return null;
  }
}

function hasSubagentSource(source: unknown): boolean {
  return Boolean(source && typeof source === "object" && "subagent" in source);
}

async function findSessionJsonlPath(sessionId: string, updatedAt?: string): Promise<string | null> {
  const roots = updatedAt ? candidateSessionDirs(updatedAt) : [join(homedir(), ".codex", "sessions")];
  for (const root of roots) {
    const found = await findFileNameContaining(root, sessionId);
    if (found) {
      return found;
    }
  }
  return null;
}

function candidateSessionDirs(updatedAt: string): string[] {
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return [join(homedir(), ".codex", "sessions")];
  }
  const year = String(parsed.getFullYear());
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return [join(homedir(), ".codex", "sessions", year, month, day), join(homedir(), ".codex", "sessions")];
}

async function findFileNameContaining(root: string, needle: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.includes(needle) && entry.name.endsWith(".jsonl")) {
      return path;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const found = await findFileNameContaining(join(root, entry.name), needle);
    if (found) {
      return found;
    }
  }
  return null;
}
