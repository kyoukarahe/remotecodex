import { readFile } from "node:fs/promises";

export type SourceSpeakerRole = "user" | "assistant" | "system" | "tool";
export type SourceTurnDisposition = "first_class_turn";
export type PolicyControlledTurnDisposition = "first_class_turn" | "auxiliary_preserved";
export type AuxiliaryRecordKind =
  | "attachment_omission"
  | "non_timeline_event"
  | "revision_variant"
  | "branch_variant"
  | "role_policy_auxiliary"
  | "excluded_record";
export type AttachmentOmissionSemantic = "excluded_outside_transcript" | "represented_by_absence_marker";
export type SessionBoundaryPolicy = "single_canonical_source_session" | "explicit_record_subset";
export type RevisionResolutionPolicy = "canonical_visible_timeline" | "raw_storage_order";
export type ContentProjectionPolicy = "text_first_projection" | "text_plus_attachment_markers";

export interface RolePreservationPolicy {
  user: "first_class_turn";
  assistant: "first_class_turn";
  system: PolicyControlledTurnDisposition;
  tool: PolicyControlledTurnDisposition;
}

export interface CodexSourceTurn {
  speakerRole: SourceSpeakerRole;
  textualContent: string;
  sourceSequenceIndex: number;
  sourceRecordIndex: number;
  omittedAttachmentContent: boolean;
  disposition: SourceTurnDisposition;
}

interface InternalCodexSourceTurn extends CodexSourceTurn {
  canonicalOrder: number;
}

export interface CodexAuxiliaryRecord {
  kind: AuxiliaryRecordKind;
  sourceRecordIndex: number;
  summary: string;
  preservedText: string | null;
}

export interface CodexSessionHistory {
  sessionId: string;
  threadName: string;
  projectName?: string;
  sourcePath?: string;
  turns: CodexSourceTurn[];
  auxiliaryRecords: CodexAuxiliaryRecord[];
  hasOmittedAttachmentContent: boolean;
  sessionBoundaryPolicy: SessionBoundaryPolicy;
  sessionBoundaryRule: string;
  revisionResolutionPolicy: RevisionResolutionPolicy;
  revisionResolutionRule: string;
  contentProjectionPolicy: ContentProjectionPolicy;
  rolePreservationPolicy: RolePreservationPolicy;
  defaultAttachmentOmissionSemantic: AttachmentOmissionSemantic;
}

export const CANONICAL_SESSION_BOUNDARY_RULE =
  "A transcript includes only records from one coherent timeline: the canonical session id is the first explicit source-session identifier in the file, otherwise the supplied fallback session id, and any record with a conflicting explicit session id is preserved only as an auxiliary non-timeline record.";

export const CANONICAL_REVISION_RESOLUTION_RULE =
  "Canonical conversation order is resolved from the final visible timeline rather than raw storage order: retried, superseded, regenerated, edited-away, or side-branch variants are excluded from first-class turns and preserved only as auxiliary provenance.";

export const DEFAULT_ROLE_PRESERVATION_POLICY: RolePreservationPolicy = {
  user: "first_class_turn",
  assistant: "first_class_turn",
  system: "first_class_turn",
  tool: "first_class_turn",
};

export const SPEAKER_ROLE_PRESERVATION_POLICY = DEFAULT_ROLE_PRESERVATION_POLICY;

export const MIGRATABLE_CONVERSATIONAL_CONTENT_RULES = [
  "User and assistant roles are always preserved as first-class transcript turns, while system and tool roles follow an explicit preservation policy that can either preserve them as first-class turns or keep them only as auxiliary provenance.",
  "Top-level records and nested payload/message/item objects are candidate source nodes when they expose a supported speaker role and remain inside the canonical session boundary.",
  "Human-readable transcript text is projected from strings and nested structured nodes using text/content/message/parts/items/input/output values in source order.",
  "Nested structured nodes that mix text with attachment references preserve only their text, while the omitted attachment-derived content is captured through explicit omission provenance.",
  "Attachment-only nodes are outside transcript text by default, are preserved only through omission provenance unless an absence-marker policy is requested, and never import binary attachment contents.",
  "Retried, regenerated, superseded, edited-away, side-branch, or explicitly non-timeline records are excluded from first-class turns and preserved only as auxiliary provenance when detected.",
] as const;

export async function readCodexSessionJsonl(filePath: string): Promise<CodexSessionHistory> {
  return parseCodexSessionJsonl(await readFile(filePath, "utf8"), {
    fallbackSessionId: sessionIdFromPath(filePath),
    sourcePath: filePath,
  });
}

