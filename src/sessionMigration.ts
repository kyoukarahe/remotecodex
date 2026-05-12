import { createHash } from "node:crypto";
import type { DiscordGateway, RemoteCodexMapping } from "./types.js";
import { SessionBridge, sanitizeChannelName } from "./bridge.js";
import type {
  AttachmentOmissionSemantic,
  CodexAuxiliaryRecord,
  CodexSessionHistory,
  CodexSourceTurn,
  SourceSpeakerRole,
} from "./codexSessionReader.js";
import { readCodexSessionJsonl } from "./codexSessionReader.js";
import { DISCORD_MESSAGE_LIMIT, splitDiscordMessage } from "./discordMessage.js";
import type { IndexedCodexSession } from "./codexSessionIndex.js";
import type { CodexSessionSourceReference } from "./codexSessionSource.js";
import { resolveCodexSessionSource } from "./codexSessionSource.js";

export type MigrationMode = "fullHistory" | "recent15Pairs";
export type TranscriptScope = "full_history" | "recent_15_pairs_excerpt";
export type ApprovalScope = "not_required" | "approved_recent_15_pairs";
export type CompletenessBasis = "text_first_timeline_relative";
export type TranscriptCompletenessStatus =
  | "full_text_preserved"
  | "partial_due_to_in_scope_omission"
  | "reduced_scope";
export type TranscriptArtifactKind =
  | "codex_full_transcript"
  | "codex_full_transcript_with_omission_markers"
  | "codex_reduced_scope_excerpt"
  | "codex_reduced_scope_excerpt_with_omission_markers";

export interface TranscriptRenderableTurn {
  logicalTurnKind: "source_turn" | "omission_marker";
  speakerRole: SourceSpeakerRole;
  textualContent: string;
  sourceSequenceIndex: number;
  sourceRecordIndex: number;
  omittedAttachmentContent: boolean;
  preserveTextFormatting?: boolean;
}

export interface SessionMigrationOptions {
  mode?: MigrationMode;
  approvedRecent15PairsFallback?: boolean;
  speakerLabels?: Partial<Record<SourceSpeakerRole, string>>;
  speakerAvatars?: Partial<Record<SourceSpeakerRole, string>>;
  attachmentOmissionSemantic?: AttachmentOmissionSemantic;
}

export interface TranscriptIdentityPolicy {
  sourceSessionId: string;
  sessionBoundaryPolicy: CodexSessionHistory["sessionBoundaryPolicy"];
  contentProjectionPolicy: CodexSessionHistory["contentProjectionPolicy"];
  revisionResolutionPolicy: CodexSessionHistory["revisionResolutionPolicy"];
  omissionSemantics: AttachmentOmissionSemantic;
  transcriptScope: TranscriptScope;
}

export interface TranscriptArtifact {
  primaryEntity: "transcript_artifact";
  transcriptId: string;
  transcriptKind: TranscriptArtifactKind;
  completenessBasis: CompletenessBasis;
  completenessStatus: TranscriptCompletenessStatus;
  approvalScope: ApprovalScope;
  identityPolicy: TranscriptIdentityPolicy;
  sourceProvenance: {
    sourceSessionId: string;
    sourcePath?: string;
    threadName: string;
    projectName?: string;
  };
  canonicalTimeline: {
    turns: TranscriptRenderableTurn[];
    logicalTurnCount: number;
  };
  auxiliaryProvenance: CodexAuxiliaryRecord[];
}

export interface TranscriptChunkMetadata {
  transcriptId: string;
  transcriptKind: TranscriptArtifactKind;
  logicalTurnKind: TranscriptRenderableTurn["logicalTurnKind"];
  logicalTurnId: string;
  sourceSequenceIndex: number;
  speakerRole: SourceSpeakerRole;
  chunkIndex: number;
  chunkCount: number;
  textStartOffset: number;
  textEndOffsetExclusive: number;
  turnTextLength: number;
}

export interface RenderedTranscriptChunk {
  metadata: TranscriptChunkMetadata;
  content: string;
  textFragment: string;
  username: string;
  avatarUrl?: string;
}

