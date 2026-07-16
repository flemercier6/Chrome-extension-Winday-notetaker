// Runs the post-recording pipeline through the shared Supabase backend:
// upload audio -> insert row -> transcribe -> summarize -> optionally export.
// Mirrors the macOS app's PipelineCoordinator, including its failure policy:
// once a stage's result is obtained it is never thrown away. If summarize fails
// we keep the transcript; if export fails we keep the summary. Only
// upload/transcribe failures (nothing kept yet) reject.
import * as sb from "./supabase.js";

export const STAGE_LABELS = {
  uploading: "Preparing…",
  transcribing: "Transcribing…",
  summarizing: "Summarizing…",
  exporting: "Saving notes…",
  done: "Done",
};

/**
 * @param {Blob} blob   the recorded audio (stereo webm/opus: L = you, R = them)
 * @param {object} meeting  { id, title, startedAt, endedAt, calendar? }
 * @param {object} opts  { settings, onStage(stageKey) }
 * @returns {Promise<object>} the finished meeting (may carry errorMessage if a
 *          late stage failed but an earlier result was preserved)
 */
export async function process(blob, meeting, opts) {
  const { settings, onStage = () => {} } = opts;
  const m = { ...meeting };

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");

  // 1) Upload + create the row (throws — nothing kept yet).
  onStage("uploading");
  const audioPath = `${userId}/${m.id}.webm`;
  await sb.uploadRecording(blob, audioPath, "audio/webm");
  m.audioPath = audioPath;

  const stoppedAt = m.endedAt || new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(stoppedAt).getTime() - new Date(m.startedAt).getTime()) / 1000,
  );
  const payload = {
    id: m.id,
    user_id: userId,
    meeting_title: m.title,
    status: "recorded",
    audio_path: audioPath,
    started_at: m.startedAt,
    stopped_at: stoppedAt,
    duration_seconds: Math.max(0, durationSeconds),
  };
  if (m.calendar) {
    if (m.calendar.meetURL) payload.meeting_url = m.calendar.meetURL;
    const calMeta = {
      google_event_id: m.calendar.googleEventID,
      contact_ids: m.calendar.contactIDs || [],
    };
    if (m.calendar.companyID) calMeta.company_id = m.calendar.companyID;
    if (m.calendar.companyName) calMeta.company_name = m.calendar.companyName;
    if (m.calendar.companyLogoURL) calMeta.company_logo_url = m.calendar.companyLogoURL;
    payload.metadata = { calendar: calMeta };
  }
  await sb.insertMeeting(payload);

  if (m.calendar && (m.calendar.contactIDs || []).length > 0) {
    try {
      await sb.linkMeetingContacts(m.id, m.calendar.contactIDs, userId);
    } catch (_) {
      /* non-fatal */
    }
  }

  // 2) Transcribe (throws — no transcript yet).
  onStage("transcribing");
  const tr = await sb.invokeRaw("transcribe", {
    meeting_id: m.id,
    deepgram_model: settings.deepgramModel,
  });
  m.transcript = tr.transcript;

  // 2b) Resolve who was in the call + link CRM contacts (best-effort).
  try {
    await sb.invokeRaw("enrich-meeting", { meeting_id: m.id });
  } catch (_) {
    /* best-effort */
  }

  // 3) Summarize — KEEP the transcript if this fails.
  onStage("summarizing");
  try {
    const sr = await sb.invokeRaw("summarize", {
      meeting_id: m.id,
      gemini_model: settings.geminiModel,
      custom_prompt: settings.summaryPrompt,
      summary_length: settings.summaryLength,
    });
    m.summary = sr.summary;
    if (!m.title || m.title.startsWith("Meeting ")) {
      m.title = sr.summary.headline || m.title;
    }
    m.status = "ready";
    m.errorMessage = null;
  } catch (e) {
    m.status = "failed";
    m.errorMessage = `Summary failed: ${e.message}`;
    return m;
  }

  // 4) Export to Notion — KEEP the summary if this fails.
  if (settings.autoExportToNotion && settings.notionDatabaseID) {
    onStage("exporting");
    m.status = "exporting";
    try {
      const ex = await sb.invokeRaw("export-notion", {
        meeting_id: m.id,
        notion_database_id: settings.notionDatabaseID,
      });
      m.notionPageURL = ex.url;
      m.status = "exported";
    } catch (e) {
      m.status = "ready";
      m.errorMessage = `Notion export failed: ${e.message}`;
    }
  }

  onStage("done");
  return m;
}

/**
 * Live-transcript path: the transcript was produced in real time during the
 * call, so we skip the Deepgram batch pass. Upload the audio, insert the row
 * WITH the transcript, then enrich → summarize → export.
 * @param {Blob} blob
 * @param {object} meeting
 * @param {{fullText:string, utterances:Array, language:?string}} transcript
 * @param {object} opts { settings, onStage }
 */
