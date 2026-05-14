import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CANONICAL_REVISION_RESOLUTION_RULE,
  CANONICAL_SESSION_BOUNDARY_RULE,
  DEFAULT_ROLE_PRESERVATION_POLICY,
  MIGRATABLE_CONVERSATIONAL_CONTENT_RULES,
  parseCodexSessionJsonl,
  type CodexAuxiliaryRecord,
  type CodexSessionHistory,
  type CodexSourceTurn,
} from "../src/codexSessionReader.js";
import { SessionBridge } from "../src/bridge.js";
import {
  CodexSessionMigrationService,
  RecentPairFallbackRequiresApprovalError,
  TRANSCRIPT_CHUNK_POLICY,
  TRANSCRIPT_COMPLETENESS_BASIS,
  assertTranscriptArtifactBoundary,
  assertTranscriptChunkBoundary,
  reassembleTranscriptTurn,
  renderTranscriptChunks,
  selectTurnsForMigration,
  type TranscriptArtifact,
} from "../src/sessionMigration.js";
import { InMemorySessionStore } from "../src/store.js";
import type { CodexGateway, DiscordGateway } from "../src/types.js";
import { CodexSessionSourceReferenceError, resolveCodexSessionSource } from "../src/codexSessionSource.js";
import { TranscriptTailer } from "../src/transcriptTailer.js";
import {
  detectExpectedRolldownBindings,
  verifyVitestBindingsInstalled,
} from "../scripts/vitestBindingCheck.mjs";

function migrationRig() {
  const sent: Array<{ channelId: string; content: string; username?: string }> = [];
  const discord: DiscordGateway = {
    createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
    deleteChannel: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (channelId: string, content: string) => {
      sent.push({ channelId, content });
    }),
    sendWebhookMessage: vi.fn(async (channelId: string, message: { username: string; content: string }) => {
      sent.push({ channelId, content: message.content, username: message.username });
    }),
  };
  const codex: CodexGateway = {
    archiveSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => "unused"),
  };
  const bridge = new SessionBridge(discord, codex, new InMemorySessionStore());
  return { migration: new CodexSessionMigrationService(bridge, discord), sent, bridge };
}

function turn(
  speakerRole: CodexSourceTurn["speakerRole"],
  textualContent: string,
  sourceSequenceIndex: number,
  sourceRecordIndex = sourceSequenceIndex,
  omittedAttachmentContent = false,
): CodexSourceTurn {
  return {
    speakerRole,
    textualContent,
    sourceSequenceIndex,
    sourceRecordIndex,
    omittedAttachmentContent,
    disposition: "first_class_turn",
  };
}

function history(
  turns: CodexSessionHistory["turns"],
  overrides: Partial<CodexSessionHistory> = {},
): CodexSessionHistory {
  return {
    sessionId: "session-1",
    threadName: "Windows Codex",
    sourcePath: "C:/codex/session-1.jsonl",
    turns,
    auxiliaryRecords: [],
    hasOmittedAttachmentContent: false,
    sessionBoundaryPolicy: "single_canonical_source_session",
    sessionBoundaryRule: CANONICAL_SESSION_BOUNDARY_RULE,
    revisionResolutionPolicy: "canonical_visible_timeline",
    revisionResolutionRule: CANONICAL_REVISION_RESOLUTION_RULE,
    contentProjectionPolicy: "text_first_projection",
    rolePreservationPolicy: DEFAULT_ROLE_PRESERVATION_POLICY,
    defaultAttachmentOmissionSemantic: "excluded_outside_transcript",
    ...overrides,
  };
}