export interface SessionMigrationResult {
  artifact: TranscriptArtifact;
  mapping: RemoteCodexMapping;
  transcriptId: string;
  transcriptKind: TranscriptArtifactKind;
  migrationMode: MigrationMode;
  completenessStatus: TranscriptCompletenessStatus;
  migratedTurns: number;
  discordMessagesSent: number;
}

export const TRANSCRIPT_CHUNK_POLICY =
  "Discord transport chunks are ordered delivery records only. They are subordinate to logical transcript turns, and reassembly must use logical turn id plus chunk ordering metadata rather than treating each Discord message as an independent transcript turn.";

export const TRANSCRIPT_COMPLETENESS_BASIS = [
  "The completeness basis is text-first, timeline-relative, and policy-relative: only in-scope human-readable logical turns selected by the declared boundary, projection, revision, omission, and scope policies participate in completeness.",
  "Full_text_preserved means every in-scope logical turn selected by the declared policies was preserved without logical-text loss, and chunk metadata can reconstruct each turn exactly.",
  "Partial_due_to_in_scope_omission means in-scope text order is still preserved, but attachment-derived conversational content was omitted or marked absent under the declared omission policy.",
  "Reduced_scope means the artifact is a separately approved excerpt class whose scope intentionally excludes out-of-scope conversation rather than treating it as missing content.",
] as const;

export class RecentPairFallbackRequiresApprovalError extends Error {
  constructor() {
    super("Recent 15 conversation-pair fallback requires explicit user approval");
    this.name = "RecentPairFallbackRequiresApprovalError";
  }
}

export class CodexSessionMigrationService {
  constructor(
    private readonly bridge: SessionBridge,
    private readonly discord: DiscordGateway,
  ) {}

  async migrateFile(filePath: string, options: SessionMigrationOptions = {}): Promise<SessionMigrationResult> {
    return this.migrateHistory(await readCodexSessionJsonl(filePath), options);
  }

  async migrateSource(
    reference: CodexSessionSourceReference,
    sessions: IndexedCodexSession[],
    options: SessionMigrationOptions = {},
  ): Promise<SessionMigrationResult> {
    const resolved = resolveCodexSessionSource(reference, sessions);
    return this.migrateFile(resolved.storagePath, options);
  }

  async migrateHistory(
    history: CodexSessionHistory,
    options: SessionMigrationOptions = {},
  ): Promise<SessionMigrationResult> {
    const migrationMode = options.mode ?? "fullHistory";
    const attachmentOmissionSemantic =
      options.attachmentOmissionSemantic ?? history.defaultAttachmentOmissionSemantic;
    const turns = selectTurnsForMigration(history, options);
    const transcriptScope = transcriptScopeForMode(migrationMode);
    const approvalScope = approvalScopeForMode(migrationMode);
    const transcriptKind = transcriptArtifactKindForPolicies(transcriptScope, attachmentOmissionSemantic);
    const identityPolicy: TranscriptIdentityPolicy = {
      sourceSessionId: history.sessionId,
      sessionBoundaryPolicy: history.sessionBoundaryPolicy,
      contentProjectionPolicy: history.contentProjectionPolicy,
      revisionResolutionPolicy: history.revisionResolutionPolicy,
      omissionSemantics: attachmentOmissionSemantic,
      transcriptScope,
    };
    const transcriptId = buildTranscriptId(identityPolicy);
    const mapping = await this.bridge.handleTranscriptCreated({
      transcriptId,
      sourceSessionId: history.sessionId,
      sourceSessionPath: history.sourcePath,
      label: sanitizeChannelName(transcriptChannelLabel(history)),
    });
    const completenessStatus = determineCompletenessStatus(history, transcriptScope, attachmentOmissionSemantic);
    const artifact: TranscriptArtifact = {
      primaryEntity: "transcript_artifact",
      transcriptId,
      transcriptKind,
      completenessBasis: "text_first_timeline_relative",
      completenessStatus,
      approvalScope,
      identityPolicy,
      sourceProvenance: {
        sourceSessionId: history.sessionId,
        sourcePath: history.sourcePath,
        threadName: history.threadName,
        projectName: history.projectName,
      },
      canonicalTimeline: {
        turns,
        logicalTurnCount: turns.length,
      },
      auxiliaryProvenance: history.auxiliaryRecords,
    };

    let discordMessagesSent = 0;
    for (const turn of turns) {
      for (const chunk of renderTranscriptChunks(turn, transcriptId, transcriptKind, options)) {
        if (this.discord.sendWebhookMessage) {
          await this.discord.sendWebhookMessage(mapping.discordChannelId, {
            username: chunk.username,
            content: chunk.content,
            avatarUrl: chunk.avatarUrl,
          });
        } else {
          await this.discord.sendMessage(mapping.discordChannelId, chunk.content);
        }
        discordMessagesSent += 1;
      }
    }

    return {
      artifact,
      mapping,
      transcriptId,
      transcriptKind,
      migrationMode,
      completenessStatus,
      migratedTurns: turns.length,
      discordMessagesSent,
    };
  }
}