export function parseCodexSessionJsonl(
  raw: string,
  options: {
    fallbackSessionId?: string;
    fallbackThreadName?: string;
    sourcePath?: string;
    rolePreservationPolicy?: Pick<RolePreservationPolicy, "system" | "tool">;
  } = {},
): CodexSessionHistory {
  const rolePreservationPolicy: RolePreservationPolicy = {
    ...DEFAULT_ROLE_PRESERVATION_POLICY,
    ...options.rolePreservationPolicy,
  };
  const extractedTurns: InternalCodexSourceTurn[] = [];
  const auxiliaryRecords: CodexAuxiliaryRecord[] = [];
  let sessionId: string | undefined;
  let threadName = options.fallbackThreadName;
  let projectName: string | undefined;
  let hasOmittedAttachmentContent = false;
  let canonicalSessionId: string | undefined;

  raw.split(/\r?\n/).forEach((line, sourceRecordIndex) => {
    if (!line.trim()) {
      return;
    }

    const parsed = JSON.parse(line) as Record<string, unknown>;
    const explicitSessionId = extractRecordSessionId(parsed);
    canonicalSessionId = firstString(canonicalSessionId, explicitSessionId);
    sessionId = firstString(sessionId, canonicalSessionId, metadataSessionId(parsed));
    threadName = firstString(threadName, parsed.thread_name, parsed.title, threadNameFromEvent(parsed));
    projectName = firstString(projectName, projectNameFromRecord(parsed));

    if (isCodexDesktopNonTranscriptRecord(parsed)) {
      auxiliaryRecords.push({
        kind: "excluded_record",
        sourceRecordIndex,
        summary: "Excluded Codex Desktop runtime event outside user/final assistant transcript",
        preservedText: null,
      });
      return;
    }

    if (explicitSessionId && canonicalSessionId && explicitSessionId !== canonicalSessionId) {
      auxiliaryRecords.push({
        kind: "non_timeline_event",
        sourceRecordIndex,
        summary: `Excluded record with conflicting session id ${explicitSessionId}`,
        preservedText: null,
      });
      return;
    }

    const extracted = extractTurn(parsed, sourceRecordIndex, rolePreservationPolicy);
    if (extracted?.turn) {
      extractedTurns.push(extracted.turn);
    }
    hasOmittedAttachmentContent ||= extracted?.omittedAttachmentContent ?? false;
    if (extracted?.auxiliaryRecords.length) {
      auxiliaryRecords.push(...extracted.auxiliaryRecords);
    }
  });

  const resolvedSessionId = sessionId ?? options.fallbackSessionId ?? "codex-session";
  const turns = collapseAdjacentDuplicateTurns(
    extractedTurns
    .sort(compareCanonicalTurns)
    .map(({ canonicalOrder: _canonicalOrder, ...turn }, sourceSequenceIndex) => ({
      ...turn,
      sourceSequenceIndex,
    })),
  );
  return {
    sessionId: resolvedSessionId,
    threadName: threadName ?? `codex-${resolvedSessionId}`,
    projectName,
    sourcePath: options.sourcePath,
    turns,
    auxiliaryRecords,
    hasOmittedAttachmentContent,
    sessionBoundaryPolicy: "single_canonical_source_session",
    sessionBoundaryRule: CANONICAL_SESSION_BOUNDARY_RULE,
    revisionResolutionPolicy: "canonical_visible_timeline",
    revisionResolutionRule: CANONICAL_REVISION_RESOLUTION_RULE,
    contentProjectionPolicy: "text_first_projection",
    rolePreservationPolicy,
    defaultAttachmentOmissionSemantic: "excluded_outside_transcript",
  };
}