export async function processLive(blob, meeting, transcript, opts) {
  const { settings, onStage = () => {} } = opts;
  const m = { ...meeting };

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");

  onStage("uploading");
  const audioPath = `${userId}/${m.id}.webm`;
  await sb.uploadRecording(blob, audioPath, "audio/webm");
  m.audioPath = audioPath;

  const stoppedAt = m.endedAt || new Date().toISOString();
  const durationSeconds = Math.max(0, Math.round(
    (new Date(stoppedAt).getTime() - new Date(m.startedAt).getTime()) / 1000,
  ));
  const labelled = transcript.utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
  const metadata = {
    transcript: {
      fullText: transcript.fullText,
      utterances: transcript.utterances,
      language: transcript.language || null,
    },
  };
  if (m.calendar) {
    const calMeta = {
      google_event_id: m.calendar.googleEventID,
      contact_ids: m.calendar.contactIDs || [],
    };
    if (m.calendar.companyID) calMeta.company_id = m.calendar.companyID;
    if (m.calendar.companyName) calMeta.company_name = m.calendar.companyName;
    if (m.calendar.companyLogoURL) calMeta.company_logo_url = m.calendar.companyLogoURL;
    metadata.calendar = calMeta;
  }

  const payload = {
    id: m.id,
    user_id: userId,
    meeting_title: m.title,
    status: "summarizing",
    audio_path: audioPath,
    started_at: m.startedAt,
    stopped_at: stoppedAt,
    duration_seconds: durationSeconds,
    transcript: labelled,
    metadata,
  };
  if (m.calendar && m.calendar.meetURL) payload.meeting_url = m.calendar.meetURL;
  await sb.insertMeeting(payload);
  m.transcript = metadata.transcript;

  if (m.calendar && (m.calendar.contactIDs || []).length > 0) {
    try { await sb.linkMeetingContacts(m.id, m.calendar.contactIDs, userId); } catch (_) { /* non-fatal */ }
  }

  try { await sb.invokeRaw("enrich-meeting", { meeting_id: m.id }); } catch (_) { /* best-effort */ }

  onStage("summarizing");
  try {
    const sr = await sb.invokeRaw("summarize", {
      meeting_id: m.id,
      gemini_model: settings.geminiModel,
      custom_prompt: settings.summaryPrompt,
      summary_length: settings.summaryLength,
    });
    m.summary = sr.summary;
    if (!m.title || m.title.startsWith("Meeting ")) m.title = sr.summary.headline || m.title;
    m.status = "ready";
    m.errorMessage = null;
  } catch (e) {
    m.status = "failed";
    m.errorMessage = `Summary failed: ${e.message}`;
    return m;
  }

  if (settings.autoExportToNotion && settings.notionDatabaseID) {
    onStage("exporting");
    m.status = "exporting";
    try {
      const ex = await sb.invokeRaw("export-notion", {
        meeting_id: m.id,
        notion_database_id: settings.notionDatabaseID,
      });
      m.notionPageURL = ex.url;
      m.status = "exported";
    } catch (e) {
      m.status = "ready";
      m.errorMessage = `Notion export failed: ${e.message}`;
    }
  }

  onStage("done");
  return m;
}

/** Re-run only the stages that have not produced a result yet (Retry). */
export async function retry(meeting, opts) {
  const { settings, onStage = () => {} } = opts;
  const m = { ...meeting };
  m.errorMessage = null;

  if (!m.audioPath) throw new Error("This recording was never uploaded — record again.");

  if (!m.transcript) {
    onStage("transcribing");
    const tr = await sb.invokeRaw("transcribe", {
      meeting_id: m.id,
      deepgram_model: settings.deepgramModel,
    });
    m.transcript = tr.transcript;
  }
  if (!m.summary) {
    try {
      await sb.invokeRaw("enrich-meeting", { meeting_id: m.id });
    } catch (_) {}
    onStage("summarizing");
    const sr = await sb.invokeRaw("summarize", {
      meeting_id: m.id,
      gemini_model: settings.geminiModel,
      custom_prompt: settings.summaryPrompt,
      summary_length: settings.summaryLength,
    });
    m.summary = sr.summary;
    if (!m.title || m.title.startsWith("Meeting ")) m.title = sr.summary.headline || m.title;
    m.status = "ready";
  }
  if (settings.autoExportToNotion && settings.notionDatabaseID && !m.notionPageURL) {
    onStage("exporting");
    const ex = await sb.invokeRaw("export-notion", {
      meeting_id: m.id,
      notion_database_id: settings.notionDatabaseID,
    });
    m.notionPageURL = ex.url;
    m.status = "exported";
  }
  onStage("done");
  m.errorMessage = null;
  return m;
}

/** Export an already-summarized meeting to Notion (explicit action). */
export async function exportToNotion(meeting, settings) {
  const ex = await sb.invokeRaw("export-notion", {
    meeting_id: meeting.id,
    notion_database_id: settings.notionDatabaseID,
  });
  return ex.url;
}
