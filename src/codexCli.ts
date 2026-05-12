import { spawn } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CodexGateway, CodexSendMessageOptions, CodexSession, CodexStreamEvent } from "./types.js";

export interface CodexCliGatewayOptions {
  command?: string;
  skipGitRepoCheck?: boolean;
  timeoutMs?: number;
}

export class CodexCliGateway implements CodexGateway {
  private command: string | undefined;
  private readonly skipGitRepoCheck: boolean;
  private readonly timeoutMs: number;

  constructor(options: CodexCliGatewayOptions = {}) {
    this.command = options.command;
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 120000);
  }

  async createSession(reason: string, options: { cwd?: string } = {}): Promise<CodexSession> {
    const result = await this.runCodex(
      ["exec", "--json", ...this.createArgs(options.cwd), "-"],
      sessionBootstrapPrompt(reason),
    );
    const id = extractSessionId(result.stdout) ?? `unknown-${Date.now()}`;
    const sourceSessionPath = await findSessionJsonlPath(id);
    await ensureSessionIndexed({
      id,
      threadName: threadNameFromReason(reason),
      sourceSessionPath,
      updatedAt: new Date().toISOString(),
    });
    return { id, sourceSessionPath: sourceSessionPath ?? undefined };
  }

  async archiveSession(sessionId: string): Promise<void> {
    // Codex CLI currently exposes resume/fork, but not a stable archive command.
    // The bridge records the archive locally so no more Discord messages route to it.
    void sessionId;
  }

  async sendMessage(sessionId: string, content: string, options: CodexSendMessageOptions = {}): Promise<string> {
    const result = await this.runCodex(
      ["exec", "resume", "--json", ...this.resumeArgs(), sessionId, "-"],
      content,
      options.onEvent,
    );
    return extractLastAssistantMessage(result.stdout) ?? result.stdout.trim();
  }

  private createArgs(cwd?: string): string[] {
    return [
      ...(this.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...(cwd ? ["-C", cwd] : []),
    ];
  }

  private resumeArgs(): string[] {
    return [
      ...(this.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    ];
  }

  private async runCodex(
    args: string[],
    stdin?: string,
    onEvent?: (event: CodexStreamEvent) => Promise<void> | void,
  ): Promise<{ stdout: string; stderr: string }> {
    const command = await this.resolveCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: true });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      let stdout = "";
      let stderr = "";
      let pendingStdoutLine = "";
      let streamQueue = Promise.resolve();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (onEvent) {
          const lines = (pendingStdoutLine + text).split(/\r?\n/);
          pendingStdoutLine = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseCodexStreamEvent(line);
            if (event) {
              streamQueue = streamQueue.then(() => onEvent(event)).then(() => undefined);
            }
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (onEvent && pendingStdoutLine.trim()) {
          const event = parseCodexStreamEvent(pendingStdoutLine);
          if (event) {
            streamQueue = streamQueue.then(() => onEvent(event)).then(() => undefined);
          }
        }
        streamQueue.then(
          () => {
            if (code === 0) {
              resolve({ stdout, stderr });
              return;
            }
            reject(new Error(`Codex CLI exited with code ${code}: ${stderr || stdout}`));
          },
          (error) => reject(error),
        );
      });
    });
  }

  private async resolveCommand(): Promise<string> {
    if (this.command) {
      return this.command;
    }
    for (const candidate of ["codex.cmd", "codex.exe", "codex"]) {
      if (await commandExists(candidate)) {
        this.command = candidate;
        return candidate;
      }
    }
    this.command = "codex.cmd";
    return this.command;
  }
}

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(";");
  if (command.includes("\\") || command.includes("/")) {
    return existsSync(command);
  }
  return paths.some((path) => existsSync(join(path, command)));
}

function sessionBootstrapPrompt(reason: string): string {
  return [
    "RemoteCodex is creating a Discord-linked chat session.",
    "Reply exactly: RemoteCodex session ready",
    `Session reason: ${reason}`,
  ].join("\n");
}

function threadNameFromReason(reason: string): string {
  const channelCreatedPrefix = "Discord channel created: ";
  return reason.startsWith(channelCreatedPrefix) ? reason.slice(channelCreatedPrefix.length) : reason;
}

async function ensureSessionIndexed(input: {
  id: string;
  threadName: string;
  sourceSessionPath: string | null;
  updatedAt: string;
}): Promise<void> {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  let raw = "";
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    raw = "";
  }
  if (raw.split(/\r?\n/).some((line) => safeJson(line) && findStringByKey(safeJson(line), new Set(["id"])) === input.id)) {
    return;
  }
  const record = {
    id: input.id,
    thread_name: input.threadName,
    updated_at: input.updatedAt,
    ...(input.sourceSessionPath ? { storage_path: input.sourceSessionPath } : {}),
  };
  await appendFile(indexPath, `${JSON.stringify(record)}\n`, "utf8");
}

function extractSessionId(jsonl: string): string | null {
  for (const line of jsonl.split(/\r?\n/)) {
    const parsed = safeJson(line);
    const value = findStringByKey(parsed, new Set(["thread_id", "session_id", "sessionId", "conversation_id"]));
    if (value) {
      return value;
    }
  }
  return null;
}

function extractLastAssistantMessage(jsonl: string): string | null {
  let latest: string | null = null;
  for (const line of jsonl.split(/\r?\n/)) {
    const parsed = safeJson(line);
    const message = findStringByKey(parsed, new Set(["content", "message", "text"]));
    if (message) {
      latest = message;
    }
  }
  return latest;
}

function parseCodexStreamEvent(line: string): CodexStreamEvent | null {
  const parsed = safeJson(line);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const payload = "payload" in parsed ? (parsed as { payload?: unknown }).payload : parsed;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const type = typeof (payload as { type?: unknown }).type === "string" ? (payload as { type: string }).type : "";
  if (type === "agent_message") {
    const message = (payload as { message?: unknown }).message;
    return typeof message === "string" && message.trim() ? { kind: "assistant", content: message.trim() } : null;
  }
  if (type === "reasoning") {
    const summary = extractReasoningSummary((payload as { summary?: unknown }).summary);
    return summary ? { kind: "thinking", content: summary } : null;
  }
  return null;
}

function extractReasoningSummary(summary: unknown): string | null {
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim();
  }
  if (!Array.isArray(summary)) {
    return null;
  }
  const parts = summary
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        const text = findStringByKey(item, new Set(["text", "summary"]));
        return text ?? "";
      }
      return "";
    })
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

async function findSessionJsonlPath(sessionId: string): Promise<string | null> {
  return findFileNameContaining(join(homedir(), ".codex", "sessions"), sessionId);
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

function safeJson(line: string): unknown {
  if (!line.trim()) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function findStringByKey(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && child.length > 0) {
      return child;
    }
    const nested = findStringByKey(child, keys);
    if (nested) {
      return nested;
    }
  }
  return null;
}