export function renderTranscriptChunks(
  turn: TranscriptRenderableTurn,
  transcriptId: string,
  transcriptKind: TranscriptArtifactKind,
  options: SessionMigrationOptions = {},
): RenderedTranscriptChunk[] {
  const label = speakerLabel(turn.speakerRole, options);
  const text = turn.preserveTextFormatting ? turn.textualContent : cleanMigratedText(turn.textualContent);
  if (text.length === 0) {
    return [];
  }
  let contentLimit = DISCORD_MESSAGE_LIMIT;

  for (;;) {
    const fragments = splitDiscordMessage(text, contentLimit);
    let textOffset = 0;
    const rendered = fragments.map((textFragment, index) => {
      const metadata: TranscriptChunkMetadata = {
        transcriptId,
        transcriptKind,
        logicalTurnKind: turn.logicalTurnKind,
        logicalTurnId: logicalTurnId(turn),
        sourceSequenceIndex: turn.sourceSequenceIndex,
        speakerRole: turn.speakerRole,
        chunkIndex: index,
        chunkCount: fragments.length,
        textStartOffset: textOffset,
        textEndOffsetExclusive: textOffset + textFragment.length,
        turnTextLength: text.length,
      };
      textOffset += textFragment.length;
      return {
        metadata,
        textFragment,
        username: label,
        avatarUrl: options.speakerAvatars?.[turn.speakerRole],
        content: textFragment,
      };
    });

    if (rendered.every((chunk) => chunk.content.length <= DISCORD_MESSAGE_LIMIT)) {
      return rendered;
    }

    contentLimit -= 16;
    if (contentLimit < 1) {
      throw new Error("Transcript chunk metadata exceeds Discord message limit");
    }
  }
}

export function reassembleTranscriptTurn(chunks: RenderedTranscriptChunk[]): string {
  return [...chunks]
    .sort((left, right) => left.metadata.chunkIndex - right.metadata.chunkIndex)
    .map((chunk) => chunk.textFragment)
    .join("");
}

export function selectTurnsForMigration(
  history: CodexSessionHistory,
  options: SessionMigrationOptions = {},
): TranscriptRenderableTurn[] {
  const selectedBaseTurns = selectBaseTurns(history.turns, options);
  const selectedRecordIndexes = new Set(selectedBaseTurns.map((turn) => turn.sourceRecordIndex));
  const renderableTurns = selectedBaseTurns.map(toRenderableSourceTurn);
  const attachmentOmissionSemantic =
    options.attachmentOmissionSemantic ?? history.defaultAttachmentOmissionSemantic;

  if (attachmentOmissionSemantic === "represented_by_absence_marker") {
    const omissionMarkers = history.auxiliaryRecords
      .filter((record) => record.kind === "attachment_omission")
      .filter((record) => shouldIncludeAuxiliaryRecord(record, selectedRecordIndexes, options.mode ?? "fullHistory"))
      .map(toRenderableOmissionMarker);
    renderableTurns.push(...omissionMarkers);
  }

  return renderableTurns.sort(compareRenderableTurns);
}