describe("CodexSessionMigrationService", () => {
  it("models the primary migrated entity as a transcript artifact with source provenance", async () => {
    const { migration, sent } = migrationRig();

    const result = await migration.migrateHistory(
      history([turn("user", "first", 0), turn("assistant", "second", 1), turn("system", "third", 2)]),
    );

    expect(result.artifact.primaryEntity).toBe("transcript_artifact");
    expect(result.artifact.sourceProvenance).toEqual({
      sourceSessionId: "session-1",
      sourcePath: "C:/codex/session-1.jsonl",
      threadName: "Windows Codex",
      projectName: undefined,
    });
    expect(result.artifact.identityPolicy).toEqual({
      sourceSessionId: "session-1",
      sessionBoundaryPolicy: "single_canonical_source_session",
      contentProjectionPolicy: "text_first_projection",
      revisionResolutionPolicy: "canonical_visible_timeline",
      omissionSemantics: "excluded_outside_transcript",
      transcriptScope: "full_history",
    });
    expect(result.transcriptKind).toBe("codex_full_transcript");
    expect(result.completenessStatus).toBe("full_text_preserved");
    expect(sent.map((message) => message.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(sent.map((message) => message.username)).toEqual(["User", "Codex", "System"]);
    expect(sent.some((message) => message.content.includes("[Transcript"))).toBe(false);
  });

  it("renders migrated author identity through webhook usernames without body prefixes", async () => {
    const { migration, sent } = migrationRig();

    await migration.migrateHistory(
      history([
        turn(
          "user",
          "[Transcript turn 200 | kind=source_turn | role=user | chunk=1/1]\n이런 접두어가 너무 읽기 불편해",
          0,
        ),
        turn("assistant", "확인했어요", 1),
      ]),
      {
        speakerLabels: {
          user: "카라헤",
          assistant: "Codex",
        },
      },
    );

    expect(sent).toEqual([
      expect.objectContaining({
        username: "카라헤",
        content: "이런 접두어가 너무 읽기 불편해",
      }),
      expect.objectContaining({
        username: "Codex",
        content: "확인했어요",
      }),
    ]);
    expect(sent.some((message) => /^(User|Codex|카라헤):/.test(message.content))).toBe(false);
    expect(sent.some((message) => message.content.includes("[Transcript turn"))).toBe(false);
  });

  it("removes runtime context blocks from migrated user-visible text", async () => {
    const { migration, sent } = migrationRig();

    await migration.migrateHistory(
      history([
        turn(
          "user",
          [
            "<environment_context>",
            "<permission instructions>",
            "sandbox_mode=danger-full-access",
            "</permission instructions>",
            "</environment_context>",
            "keep this user request",
            "<subagent_notification>",
            "<turn_aborted>",
            "The user interrupted the previous turn on purpose.",
            "</turn_aborted>",
          ].join("\n"),
          0,
        ),
        turn(
          "assistant",
          "Filter examples such as <environment_context> and <subagent_notification> from visible transcript text.",
          1,
        ),
      ]),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        username: "User",
        content: "keep this user request",
      }),
    ]);
    expect(sent[0].content).not.toContain("environment_context");
    expect(sent[0].content).not.toContain("permission instructions");
    expect(sent[0].content).not.toContain("subagent_notification");
    expect(sent[0].content).not.toContain("turn_aborted");
  });

  it("names transcript channels from project and Windows Codex thread names when available", async () => {
    const { migration, bridge } = migrationRig();

    const result = await migration.migrateHistory(
      history([turn("user", "first", 0)], {
        projectName: "remotegpt",
        threadName: "Interview RemoteCodex",
      }),
    );

    expect(result.artifact.sourceProvenance.projectName).toBe("remotegpt");
    expect((await bridge.listActiveMappings())[0].discordChannelId).toBe("channel-remotegpt-interview-remotecodex");
  });

  it("keeps transcript identity deterministic from source session plus artifact-defining policies only", async () => {
    const { migration } = migrationRig();
    const parsedHistory = history([turn("assistant", "x".repeat(5000), 0)]);

    const base = await migration.migrateHistory(parsedHistory);
    const relabeled = await migration.migrateHistory(parsedHistory, {
      speakerLabels: { assistant: "Assistant" },
    });
    const changedBoundary = await migration.migrateHistory(
      history(parsedHistory.turns, { sessionBoundaryPolicy: "explicit_record_subset" }),
    );
    const changedProjection = await migration.migrateHistory(
      history(parsedHistory.turns, { contentProjectionPolicy: "text_plus_attachment_markers" }),
    );
    const changedRevision = await migration.migrateHistory(
      history(parsedHistory.turns, { revisionResolutionPolicy: "raw_storage_order" }),
    );
    const changedOmission = await migration.migrateHistory(parsedHistory, {
      attachmentOmissionSemantic: "represented_by_absence_marker",
    });
    const changedScope = await migration.migrateHistory(
      history([
        turn("user", "u1", 0, 0),
        turn("assistant", "a1", 1, 1),
        turn("user", "u2", 2, 2),
        turn("assistant", "a2", 3, 3),
      ]),
      { mode: "recent15Pairs", approvedRecent15PairsFallback: true },
    );

    expect(base.transcriptId).toBe(relabeled.transcriptId);
    expect(base.transcriptId).not.toBe(changedBoundary.transcriptId);
    expect(base.transcriptId).not.toBe(changedProjection.transcriptId);
    expect(base.transcriptId).not.toBe(changedRevision.transcriptId);
    expect(base.transcriptId).not.toBe(changedOmission.transcriptId);
    expect(base.transcriptId).not.toBe(changedScope.transcriptId);
  });

  it("keeps auxiliary provenance separate from transcript identity, completeness, and logical turn ordering", async () => {
    const { migration } = migrationRig();
    const baseHistory = history([turn("user", "one", 0), turn("assistant", "two", 1)]);
    const withAuxiliary = history(baseHistory.turns, {
      auxiliaryRecords: [
        {
          kind: "excluded_record",
          sourceRecordIndex: 99,
          summary: "Metadata-only record",
          preservedText: null,
        },
      ],
    });

    const base = await migration.migrateHistory(baseHistory);
    const variant = await migration.migrateHistory(withAuxiliary);

    expect(variant.transcriptId).toBe(base.transcriptId);
    expect(variant.completenessStatus).toBe(base.completenessStatus);
    expect(variant.artifact.canonicalTimeline.turns.map((current) => current.textualContent)).toEqual(["one", "two"]);
    expect(variant.artifact.auxiliaryProvenance).toHaveLength(1);
  });

  it("requires explicit approval for recent-15 reduced-scope migration and emits a distinct artifact kind", async () => {
    const { migration, sent } = migrationRig();
    const turns = Array.from({ length: 16 }, (_, index) => [
      turn("user", `u${index + 1}`, index * 2, index * 2),
      turn("assistant", `a${index + 1}`, index * 2 + 1, index * 2 + 1),
    ]).flat();

    await expect(migration.migrateHistory(history(turns), { mode: "recent15Pairs" })).rejects.toBeInstanceOf(
      RecentPairFallbackRequiresApprovalError,
    );

    const full = await migration.migrateHistory(history(turns));
    const reduced = await migration.migrateHistory(history(turns), {
      mode: "recent15Pairs",
      approvedRecent15PairsFallback: true,
    });

    expect(reduced.artifact.approvalScope).toBe("approved_recent_15_pairs");
    expect(reduced.transcriptKind).toBe("codex_reduced_scope_excerpt");
    expect(reduced.completenessStatus).toBe("reduced_scope");
    expect(reduced.transcriptId).not.toBe(full.transcriptId);
    expect(sent.at(-1)?.content).toContain("a16");
    expect(sent.at(-1)?.username).toBe("Codex");
  });

  it("computes completeness against the explicit text-first basis and declared scope only", async () => {
    const { migration } = migrationRig();

    const full = await migration.migrateHistory(history([turn("user", "kept", 0)]));
    const partial = await migration.migrateHistory(
      history([turn("user", "kept", 0, 0, true)], { hasOmittedAttachmentContent: true }),
    );
    const reduced = await migration.migrateHistory(
      history([turn("user", "u1", 0), turn("assistant", "a1", 1)]),
      { mode: "recent15Pairs", approvedRecent15PairsFallback: true },
    );

    expect(full.artifact.completenessBasis).toBe("text_first_timeline_relative");
    expect(full.completenessStatus).toBe("full_text_preserved");
    expect(partial.completenessStatus).toBe("partial_due_to_in_scope_omission");
    expect(reduced.completenessStatus).toBe("reduced_scope");
  });

  it("treats attachment-only nodes as provenance by default and changes transcript kind only when policy promotes omission markers", async () => {
    const { migration } = migrationRig();
    const baseTurns = [turn("user", "before", 0, 0)];
    const omissionRecord: CodexAuxiliaryRecord = {
      kind: "attachment_omission",
      sourceRecordIndex: 1,
      summary: "Attachment-only user content omitted from transcript text",
      preservedText: null,
    };

    const base = await migration.migrateHistory(history(baseTurns));
    const withAttachmentProvenance = await migration.migrateHistory(
      history(baseTurns, {
        auxiliaryRecords: [omissionRecord],
        hasOmittedAttachmentContent: true,
      }),
    );
    const withMarkers = await migration.migrateHistory(
      history(baseTurns, {
        auxiliaryRecords: [omissionRecord],
        hasOmittedAttachmentContent: true,
      }),
      { attachmentOmissionSemantic: "represented_by_absence_marker" },
    );

    expect(withAttachmentProvenance.transcriptId).toBe(base.transcriptId);
    expect(withAttachmentProvenance.transcriptKind).toBe("codex_full_transcript");
    expect(withMarkers.transcriptKind).toBe("codex_full_transcript_with_omission_markers");
    expect(withMarkers.artifact.canonicalTimeline.turns.map((current) => current.logicalTurnKind)).toEqual([
      "source_turn",
      "omission_marker",
    ]);
  });
});