function extractTurn(
  record: Record<string, unknown>,
  sourceRecordIndex: number,
  rolePreservationPolicy: RolePreservationPolicy,
): { turn?: InternalCodexSourceTurn; omittedAttachmentContent: boolean; auxiliaryRecords: CodexAuxiliaryRecord[] } | undefined {
  const candidates = [
    record,
    objectValue(record.payload),
    objectValue(record.message),
    objectValue(record.item),
  ].filter((item): item is Record<string, unknown> => Boolean(item));

  let omittedAttachmentContent = false;
  const auxiliaryRecords: CodexAuxiliaryRecord[] = [];
  for (const candidate of candidates) {
    const speakerRole = normalizeSpeakerRole(candidate.role ?? candidate.author ?? candidate.type);
    if (!speakerRole) {
      continue;
    }
    if (isRevisionVariant(candidate)) {
      auxiliaryRecords.push({
        kind: "revision_variant",
        sourceRecordIndex,
        summary: "Excluded retried, regenerated, or superseded variant from first-class transcript turns",
        preservedText: extractText(candidate.content ?? candidate.text ?? candidate.message ?? candidate.output).textualContent || null,
      });
      continue;
    }
    if (isSideBranchVariant(candidate)) {
      auxiliaryRecords.push({
        kind: "branch_variant",
        sourceRecordIndex,
        summary: "Excluded side-branch variant from canonical first-class transcript turns",
        preservedText: null,
      });
      continue;
    }

    const extractedText = extractText(candidate.content ?? candidate.text ?? candidate.message ?? candidate.output);
    omittedAttachmentContent ||= extractedText.omittedAttachmentContent;
    if (rolePreservationPolicy[speakerRole] === "auxiliary_preserved") {
      auxiliaryRecords.push({
        kind: "role_policy_auxiliary",
        sourceRecordIndex,
        summary: `${speakerRole} content preserved as auxiliary provenance by role policy`,
        preservedText: extractedText.textualContent.trim().length > 0 ? extractedText.textualContent : null,
      });
      continue;
    }
    if (extractedText.textualContent.trim().length > 0) {
      return {
        turn: {
          speakerRole,
          textualContent: extractedText.textualContent,
          sourceSequenceIndex: -1,
          sourceRecordIndex,
          omittedAttachmentContent: extractedText.omittedAttachmentContent,
          disposition: "first_class_turn",
          canonicalOrder: canonicalTurnOrder(candidate, sourceRecordIndex),
        },
        omittedAttachmentContent,
        auxiliaryRecords,
      };
    }
    if (extractedText.omittedAttachmentContent) {
      auxiliaryRecords.push({
        kind: "attachment_omission",
        sourceRecordIndex,
        summary: `Attachment-only ${speakerRole} content omitted from transcript text`,
        preservedText: null,
      });
    }
  }

  if (auxiliaryRecords.length > 0 || omittedAttachmentContent) {
    return { omittedAttachmentContent, auxiliaryRecords };
  }

  if (candidates.length === 0) {
    return undefined;
  }

  auxiliaryRecords.push({
    kind: "excluded_record",
    sourceRecordIndex,
    summary: "Excluded record outside transcript projection rules",
    preservedText: null,
  });
  return { omittedAttachmentContent, auxiliaryRecords };
}

function isCodexDesktopNonTranscriptRecord(record: Record<string, unknown>): boolean {
  if (record.type === "response_item") {
    return true;
  }

  if (record.type !== "event_msg") {
    return false;
  }

  const payload = objectValue(record.payload);
  if (!payload) {
    return true;
  }

  if (payload.type === "user_message") {
    return false;
  }
  if (payload.type === "agent_message") {
    return payload.phase !== "final_answer";
  }
  return true;
}

function extractText(value: unknown): { textualContent: string; omittedAttachmentContent: boolean } {
  if (typeof value === "string") {
    return { textualContent: value, omittedAttachmentContent: false };
  }

  if (Array.isArray(value)) {
    const nested = value.map(extractText).filter((item) => item.textualContent.length > 0);
    return {
      textualContent: nested.map((item) => item.textualContent).join("\n"),
      omittedAttachmentContent: value.some((item) => extractText(item).omittedAttachmentContent),
    };
  }

  const object = objectValue(value);
  if (!object) {
    return { textualContent: "", omittedAttachmentContent: false };
  }

  if (isAttachmentOnlyNode(object)) {
    return { textualContent: "", omittedAttachmentContent: true };
  }

  for (const key of ["text", "content", "message"] as const) {
    if (typeof object[key] === "string") {
      return { textualContent: object[key], omittedAttachmentContent: false };
    }
  }

  const nestedValues = [object.text, object.content, object.message, object.parts, object.items, object.input, object.output];
  const nested = nestedValues.map(extractText);
  return {
    textualContent: nested
      .map((item) => item.textualContent)
      .filter((item) => item.length > 0)
      .join("\n"),
    omittedAttachmentContent: nested.some((item) => item.omittedAttachmentContent),
  };
}

