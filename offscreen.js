// The offscreen recording host: consumes tabCapture stream ids (the SILENT
// capture path) and runs the shared recording engine. Living outside any tab,
// it survives tab closes and service-worker suspensions for the whole
// multi-minute pipeline. It has NO chrome.storage access — the background
// hands it session + settings in each message, and every persistable change
// goes back through the WN_* report protocol.
//
// Retry / export of PAST meetings also run here (pure fetch work).
import * as pipeline from "./lib/pipeline.js";
import { createRecorder, acquireMic, configureSession, report } from "./lib/capture.js";

let recorder = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  switch (msg.type) {
    case "START":
      startRecording(msg).catch((e) => {
        if (recorder) recorder.failNow(e);
        else report({ type: "WN_REC_FAILED", error: String(e?.message || e) });
      });
      break;
    case "STOP":
      recorder?.stop(false);
      break;
    case "CANCEL":
      recorder?.stop(true);
      break;
    case "RETRY":
      retryMeeting(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "EXPORT":
      exportMeeting(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
  }
});

async function startRecording({ streamId, meeting, session, settings }) {
  // Tab audio (the remote participants) minted by chrome.tabCapture.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });
  const micStream = await acquireMic();

  recorder = createRecorder();
  await recorder.start({
    tabStream,
    micStream,
    monitorTab: true, // tabCapture silences the tab; keep the call audible
    meeting,
    session,
    settings,
  });
}

async function retryMeeting({ meeting, session, settings }) {
  if (!meeting) throw new Error("Meeting not found.");
  configureSession(session);
  try {
    const result = await pipeline.retry(meeting, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    report({ type: "WN_MEETING_UPSERT", meeting: result });
    report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function exportMeeting({ meeting, session, settings }) {
  if (!meeting || !meeting.summary) throw new Error("Nothing to export yet.");
  configureSession(session);
  report({ type: "WN_REC_STAGE", stage: "exporting" });
  try {
    const url = await pipeline.exportToNotion(meeting, settings);
    const updated = { ...meeting, notionPageURL: url, status: "exported", errorMessage: null };
    report({ type: "WN_MEETING_UPSERT", meeting: updated });
    report({ type: "WN_REC_DONE", notionURL: url, meetingId: meeting.id });
  } catch (e) {
    report({ type: "WN_REC_FAILED", error: String(e?.message || e) });
  }
}