describe("parseCodexSessionJsonl", () => {
  it("declares session boundary and revision-resolution policies and keeps out-of-timeline records as provenance", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({ id: "session-1", thread_name: "Windows Codex" }),
        JSON.stringify({ session_id: "session-1", role: "user", content: "hello" }),
        JSON.stringify({ session_id: "session-2", role: "assistant", content: "wrong timeline" }),
        JSON.stringify({ role: "assistant", content: "still session-1 timeline" }),
      ].join("\n"),
    );

    expect(parsed.sessionBoundaryPolicy).toBe("single_canonical_source_session");
    expect(parsed.sessionBoundaryRule).toBe(CANONICAL_SESSION_BOUNDARY_RULE);
    expect(parsed.revisionResolutionPolicy).toBe("canonical_visible_timeline");
    expect(parsed.revisionResolutionRule).toBe(CANONICAL_REVISION_RESOLUTION_RULE);
    expect(parsed.turns.map((current) => current.textualContent)).toEqual(["hello", "still session-1 timeline"]);
    expect(parsed.auxiliaryRecords).toContainEqual({
      kind: "non_timeline_event",
      sourceRecordIndex: 2,
      summary: "Excluded record with conflicting session id session-2",
      preservedText: null,
    });
  });

  it("collapses retries, edits, regenerated outputs, and side branches into auxiliary provenance under the declared revision policy", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({ id: "session-1", thread_name: "Retry Session" }),
        JSON.stringify({ role: "assistant", retry_of: "old-response", content: "discard retry" }),
        JSON.stringify({ role: "assistant", edited_from: "old-edit", content: "discard edit" }),
        JSON.stringify({ role: "assistant", regenerated_from: "old-gen", content: "discard regen" }),
        JSON.stringify({ role: "assistant", branch: "branch-a", content: "discard side branch" }),
        JSON.stringify({ role: "assistant", final_visible_order: 2, content: "keep second" }),
        JSON.stringify({ role: "user", final_visible_order: 1, content: "keep first" }),
      ].join("\n"),
    );

    expect(parsed.turns.map((current) => current.textualContent)).toEqual(["keep first", "keep second"]);
    expect(parsed.turns.map((current) => current.sourceRecordIndex)).toEqual([6, 5]);
    expect(parsed.auxiliaryRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "revision_variant", sourceRecordIndex: 1 }),
        expect.objectContaining({ kind: "revision_variant", sourceRecordIndex: 2 }),
        expect.objectContaining({ kind: "revision_variant", sourceRecordIndex: 3 }),
        expect.objectContaining({ kind: "branch_variant", sourceRecordIndex: 4 }),
      ]),
    );
  });

  it("keeps user and assistant as first-class turns while system and tool follow an explicit preservation policy", () => {
    const raw = [
      JSON.stringify({ role: "system", content: "policy" }),
      JSON.stringify({ role: "user", content: "hello" }),
      JSON.stringify({ role: "assistant", content: "response" }),
      JSON.stringify({ role: "tool", content: "tool output" }),
    ].join("\n");

    const firstClass = parseCodexSessionJsonl(raw);
    const policyDemoted = parseCodexSessionJsonl(raw, {
      rolePreservationPolicy: { system: "auxiliary_preserved", tool: "auxiliary_preserved" },
    });

    expect(firstClass.rolePreservationPolicy).toEqual(DEFAULT_ROLE_PRESERVATION_POLICY);
    expect(firstClass.turns.map((current) => current.speakerRole)).toEqual(["system", "user", "assistant", "tool"]);
    expect(policyDemoted.turns.map((current) => current.speakerRole)).toEqual(["user", "assistant"]);
    expect(policyDemoted.auxiliaryRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "role_policy_auxiliary",
          summary: "system content preserved as auxiliary provenance by role policy",
          preservedText: "policy",
        }),
        expect.objectContaining({
          kind: "role_policy_auxiliary",
          summary: "tool content preserved as auxiliary provenance by role policy",
          preservedText: "tool output",
        }),
      ]),
    );
  });

  it("extracts project name and updated thread name from Codex session metadata events", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "019e029c-45c5-7d81-a853-14f956eebdb7",
            cwd: "C:\\repos\\remotegpt",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "thread_name_updated",
            thread_name: "Interview RemoteCodex",
          },
        }),
        JSON.stringify({ role: "user", content: "hello" }),
      ].join("\n"),
    );

    expect(parsed.sessionId).toBe("019e029c-45c5-7d81-a853-14f956eebdb7");
    expect(parsed.projectName).toBe("remotegpt");
    expect(parsed.threadName).toBe("Interview RemoteCodex");
  });

  it("keeps only Codex Desktop user messages and final assistant answers as transcript turns", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "real user" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate user" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", phase: "commentary", message: "working update" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "duplicate assistant" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", phase: "final_answer", message: "final answer" },
        }),
      ].join("\n"),
    );

    expect(parsed.turns.map((turn) => [turn.speakerRole, turn.textualContent])).toEqual([
      ["user", "real user"],
      ["assistant", "final answer"],
    ]);
  });

  it("collapses adjacent duplicate user records emitted by Codex storage into one visible turn", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({ role: "user", content: "same user message\n" }),
        JSON.stringify({ role: "user", content: "same user message\n" }),
        JSON.stringify({ role: "assistant", content: "reply" }),
        JSON.stringify({ role: "user", content: "same user message\n" }),
      ].join("\n"),
    );

    expect(parsed.turns.map((turn) => [turn.speakerRole, turn.textualContent.trim()])).toEqual([
      ["user", "same user message"],
      ["assistant", "reply"],
      ["user", "same user message"],
    ]);
    expect(parsed.turns.map((turn) => turn.sourceSequenceIndex)).toEqual([0, 1, 2]);
  });

  it("documents the text-first projection and attachment omission rules", () => {
    expect(MIGRATABLE_CONVERSATIONAL_CONTENT_RULES).toHaveLength(6);
    expect(MIGRATABLE_CONVERSATIONAL_CONTENT_RULES[0]).toContain("User and assistant roles are always preserved");
    expect(MIGRATABLE_CONVERSATIONAL_CONTENT_RULES[4]).toContain("Attachment-only nodes are outside transcript text by default");
    expect(MIGRATABLE_CONVERSATIONAL_CONTENT_RULES[5]).toContain("side-branch");
  });

  it("keeps nested text, drops attachment-only content from transcript text, and records omission provenance", () => {
    const parsed = parseCodexSessionJsonl(
      [
        JSON.stringify({
          session_id: "session-2",
          title: "Nested Session",
          message: {
            role: "user",
            content: [
              { type: "input_text", text: "first line" },
              { type: "input_image", file_path: "C:/tmp/photo.png" },
              { type: "input_text", content: [{ type: "output_text", text: "second line" }] },
            ],
          },
        }),
        JSON.stringify({
          role: "user",
          content: [{ type: "input_image", file_path: "C:/tmp/only-attachment.png" }],
        }),
      ].join("\n"),
    );

    expect(parsed.hasOmittedAttachmentContent).toBe(true);
    expect(parsed.turns).toEqual([
      {
        speakerRole: "user",
        textualContent: "first line\nsecond line",
        sourceSequenceIndex: 0,
        sourceRecordIndex: 0,
        omittedAttachmentContent: true,
        disposition: "first_class_turn",
      },
    ]);
    expect(parsed.auxiliaryRecords).toContainEqual({
      kind: "attachment_omission",
      sourceRecordIndex: 1,
      summary: "Attachment-only user content omitted from transcript text",
      preservedText: null,
    });
  });
});