export function assertTranscriptArtifactBoundary(value: unknown): asserts value is TranscriptArtifact {
  const artifact = objectValue(value);
  if (!artifact) {
    throw new Error("Transcript artifact must be an object");
  }
  const timeline = objectValue(artifact.canonicalTimeline);
  if (!timeline || !Array.isArray(timeline.turns)) {
    throw new Error("Transcript artifact must expose canonicalTimeline.turns");
  }
  for (const turn of timeline.turns) {
    const current = objectValue(turn);
    if (!current || "chunkIndex" in current || "chunkCount" in current) {
      throw new Error("Transcript turns must not contain transport chunk fields");
    }
  }
  if (!Array.isArray(artifact.auxiliaryProvenance)) {
    throw new Error("Transcript artifact must expose auxiliaryProvenance separately");
  }
  for (const record of artifact.auxiliaryProvenance) {
    const current = objectValue(record);
    if (!current || "speakerRole" in current || "logicalTurnKind" in current) {
      throw new Error("Auxiliary provenance must not be shaped as transcript turns");
    }
  }
}

export function assertTranscriptChunkBoundary(value: unknown): asserts value is RenderedTranscriptChunk {
  const chunk = objectValue(value);
  const metadata = objectValue(chunk?.metadata);
  if (!chunk || !metadata) {
    throw new Error("Transcript chunk must include metadata");
  }
  if ("completenessStatus" in metadata || "sourceSessionId" in metadata) {
    throw new Error("Transport chunk metadata must not carry artifact-level completeness or provenance fields");
  }
}

function selectBaseTurns(turns: CodexSourceTurn[], options: SessionMigrationOptions): CodexSourceTurn[] {
  if ((options.mode ?? "fullHistory") === "fullHistory") {
    return [...turns];
  }

  if (!options.approvedRecent15PairsFallback) {
    throw new RecentPairFallbackRequiresApprovalError();
  }

  return latestConversationPairs(turns, 15);
}

function latestConversationPairs(turns: CodexSourceTurn[], pairLimit: number): CodexSourceTurn[] {
  const pairs: CodexSourceTurn[][] = [];
  let pendingUser: CodexSourceTurn | undefined;

  for (const turn of turns) {
    if (turn.speakerRole === "user") {
      pendingUser = turn;
      continue;
    }

    if (pendingUser && turn.speakerRole === "assistant") {
      pairs.push([pendingUser, turn]);
      pendingUser = undefined;
    }
  }

  return pairs.slice(-pairLimit).flat();
}

function determineCompletenessStatus(
  history: CodexSessionHistory,
  transcriptScope: TranscriptScope,
  attachmentOmissionSemantic: AttachmentOmissionSemantic,
): TranscriptCompletenessStatus {
  if (transcriptScope === "recent_15_pairs_excerpt") {
    return "reduced_scope";
  }
  if (
    history.hasOmittedAttachmentContent &&
    (attachmentOmissionSemantic === "excluded_outside_transcript" ||
      attachmentOmissionSemantic === "represented_by_absence_marker")
  ) {
    return "partial_due_to_in_scope_omission";
  }
  return "full_text_preserved";
}

function speakerLabel(role: SourceSpeakerRole, options: SessionMigrationOptions): string {
  return (
    options.speakerLabels?.[role] ??
    {
      user: "User",
      assistant: "Codex",
      system: "System",
      tool: "Tool",
    }[role]
  );
}

function cleanMigratedText(text: string): string {
  return stripRuntimeContextBlocks(text)
    .split(/\r?\n/)
    .filter((line) => !isVisibleTranscriptMetadataLine(line) && !isRuntimeContextTagLine(line))
    .join("\n")
    .trim();
}

