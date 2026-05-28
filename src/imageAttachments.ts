import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const PATHISH_KEYS = /(?:^|[_-])(?:path|file|image|asset|artifact|attachment|uri|url|dir)(?:$|[_-])/i;
const MAX_PAYLOAD_SCAN_DEPTH = 12;
const MAX_PAYLOAD_SCAN_NODES = 2000;
const MAX_PAYLOAD_STRING_LENGTH = 20000;

export interface ImageAttachment {
  path: string;
  key: string;
  source: "body" | "payload" | "output_dir";
}

export async function discoverImageAttachments(input: {
  textFragments: string[];
  rawRecords: unknown[];
  sourceSessionPath: string;
  sourceSessionId?: string;
  mappingCreatedAt: string;
  outputDirs?: string[];
}): Promise<ImageAttachment[]> {
  const outputDirCandidates = await discoverOutputDirImages(input.outputDirs ?? defaultOutputDirs(input.sourceSessionId), input.mappingCreatedAt);
  const candidates = [
    ...input.textFragments.flatMap((text) => extractImagePathCandidatesFromText(text)),
    ...input.rawRecords.flatMap((record) => extractImagePathCandidatesFromPayload(record)),
    ...outputDirCandidates,
  ];
  const attachments = await resolveImageAttachments(candidates, input.sourceSessionPath);
  return dedupeAttachments(attachments);
}

export async function imageAttachmentKey(filePath: string): Promise<string> {
  const info = await stat(filePath);
  return `${normalize(filePath).toLowerCase()}\u0000${info.size}\u0000${info.mtimeMs}`;
}

function extractImagePathCandidatesFromText(text: string): Array<{ path: string; source: ImageAttachment["source"] }> {
  const candidates: Array<{ path: string; source: ImageAttachment["source"] }> = [];
  for (const match of text.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    candidates.push({ path: cleanPathToken(match[1]), source: "body" });
  }
  for (const match of text.matchAll(/\[[^\]]+]\(([^)]+\.(?:png|jpe?g|webp|gif)(?:[#?][^)]+)?)\)/gi)) {
    candidates.push({ path: cleanPathToken(match[1]), source: "body" });
  }
  for (const match of text.matchAll(/(?:file:\/\/\/)?[A-Za-z]:[\\/][^\r\n"'<>|]+\.(?:png|jpe?g|webp|gif)\b/gi)) {
    candidates.push({ path: cleanPathToken(match[0]), source: "body" });
  }
  for (const match of text.matchAll(/(?:file:\/\/)?\/[^\r\n"'<>|]+\.(?:png|jpe?g|webp|gif)\b/gi)) {
    candidates.push({ path: cleanPathToken(match[0]), source: "body" });
  }
  return candidates;
}

function extractImagePathCandidatesFromPayload(value: unknown): Array<{ path: string; source: ImageAttachment["source"] }> {
  const candidates: Array<{ path: string; source: ImageAttachment["source"] }> = [];
  visitPayload(value, undefined, candidates, { depth: 0, scannedNodes: 0 });
  return candidates;
}

function visitPayload(
  value: unknown,
  key: string | undefined,
  candidates: Array<{ path: string; source: ImageAttachment["source"] }>,
  budget: { depth: number; scannedNodes: number },
): void {
  if (budget.depth > MAX_PAYLOAD_SCAN_DEPTH || budget.scannedNodes > MAX_PAYLOAD_SCAN_NODES) {
    return;
  }
  budget.scannedNodes += 1;
  if (typeof value === "string") {
    if (value.length > MAX_PAYLOAD_STRING_LENGTH) {
      return;
    }
    if (PATHISH_KEYS.test(key ?? "")) {
      for (const candidate of extractImagePathCandidatesFromText(value)) {
        candidates.push({ ...candidate, source: "payload" });
      }
      if (looksLikeImagePath(value)) {
        candidates.push({ path: cleanPathToken(value), source: "payload" });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitPayload(item, key, candidates, { ...budget, depth: budget.depth + 1 });
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    visitPayload(childValue, childKey, candidates, { ...budget, depth: budget.depth + 1 });
  }
}

async function discoverOutputDirImages(
  outputDirs: string[],
  mappingCreatedAt: string,
): Promise<Array<{ path: string; source: ImageAttachment["source"] }>> {
  const createdAtMs = Date.parse(mappingCreatedAt);
  const candidates: Array<{ path: string; source: ImageAttachment["source"] }> = [];
  for (const dir of outputDirs) {
    candidates.push(...(await discoverImagesInDir(dir, Number.isFinite(createdAtMs) ? createdAtMs : 0)));
  }
  return candidates;
}

async function discoverImagesInDir(
  dir: string,
  minMtimeMs: number,
): Promise<Array<{ path: string; source: ImageAttachment["source"] }>> {
  const candidates: Array<{ path: string; source: ImageAttachment["source"] }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      candidates.push(...(await discoverImagesInDir(entryPath, minMtimeMs)));
      continue;
    }
    if (!isImagePath(entryPath)) {
      continue;
    }
    const info = await stat(entryPath);
    if (info.mtimeMs >= minMtimeMs) {
      candidates.push({ path: entryPath, source: "output_dir" });
    }
  }
  return candidates;
}

async function resolveImageAttachments(
  candidates: Array<{ path: string; source: ImageAttachment["source"] }>,
  sourceSessionPath: string,
): Promise<ImageAttachment[]> {
  const attachments: ImageAttachment[] = [];
  for (const candidate of candidates) {
    const filePath = resolveCandidatePath(candidate.path, sourceSessionPath);
    if (!filePath || !isImagePath(filePath)) {
      continue;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        continue;
      }
      attachments.push({
        path: filePath,
        key: await imageAttachmentKey(filePath),
        source: candidate.source,
      });
    } catch {
      continue;
    }
  }
  return attachments;
}

function resolveCandidatePath(candidate: string, sourceSessionPath: string): string | undefined {
  const cleaned = cleanPathToken(candidate);
  if (!cleaned || /^https?:\/\//i.test(cleaned)) {
    return undefined;
  }
  const withoutFileScheme = cleaned.replace(/^file:\/+/i, (prefix) => (prefix.length > 7 ? "" : "/"));
  if (isAbsolute(withoutFileScheme) || /^[A-Za-z]:[\\/]/.test(withoutFileScheme)) {
    return normalize(withoutFileScheme);
  }
  return resolve(dirname(sourceSessionPath), withoutFileScheme);
}

function cleanPathToken(value: string): string {
  return value.trim().replace(/^<|>$/g, "").replace(/^["']|["']$/g, "").replace(/[?#].*$/, "");
}

function looksLikeImagePath(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)(?:[#?].*)?$/i.test(cleanPathToken(value)) || extractImagePathCandidatesFromText(value).length > 0;
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function dedupeAttachments(attachments: ImageAttachment[]): ImageAttachment[] {
  const byKey = new Map<string, ImageAttachment>();
  for (const attachment of attachments) {
    byKey.set(attachment.key, attachment);
  }
  return [...byKey.values()].sort((left, right) => basename(left.path).localeCompare(basename(right.path)));
}

function defaultOutputDirs(sourceSessionId?: string): string[] {
  const configured = process.env.REMOTE_CODEX_IMAGE_OUTPUT_DIRS;
  if (configured) {
    return configured
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const generatedImagesDir = sourceSessionId
    ? join(homedir(), ".codex", "generated_images", sourceSessionId)
    : join(homedir(), ".codex", "generated_images");
  return [
    generatedImagesDir,
    "output/novelai",
    "output/novelai-images",
    "output/images",
  ];
}