describe("selectTurnsForMigration", () => {
  it("preserves canonical timeline order and only promotes auxiliary omission records when policy requests it", () => {
    const selected = selectTurnsForMigration(
      history([turn("user", "one", 0, 0), turn("assistant", "two", 1, 2)], {
        auxiliaryRecords: [
          {
            kind: "attachment_omission",
            sourceRecordIndex: 1,
            summary: "Attachment-only tool content omitted from transcript text",
            preservedText: null,
          },
        ],
        hasOmittedAttachmentContent: true,
      }),
      {
        attachmentOmissionSemantic: "represented_by_absence_marker",
      },
    );

    expect(selected.map((current) => [current.logicalTurnKind, current.sourceRecordIndex, current.textualContent])).toEqual([
      ["source_turn", 0, "one"],
      ["omission_marker", 1, "[Attachment-derived content omitted by migration policy]"],
      ["source_turn", 2, "two"],
    ]);
  });
});

describe("renderTranscriptChunks", () => {
  it("splits logical turns into reassemblable transport chunks without affecting artifact identity or turn count", async () => {
    const longContent = "x".repeat(5000);
    const chunks = renderTranscriptChunks(
      {
        logicalTurnKind: "source_turn",
        speakerRole: "assistant",
        textualContent: longContent,
        sourceSequenceIndex: 7,
        sourceRecordIndex: 7,
        omittedAttachmentContent: false,
      },
      "transcript-1",
      "codex_full_transcript",
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => !chunk.content.includes("[Transcript"))).toBe(true);
    expect(chunks[0].content.startsWith("x")).toBe(true);
    expect(chunks[0].username).toBe("Codex");
    expect(chunks.map((chunk) => chunk.metadata.chunkIndex)).toEqual(chunks.map((_, index) => index));
    expect(chunks[0].metadata.logicalTurnId).toBe("source_turn-7-7-assistant");
    expect(chunks.at(-1)?.metadata.textEndOffsetExclusive).toBe(longContent.length);
    expect(reassembleTranscriptTurn(chunks)).toBe(longContent);

    const { migration } = migrationRig();
    const result = await migration.migrateHistory(history([turn("assistant", longContent, 0)]));
    expect(result.artifact.canonicalTimeline.logicalTurnCount).toBe(1);
    expect(result.transcriptId).toBe((await migration.migrateHistory(history([turn("assistant", longContent, 0)]))).transcriptId);
  });
});

