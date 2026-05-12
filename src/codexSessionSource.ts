import type { IndexedCodexSession } from "./codexSessionIndex.js";

export interface CodexSessionSourceReference {
  sessionId?: string;
  filePath?: string;
}

export interface ResolvedCodexSessionSource {
  logicalSessionId: string | null;
  storagePath: string;
  threadName?: string;
  resolvedBy: "sessionId" | "filePath";
}

export class CodexSessionSourceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSessionSourceReferenceError";
  }
}

export function resolveCodexSessionSource(
  reference: CodexSessionSourceReference,
  sessions: IndexedCodexSession[],
): ResolvedCodexSessionSource {
  const explicitPath = normalizeOptional(reference.filePath);
  const sessionId = normalizeOptional(reference.sessionId);

  if (explicitPath) {
    const matched = sessions.find((session) => normalizeOptional(session.storagePath) === explicitPath);
    if (sessionId && matched?.id && matched.id !== sessionId) {
      throw new CodexSessionSourceReferenceError(
        `Source reference is ambiguous: session id ${sessionId} does not match file path ${explicitPath}`,
      );
    }
    return {
      logicalSessionId: sessionId ?? matched?.id ?? null,
      storagePath: explicitPath,
      threadName: matched?.threadName,
      resolvedBy: "filePath",
    };
  }

  if (!sessionId) {
    throw new CodexSessionSourceReferenceError("A source reference must provide either a sessionId or a filePath");
  }

  const matches = sessions.filter((session) => session.id === sessionId);
  if (matches.length === 0) {
    throw new CodexSessionSourceReferenceError(`No Codex session matched session id: ${sessionId}`);
  }
  if (matches.length > 1) {
    throw new CodexSessionSourceReferenceError(`Ambiguous Codex session id: ${sessionId}`);
  }
  if (!matches[0].storagePath) {
    throw new CodexSessionSourceReferenceError(`Codex session id ${sessionId} is missing a storage path`);
  }

  return {
    logicalSessionId: matches[0].id,
    storagePath: matches[0].storagePath,
    threadName: matches[0].threadName,
    resolvedBy: "sessionId",
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.replace(/\\/g, "/") : undefined;
}