function stripRuntimeContextBlocks(text: string): string {
  return RUNTIME_CONTEXT_BLOCK_TAGS.reduce(
    (current, tagName) =>
      current.replace(
        new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(tagName)}>`, "gi"),
        "",
      ),
    text,
  );
}

function isVisibleTranscriptMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^\[Transcript (?:turn|artifact)\b/.test(trimmed) ||
    /^(?:User|Codex|Assistant|System|Tool):\s*\[Transcript (?:turn|artifact)\b/.test(trimmed)
  );
}

const RUNTIME_CONTEXT_BLOCK_TAGS = [
  "environment_context",
  "permission instructions",
  "permissions instructions",
  "developer",
  "app-context",
  "collaboration_mode",
  "apps_instructions",
  "skills_instructions",
  "plugins_instructions",
  "subagent_notification",
  "turn_aborted",
] as const;

function isRuntimeContextTagLine(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  return RUNTIME_CONTEXT_BLOCK_TAGS.some((tagName) => {
    const escaped = escapeRegExp(tagName.toLowerCase());
    return new RegExp(`<\\/?${escaped}\\b[^>]*>`).test(trimmed);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTranscriptId(identityPolicy: TranscriptIdentityPolicy): string {
  const digest = createHash("sha256").update(JSON.stringify(identityPolicy)).digest("hex").slice(0, 16);
  return `transcript-${identityPolicy.sourceSessionId}-${digest}`;
}

function transcriptScopeForMode(mode: MigrationMode): TranscriptScope {
  return mode === "recent15Pairs" ? "recent_15_pairs_excerpt" : "full_history";
}

function approvalScopeForMode(mode: MigrationMode): ApprovalScope {
  return mode === "recent15Pairs" ? "approved_recent_15_pairs" : "not_required";
}

function transcriptArtifactKindForPolicies(
  transcriptScope: TranscriptScope,
  omissionSemantics: AttachmentOmissionSemantic,
): TranscriptArtifactKind {
  if (transcriptScope === "recent_15_pairs_excerpt") {
    return omissionSemantics === "represented_by_absence_marker"
      ? "codex_reduced_scope_excerpt_with_omission_markers"
      : "codex_reduced_scope_excerpt";
  }
  return omissionSemantics === "represented_by_absence_marker"
    ? "codex_full_transcript_with_omission_markers"
    : "codex_full_transcript";
}

function transcriptChannelLabel(history: CodexSessionHistory): string {
  return history.projectName ? `${history.projectName}-${history.threadName}` : history.threadName;
}

function logicalTurnId(turn: TranscriptRenderableTurn): string {
  return `${turn.logicalTurnKind}-${turn.sourceSequenceIndex}-${turn.sourceRecordIndex}-${turn.speakerRole}`;
}

function toRenderableSourceTurn(turn: CodexSourceTurn): TranscriptRenderableTurn {
  return {
    logicalTurnKind: "source_turn",
    speakerRole: turn.speakerRole,
    textualContent: turn.textualContent,
    sourceSequenceIndex: turn.sourceSequenceIndex,
    sourceRecordIndex: turn.sourceRecordIndex,
    omittedAttachmentContent: turn.omittedAttachmentContent,
  };
}

function toRenderableOmissionMarker(record: CodexAuxiliaryRecord): TranscriptRenderableTurn {
  return {
    logicalTurnKind: "omission_marker",
    speakerRole: "tool",
    textualContent: "[Attachment-derived content omitted by migration policy]",
    sourceSequenceIndex: record.sourceRecordIndex,
    sourceRecordIndex: record.sourceRecordIndex,
    omittedAttachmentContent: true,
  };
}

function shouldIncludeAuxiliaryRecord(
  record: CodexAuxiliaryRecord,
  selectedRecordIndexes: Set<number>,
  mode: MigrationMode,
): boolean {
  if (mode === "fullHistory") {
    return true;
  }
  return selectedRecordIndexes.has(record.sourceRecordIndex);
}

function compareRenderableTurns(left: TranscriptRenderableTurn, right: TranscriptRenderableTurn): number {
  if (left.sourceRecordIndex !== right.sourceRecordIndex) {
    return left.sourceRecordIndex - right.sourceRecordIndex;
  }
  if (left.logicalTurnKind !== right.logicalTurnKind) {
    return left.logicalTurnKind === "source_turn" ? -1 : 1;
  }
  return left.sourceSequenceIndex - right.sourceSequenceIndex;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