function normalizeSpeakerRole(value: unknown): SourceSpeakerRole | undefined {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (["user", "human", "user_message", "input"].includes(normalized)) {
    return "user";
  }
  if (["assistant", "codex", "agent_message", "response_item", "model", "output"].includes(normalized)) {
    return "assistant";
  }
  if (["system", "developer", "instruction"].includes(normalized)) {
    return "system";
  }
  if (["tool", "function", "tool_result", "tool_output"].includes(normalized)) {
    return "tool";
  }
  return undefined;
}

function extractRecordSessionId(record: Record<string, unknown>): string | undefined {
  return firstString(
    undefined,
    record.session_id,
    record.conversation_id,
    record.thread_id,
    record.sessionId,
    record.conversationId,
    objectValue(record.payload)?.session_id,
    objectValue(record.message)?.session_id,
    objectValue(record.item)?.session_id,
    metadataSessionId(record),
  );
}

function metadataSessionId(record: Record<string, unknown>): string | undefined {
  if (record.type === "session_meta") {
    return firstString(undefined, objectValue(record.payload)?.id);
  }
  if ("thread_name" in record || "title" in record) {
    return typeof record.id === "string" ? record.id : undefined;
  }
  return undefined;
}

function threadNameFromEvent(record: Record<string, unknown>): string | undefined {
  if (record.type !== "event_msg") {
    return undefined;
  }
  const payload = objectValue(record.payload);
  return payload?.type === "thread_name_updated" ? firstString(undefined, payload.thread_name) : undefined;
}

function projectNameFromRecord(record: Record<string, unknown>): string | undefined {
  const cwd = firstString(undefined, record.cwd, objectValue(record.payload)?.cwd);
  if (!cwd) {
    return undefined;
  }
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isAttachmentOnlyNode(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type && /(image|file|attachment|audio|video|document|pdf)/.test(type) && !type.includes("text")) {
    return true;
  }

  return [
    "file_path",
    "filename",
    "mime_type",
    "image_url",
    "asset_pointer",
    "attachment_id",
    "attachment_ids",
  ].some((key) => key in value);
}

function isRevisionVariant(value: Record<string, unknown>): boolean {
  const status = typeof value.status === "string" ? value.status.toLowerCase() : "";
  return Boolean(
    value.retry_of ||
      value.regenerated_from ||
      value.superseded_by ||
      value.regeneration_of ||
      value.edited_from ||
      value.revision_of ||
      value.supersedes ||
      status === "retried" ||
      status === "superseded" ||
      status === "edited",
  );
}

function isSideBranchVariant(value: Record<string, unknown>): boolean {
  const branch = typeof value.branch === "string" ? value.branch.toLowerCase() : "";
  const branchId = typeof value.branch_id === "string" ? value.branch_id.toLowerCase() : "";
  return Boolean(
    value.branch_of ||
      value.forked_from ||
      value.parent_branch_id ||
      (branch && branch !== "main" && branch !== "canonical") ||
      (branchId && branchId !== "main" && branchId !== "canonical"),
  );
}

function canonicalTurnOrder(value: Record<string, unknown>, sourceRecordIndex: number): number {
  const explicitOrder = firstNumber(
    value.final_visible_order,
    value.canonical_order,
    value.timeline_order,
    value.sequence,
    value.sequence_index,
    value.turn_index,
  );
  return explicitOrder ?? sourceRecordIndex;
}

function compareCanonicalTurns(
  left: InternalCodexSourceTurn,
  right: InternalCodexSourceTurn,
): number {
  if (left.canonicalOrder !== right.canonicalOrder) {
    return left.canonicalOrder - right.canonicalOrder;
  }
  return left.sourceRecordIndex - right.sourceRecordIndex;
}

function collapseAdjacentDuplicateTurns(turns: CodexSourceTurn[]): CodexSourceTurn[] {
  const collapsed: CodexSourceTurn[] = [];
  for (const turn of turns) {
    const previous = collapsed.at(-1);
    if (
      previous &&
      previous.speakerRole === turn.speakerRole &&
      normalizeTextForDuplicateCheck(previous.textualContent) === normalizeTextForDuplicateCheck(turn.textualContent)
    ) {
      continue;
    }
    collapsed.push({ ...turn, sourceSequenceIndex: collapsed.length });
  }
  return collapsed;
}

function normalizeTextForDuplicateCheck(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function firstString(current: string | undefined, ...values: unknown[]): string | undefined {
  if (current) {
    return current;
  }
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function sessionIdFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return fileName.replace(/\.jsonl$/i, "") || "codex-session";
}