describe("ontology boundary guards", () => {
  it("accepts a well-formed transcript artifact and rejects artifacts that mix transcript, provenance, and chunk layers", () => {
    const artifact: TranscriptArtifact = {
      primaryEntity: "transcript_artifact",
      transcriptId: "transcript-1",
      transcriptKind: "codex_full_transcript",
      completenessBasis: "text_first_timeline_relative",
      completenessStatus: "full_text_preserved",
      approvalScope: "not_required",
      identityPolicy: {
        sourceSessionId: "session-1",
        sessionBoundaryPolicy: "single_canonical_source_session",
        contentProjectionPolicy: "text_first_projection",
        revisionResolutionPolicy: "canonical_visible_timeline",
        omissionSemantics: "excluded_outside_transcript",
        transcriptScope: "full_history",
      },
      sourceProvenance: {
        sourceSessionId: "session-1",
        sourcePath: "C:/codex/session-1.jsonl",
        threadName: "Windows Codex",
      },
      canonicalTimeline: {
        turns: [
          {
            logicalTurnKind: "source_turn",
            speakerRole: "user",
            textualContent: "hello",
            sourceSequenceIndex: 0,
            sourceRecordIndex: 0,
            omittedAttachmentContent: false,
          },
        ],
        logicalTurnCount: 1,
      },
      auxiliaryProvenance: [],
    };

    expect(() => assertTranscriptArtifactBoundary(artifact)).not.toThrow();
    expect(() =>
      assertTranscriptArtifactBoundary({
        ...artifact,
        canonicalTimeline: {
          turns: [{ ...artifact.canonicalTimeline.turns[0], chunkIndex: 0 }],
          logicalTurnCount: 1,
        },
      }),
    ).toThrow("Transcript turns must not contain transport chunk fields");
    expect(() =>
      assertTranscriptArtifactBoundary({
        ...artifact,
        auxiliaryProvenance: [{ ...artifact.canonicalTimeline.turns[0] }],
      }),
    ).toThrow("Auxiliary provenance must not be shaped as transcript turns");
  });

  it("rejects chunk metadata that mixes transport with artifact-level completeness or provenance", () => {
    const chunk = renderTranscriptChunks(
      {
        logicalTurnKind: "source_turn",
        speakerRole: "assistant",
        textualContent: "hello",
        sourceSequenceIndex: 0,
        sourceRecordIndex: 0,
        omittedAttachmentContent: false,
      },
      "transcript-1",
      "codex_full_transcript",
    )[0];

    expect(() => assertTranscriptChunkBoundary(chunk)).not.toThrow();
    expect(() =>
      assertTranscriptChunkBoundary({
        ...chunk,
        metadata: { ...chunk.metadata, completenessStatus: "full_text_preserved" },
      }),
    ).toThrow("Transport chunk metadata must not carry artifact-level completeness or provenance fields");
  });
});

