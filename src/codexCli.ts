import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CodexGateway, CodexSendMessageOptions, CodexStreamEvent } from "./types.js";

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
      await sessionWorkspaceFromPath(options.sourceSessionPath),
    );
    return extractLastAssistantMessage(result.stdout) ?? result.stdout.trim();
  }

  private resumeArgs(): string[] {
    return [
      "--all",
      ...(this.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    ];
  }

  private async runCodex(
    args: string[],
    stdin?: string,
    onEvent?: (event: CodexStreamEvent) => Promise<void> | void,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const command = await this.resolveCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: true, cwd });
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

async function sessionWorkspaceFromPath(sourceSessionPath: string | null | undefined): Promise<string | undefined> {
  if (!sourceSessionPath) {
    return undefined;
  }
  let raw = "";
  try {
    raw = await readFile(sourceSessionPath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split(/\r?\n/)) {
    const parsed = safeJson(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "session_meta") {
      continue;
    }
    const payload = record.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const cwd = (payload as { cwd?: unknown }).cwd;
    if (typeof cwd === "string" && cwd.length > 0 && existsSync(cwd)) {
      return cwd;
    }
  }
  return undefined;
}

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(";");
  if (command.includes("\\") || command.includes("/")) {
    return existsSync(command);
  }
  return paths.some((path) => existsSync(join(path, command)));
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
