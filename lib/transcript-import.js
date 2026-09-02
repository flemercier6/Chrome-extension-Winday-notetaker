// Parses a transcript the user pastes in as a file, so a call that was never
// recorded by the extension (or whose audio never made it to Storage) can still
// be turned into a real meeting: same row, same summary, same CRM entry.
//
// The formats people actually have are messy, so the parser is deliberately
// tolerant. It understands, in any mix:
//
//   You: hello everyone            ← "Speaker: text" on one line
//   Camilla                        ← a speaker on its own line…
//   hello everyone                 ← …followed by what they said
//   [00:12:04] Fred: hello         ← leading timestamps, any common bracket
//   WEBVTT / 00:00:01.000 --> …    ← VTT and SRT cue scaffolding (dropped)
//
// With no speaker markers at all it keeps the paragraphs and labels them
// "Speaker" — an honest "we don't know who said what" rather than a guess.

/** The app's own label for the user; the summarizer keys off it. */
const SELF = "You";
const SELF_ALIASES = new Set(["you", "me", "moi", "vous", "je"]);

// A speaker label is short, has no sentence punctuation, and is at most a few
// words — enough to accept "Fred", "Participant 1", "Camilla Dupont (Winday)"
// while rejecting an ordinary sentence that happens to contain a colon.
const MAX_SPEAKER_LEN = 48;
const MAX_SPEAKER_WORDS = 6;

/** Cue scaffolding from .vtt / .srt exports — never speech. */
function isCueLine(line) {
  return (
    /^WEBVTT\b/i.test(line) ||
    /^NOTE\b/i.test(line) ||
    /^\d+$/.test(line) ||
    /-->/.test(line)
  );
}

/** Strips a leading timestamp: "[00:12]", "(1:02:03)", "00:12:04.500 - ", … */
function stripTimestamp(line) {
  return line
    .replace(/^[[(<{]\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*[\])>}]\s*/, "")
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*[-–—]?\s*/, "");
}

function normalizeSpeaker(raw) {
  const name = raw.trim().replace(/\s+/g, " ");
  return SELF_ALIASES.has(name.toLowerCase()) ? SELF : name;
}

function looksLikeSpeaker(candidate) {
  const s = candidate.trim();
  if (!s || s.length > MAX_SPEAKER_LEN) return false;
  if (/[.!?;]/.test(s)) return false;
  return s.split(/\s+/).length <= MAX_SPEAKER_WORDS;
}

/**
 * @param {string} text  the file's contents
 * @returns {{fullText:string, utterances:Array<{speaker,text,start,end}>, language:null}}
 *          the same transcript shape the live recorder produces.
 */
export function parseTranscript(text) {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  const utterances = [];
  let speaker = null;      // the speaker of the block being read
  let current = null;      // the utterance being accumulated
  let sawSpeaker = false;

  const push = (who, said) => {
    const t = said.trim();
    if (!t) return;
    // Same speaker continuing after a blank line reads as one turn.
    if (current && current.speaker === who) current.text += " " + t;
    else utterances.push((current = { speaker: who, text: t }));
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) { current = null; continue; }  // blank line ends the turn
    if (isCueLine(trimmed)) continue;            // before stripping: a cue line
    const line = stripTimestamp(trimmed);        // starts with a timestamp too
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon > 0 && looksLikeSpeaker(line.slice(0, colon))) {
      speaker = normalizeSpeaker(line.slice(0, colon));
      sawSpeaker = true;
      current = null;                          // a label always starts a turn
      push(speaker, line.slice(colon + 1));
      continue;
    }
    // A bare label on its own line: whatever follows is theirs.
    if (!current && looksLikeSpeaker(line) && !/\s{2,}/.test(line)) {
      speaker = normalizeSpeaker(line);
      sawSpeaker = true;
      continue;
    }
    push(speaker || "Speaker", line);
  }

  // Nothing looked like a speaker: keep the paragraphs, claim no attribution.
  if (!sawSpeaker) for (const u of utterances) u.speaker = "Speaker";

  // Synthetic timings keep the utterances ordered for everything downstream.
  utterances.forEach((u, i) => { u.start = i; u.end = i + 1; });

  return {
    fullText: utterances.map((u) => u.text).join(" "),
    utterances,
    language: null,
  };
}

/** A meeting title from the file's name — "" when it says nothing useful. */
export function titleFromFilename(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  if (!base || /^(transcript|transcription|notes?|untitled|export)$/i.test(base)) return "";
  return base;
}