describe("resolveCodexSessionSource", () => {
  it("accepts explicit filesystem paths and keeps them separate from the logical session id", () => {
    expect(
      resolveCodexSessionSource(
        { filePath: "C:\\codex\\session-1.jsonl" },
        [{ id: "session-1", threadName: "Windows Codex", storagePath: "C:/codex/session-1.jsonl" }],
      ),
    ).toEqual({
      logicalSessionId: "session-1",
      storagePath: "C:/codex/session-1.jsonl",
      threadName: "Windows Codex",
      resolvedBy: "filePath",
    });
  });

  it("rejects ambiguous session id references", () => {
    expect(() =>
      resolveCodexSessionSource(
        { sessionId: "session-1" },
        [
          { id: "session-1", threadName: "one", storagePath: "C:/codex/one.jsonl" },
          { id: "session-1", threadName: "two", storagePath: "C:/codex/two.jsonl" },
        ],
      ),
    ).toThrow(CodexSessionSourceReferenceError);
  });

  it("rejects mismatched session-id and file-path references", () => {
    expect(() =>
      resolveCodexSessionSource(
        { sessionId: "session-2", filePath: "C:/codex/session-1.jsonl" },
        [{ id: "session-1", threadName: "Windows Codex", storagePath: "C:/codex/session-1.jsonl" }],
      ),
    ).toThrow(CodexSessionSourceReferenceError);
  });
});

describe("migration policy constants", () => {
  it("documents chunk transport semantics and completeness basis", () => {
    expect(TRANSCRIPT_CHUNK_POLICY).toContain("subordinate to logical transcript turns");
    expect(TRANSCRIPT_COMPLETENESS_BASIS).toHaveLength(4);
    expect(TRANSCRIPT_COMPLETENESS_BASIS[0]).toContain("text-first, timeline-relative, and policy-relative");
    expect(TRANSCRIPT_COMPLETENESS_BASIS[3]).toContain("separately approved excerpt class");
  });
});

describe("vitest prerequisite enforcement", () => {
  it("detects expected rolldown binding names for the current platform matrix", () => {
    expect(detectExpectedRolldownBindings("linux", "x64")).toEqual([
      "binding-linux-x64-gnu",
      "binding-linux-x64-musl",
    ]);
    expect(detectExpectedRolldownBindings("win32", "arm64")).toEqual(["binding-win32-arm64-msvc"]);
  });

  it("returns actionable failures when optional native dependencies are unavailable", () => {
    const missingDir = verifyVitestBindingsInstalled({
      rootDir: "/repo",
      existsSync: () => false,
      platform: "linux",
      arch: "x64",
    });
    const missingBinding = verifyVitestBindingsInstalled({
      rootDir: "/repo",
      existsSync: (path) => path.replace(/\\/g, "/") === "/repo/node_modules/@rolldown",
      platform: "linux",
      arch: "x64",
    });

    expect(missingDir.ok).toBe(false);
    expect(missingDir.message).toContain("Reinstall dependencies before running vitest.");
    expect(missingBinding.ok).toBe(false);
    expect(missingBinding.message).toContain("binding-linux-x64-gnu");
    expect(missingBinding.message).toContain("linux-x64");
  });
});

describe("TranscriptTailer", () => {
  it("appends only transcript turns not already present in the Discord channel", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => [
        {
          id: "1",
          username: "User",
          content: "already sent",
        },
      ]),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({ session_id: "session-1", role: "user", content: "already sent" }),
        JSON.stringify({ session_id: "session-1", role: "assistant", content: "new reply" }),
      ].join("\n"),
    );

    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: false,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    vi.mocked(discord.fetchChannelMessages);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([{ username: "bot", content: "new reply" }]);
  });

  it("skips system turns when tailing a live transcript channel", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-system-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({ session_id: "session-1", role: "system", content: "hidden system" }),
        JSON.stringify({ session_id: "session-1", role: "user", content: "visible user" }),
        JSON.stringify({ session_id: "session-1", role: "assistant", content: "visible assistant" }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: false,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-system-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([
      { username: "User", content: "visible user" },
      { username: "bot", content: "visible assistant" },
    ]);
  });

  it("skips Discord-origin user echoes while tailing Windows-origin user turns in chat-enabled transcript channels", async () => {
    const sent: Array<{ username: string; content: string; avatarUrl?: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => [
        {
          id: "1",
          username: "real-discord-user",
          content: "hello from discord",
          bot: false,
          webhook: false,
          avatarUrl: "https://cdn.example/avatar.png",
        },
      ]),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content, avatarUrl: message.avatarUrl });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-chat-enabled-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({ session_id: "session-1", role: "user", content: "hello from discord" }),
        JSON.stringify({ session_id: "session-1", role: "user", content: "hello from windows codex" }),
        JSON.stringify({ session_id: "session-1", role: "assistant", content: "assistant reply" }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-chat-enabled-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([
      { username: "User", content: "hello from windows codex", avatarUrl: "https://cdn.example/avatar.png" },
      { username: "bot", content: "assistant reply" },
    ]);
  });

  it("does not mark bot messages as already-sent user turns", async () => {
    const sent: Array<{ username: string; content: string; avatarUrl?: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => [
        {
          id: "1",
          username: "지피쨩",
          content: "same text",
          bot: true,
          webhook: false,
        },
      ]),
      fetchLatestHumanAvatarUrl: vi.fn(async () => "https://cdn.example/avatar.png"),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content, avatarUrl: message.avatarUrl });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-bot-dedupe-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(sourceSessionPath, JSON.stringify({ session_id: "session-1", role: "user", content: "same text" }));
    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-bot-dedupe-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([{ username: "User", content: "same text", avatarUrl: "https://cdn.example/avatar.png" }]);
  });

  it("skips overlapping tail ticks so slow syncs cannot duplicate webhook sends", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    let releaseFetch: (() => void) | undefined;
    let notifyFetchStarted: () => void = () => undefined;
    const actualFetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      fetchChannelMessages: vi.fn(async () => {
        notifyFetchStarted();
        await new Promise<void>((release) => {
          releaseFetch = release;
        });
        return [];
      }),
      fetchLatestHumanAvatarUrl: vi.fn(async () => undefined),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-overlap-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(sourceSessionPath, JSON.stringify({ session_id: "session-1", role: "user", content: "overlap" }));
    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const onDebug = vi.fn();
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-overlap-${Date.now()}.json`,
      onDebug,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    const firstTick = tailer.tick();
    await actualFetchStarted;
    const secondTick = tailer.tick();
    await secondTick;
    releaseFetch?.();
    await firstTick;

    expect(discord.fetchChannelMessages).toHaveBeenCalledTimes(1);
    expect(onDebug).toHaveBeenCalledWith("Transcript tailer tick skipped because previous tick is still running");
    expect(sent).toEqual([{ username: "User", content: "overlap" }]);
  });

  it("does not tail regular chat turns for Codex-origin live session mappings", async () => {
    const sent: Array<{ username: string; content: string; avatarUrl?: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      fetchLatestHumanAvatarUrl: vi.fn(async () => "https://cdn.example/server-avatar.png"),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content, avatarUrl: message.avatarUrl });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-live-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({ session_id: "session-1", role: "user", content: "live user" }),
        JSON.stringify({ session_id: "session-1", role: "assistant", content: "live reply" }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-live-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([]);
  });

  it("tails Codex Desktop commentary agent messages as streamed assistant updates", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-stream-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-12T11:53:38.455Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "working update",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-12T11:53:54.338Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "final answer",
          },
        }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "transcript",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: "transcript-1",
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: false,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-stream-${Date.now()}.json`,
      speakerLabels: {
        user: "User",
        assistant: "Codex",
      },
    });

    await tailer.tick();

    expect(sent).toEqual([
      { username: "bot", content: "working update\n\u200B" },
      { username: "bot", content: "final answer" },
    ]);
  });

  it("tails final answers for live sessions when the bridge misses the response", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-live-final-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-12T11:53:54.338Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "late final answer",
          },
        }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-live-final-${Date.now()}.json`,
    });

    await tailer.tick();

    expect(sent).toEqual([{ username: "bot", content: "late final answer" }]);
  });

  it("delays fresh live final answers so the bridge can send the primary response first", async () => {
    const sent: Array<{ username: string; content: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push({ username: "bot", content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async (_channelId, message) => {
        sent.push({ username: message.username, content: message.content });
      }),
    };
    const sourceSessionPath = `output/test/session-tail-live-final-delay-${Date.now()}.jsonl`;
    await mkdir("output/test", { recursive: true });
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-12T11:53:54.338Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "fresh final answer",
          },
        }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const statePath = `output/test/transcript-tail-live-final-delay-${Date.now()}.json`;
    const tailer = new TranscriptTailer(store, discord, {
      statePath,
      liveFinalAnswerDelayMs: 10000,
      now: () => new Date("2026-05-12T11:53:55.000Z"),
    });

    await tailer.tick();

    expect(sent).toEqual([]);
    await expect(readFile(statePath, "utf8").then((content) => JSON.parse(content))).resolves.toMatchObject({
      channels: {
        "discord-1": {
          sentKeys: [],
        },
      },
    });
    await expect(readFile(statePath, "utf8").then((content) => JSON.parse(content).channels["discord-1"])).resolves.not.toHaveProperty(
      "lastSourceRecordIndex",
    );
  });

  it("uploads image attachments discovered from assistant body, payload fields, and configured output dirs", async () => {
    const sentFiles: Array<{ files: string[]; content?: string }> = [];
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      sendFiles: vi.fn(async (_channelId, files, content) => {
        sentFiles.push({ files, content });
      }),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async () => undefined),
    };
    const testDir = resolve(`output/test/session-tail-images-${Date.now()}`);
    const bodyImagePath = resolve(testDir, "body.png");
    const payloadImagePath = resolve(testDir, "payload.webp");
    const outputDir = resolve(testDir, "generated");
    const outputImagePath = resolve(outputDir, "novelai.jpg");
    const sourceSessionPath = resolve(testDir, "session.jsonl");
    await mkdir(outputDir, { recursive: true });
    await writeFile(bodyImagePath, "body-image");
    await writeFile(payloadImagePath, "payload-image");
    await writeFile(outputImagePath, "output-image");
    await writeFile(
      sourceSessionPath,
      [
        JSON.stringify({
          session_id: "session-1",
          role: "assistant",
          content: `created image ![result](${bodyImagePath})`,
        }),
        JSON.stringify({
          session_id: "session-1",
          role: "tool",
          content: "payload image",
          file_path: payloadImagePath,
        }),
      ].join("\n"),
    );
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    vi.stubEnv("REMOTE_CODEX_IMAGE_OUTPUT_DIRS", outputDir);
    const tailer = new TranscriptTailer(store, discord, {
      statePath: resolve(testDir, "tail-state.json"),
    });

    await tailer.tick();
    await tailer.tick();

    expect(sentFiles.map((item) => item.files[0]).sort()).toEqual(
      [bodyImagePath, outputImagePath, payloadImagePath].sort(),
    );
    expect(sentFiles.every((item) => item.content === undefined)).toBe(true);
  });

  it("archives active tail mappings when the Discord channel no longer exists", async () => {
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      fetchChannelMessages: vi.fn(async () => {
        throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
      }),
      sendWebhookMessage: vi.fn(async () => undefined),
    };
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "deleted-discord-channel",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath: "output/test/missing-channel-source.jsonl",
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const onError = vi.fn();
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-missing-channel-${Date.now()}.json`,
      onError,
    });

    await tailer.tick();

    expect(onError).not.toHaveBeenCalled();
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        mappingState: "archived",
        terminationMode: "delete",
        archivedAt: expect.any(String),
      }),
    ]);
  });

  it("does not treat a temporarily missing source session file as a tailer failure", async () => {
    const discord: DiscordGateway = {
      createSessionChannel: vi.fn(async (name: string) => ({ id: `channel-${name}`, name })),
      deleteChannel: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      fetchChannelMessages: vi.fn(async () => []),
      sendWebhookMessage: vi.fn(async () => undefined),
    };
    const store = new InMemorySessionStore([
      {
        mappingKind: "live_session",
        discordChannelId: "discord-1",
        codexSessionId: "session-1",
        transcriptId: null,
        sourceSessionPath: `output/test/does-not-exist-${Date.now()}.jsonl`,
        mappingState: "active",
        origin: "codex",
        chatEnabled: true,
        streamingEnabled: false,
        lifecycleSyncEnabled: true,
        createdAt: "2026-05-07T00:00:00.000Z",
        archivedAt: null,
        terminationMode: null,
      },
    ]);
    const onError = vi.fn();
    const tailer = new TranscriptTailer(store, discord, {
      statePath: `output/test/transcript-tail-missing-source-${Date.now()}.json`,
      onError,
    });

    await tailer.tick();

    expect(onError).not.toHaveBeenCalled();
    expect(discord.sendMessage).not.toHaveBeenCalled();
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ mappingState: "active" })]);
  });
});
