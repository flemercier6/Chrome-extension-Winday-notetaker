// Parses a transcript the user brings in as a file, so a call that was never
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
//   Camilla   00:12                ← trailing timestamps on a speaker line
//   WEBVTT / 00:00:01.000 --> …    ← VTT and SRT cue scaffolding (dropped)
//
// The hard part is NOT the syntax, it is deciding what is a speaker at all.
// Judging each line on its own shape splits a call to pieces: "Ok parfait" is
// short, capitalised and punctuation-free, so it reads exactly like a name and
// becomes a bogus speaker, and every reply after it is attributed to it. So the
// parser reads the file TWICE — first to work out the cast (who recurs, who is
// introduced with a colon), then to split it, trusting only that cast.
//
// With no speaker markers at all it keeps the paragraphs and labels them
// "Speaker" — an honest "we don't know who said what" rather than a guess.

/** The app's own label for the user; the summarizer keys off it. */
export const SELF = "You";
const SELF_ALIASES = new Set(["you", "me", "moi", "vous", "je"]);

// Generic labels a transcript tool would emit — always a speaker, whatever
// else the file looks like.
const GENERIC_LABEL = /^(you|me|moi|vous|je|speaker|spk|participant|intervenant|locuteur|interlocuteur)\s*\d*$/i;

const MAX_LABEL_LEN = 40;
const MAX_LABEL_WORDS = 5;

/** Cue scaffolding from .vtt / .srt exports — never speech. */
function isCueLine(line) {
  // NOTE is matched case-SENSITIVELY, as the VTT spec writes it: a French
  // transcript line "Note: rappel du contexte" is speech, not a cue comment.
  return /^WEBVTT\b/i.test(line) || /^NOTE(\s|$)/.test(line) || /^\d+$/.test(line) || /-->/.test(line);
}

const LEAD_TS = /^(?:[[(<{]\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(?:[\])>}]|[-–—])?\s*/;
const TRAIL_TS = /\s*[[(<{]?\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*[\])>}]?\s*$/;

/** One source line, pre-chewed: the speech text, the same text with a trailing
 *  timestamp removed (that is what a bare speaker line looks like in a Meet or
 *  Teams export), and whether a timestamp was there at all — a name followed by
 *  a timestamp is a speaker line, prose is not. */
function prepare(raw) {
  const text = raw.trim().replace(LEAD_TS, "").trim();
  const bareText = text.replace(TRAIL_TS, "").trim();
  return { text, bareText, hadTs: text !== raw.trim() || bareText !== text };
}

/** Could this text be a speaker label at all — by shape alone? */
function labelShaped(s) {
  const t = s.trim();
  if (!t || t.length > MAX_LABEL_LEN) return false;
  if (/[.!?;,:]/.test(t)) return false;
  return t.split(/\s+/).length <= MAX_LABEL_WORDS;
}

/** The label candidates a single line offers, if any: `colon` for "Name: said",
 *  `bare` for a line that is nothing but a name (with an optional timestamp
 *  after it, which is how Meet and Teams exports write a speaker). A line that
 *  is entirely a label is never also read as a colon split of itself. */
function candidates(line) {
  const bare = labelShaped(line.bareText) ? normalizeSpeaker(line.bareText) : null;
  if (bare) return { colon: null, bare };

  const i = line.text.indexOf(":");
  if (i > 0 && line.text.slice(i + 1).trim() && labelShaped(line.text.slice(0, i))) {
    return { colon: normalizeSpeaker(line.text.slice(0, i)), bare: null };
  }
  return { colon: null, bare: null };
}

/** Does it read like a NAME (not a short sentence)? Every word capitalised —
 *  "Camilla Dupont" and "Participant 1" pass, "Ok parfait" does not. */
function nameLike(s) {
  const t = s.trim();
  if (GENERIC_LABEL.test(t)) return true;
  if (!labelShaped(t)) return false;
  const words = t.replace(/[()]/g, "").split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  return words.every((w) => /^[\d(]/.test(w) || w[0] === w[0].toUpperCase());
}

function normalizeSpeaker(raw) {
  const name = raw.trim().replace(TRAIL_TS, "").replace(/\s+/g, " ").trim();
  return SELF_ALIASES.has(name.toLowerCase()) ? SELF : name;
}

/** Pass 1 — who is actually in this call. Returns the set of labels the split
 *  is allowed to trust. */
function findCast(lines) {
  const colon = new Map();
  const bare = new Map();
  const timestamped = new Set(); // bare labels that came with a timestamp
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  let colonLines = 0;

  for (const line of lines) {
    const c = candidates(line);
    if (c.colon) { bump(colon, c.colon); colonLines++; }
    else if (c.bare) {
      bump(bare, c.bare);
      if (line.hadTs) timestamped.add(c.bare);
    }
  }

  // Two different files, two different levels of trust. When most lines are
  // "Name: said", the colon IS the format and a name in front of one is a
  // speaker even if they only spoke once. Without that structure all we have
  // is a bare line that looks like a name — and so does "Parfait", so it has
  // to recur before we believe it.
  const colonFormatted = colonLines >= lines.length * 0.4;
  const cast = new Set();
  for (const [name, n] of colon) {
    if (GENERIC_LABEL.test(name) || n >= 2 || (colonFormatted && nameLike(name))) cast.add(name);
  }
  for (const [name, n] of bare) {
    // A name with a timestamp beside it is structure, not coincidence: one
    // occurrence is enough ("Camilla Roux  00:31"). Otherwise it must recur.
    if (GENERIC_LABEL.test(name) || n >= 2 || (timestamped.has(name) && nameLike(name))) cast.add(name);
  }
  return cast;
}

/**
 * @param {string} text  the file's contents
 * @returns {{fullText:string, utterances:Array<{speaker,text,start,end}>,
 *            language:null, speakers:Array<{name:string, turns:number}>}}
 *          the transcript shape the live recorder produces, plus the cast the
 *          parser settled on (so the UI can show and correct it).
 */
export function parseTranscript(text) {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isCueLine(l))
    .map(prepare)
    .filter((l) => l.text);

  const cast = findCast(lines);
  const utterances = [];
  let speaker = null;
  let current = null;

  const push = (who, said) => {
    const t = said.trim();
    if (!t) return;
    if (current && current.speaker === who) current.text += " " + t;
    else utterances.push((current = { speaker: who, text: t }));
  };

  for (const line of lines) {
    const c = candidates(line);
    if (c.bare && cast.has(c.bare)) {   // the label alone: what follows is theirs
      speaker = c.bare;
      current = null;
      continue;
    }
    if (c.colon && cast.has(c.colon)) { // "Camilla: …" — a turn starts here
      speaker = c.colon;
      current = null;
      push(speaker, line.text.slice(line.text.indexOf(":") + 1));
      continue;
    }
    push(speaker || "Speaker", line.text); // anything else is speech
  }

  return finalize(utterances);
}

/** Rebuilds the derived fields after any change to the utterances (parsing, or
 *  a speaker the user reassigned): merge adjacent same-speaker turns, renumber,
 *  recount. */
function finalize(utterances) {
  const merged = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === u.speaker) last.text += " " + u.text;
    else merged.push({ speaker: u.speaker, text: u.text });
  }
  merged.forEach((u, i) => { u.start = i; u.end = i + 1; });

  const turns = new Map();
  for (const u of merged) turns.set(u.speaker, (turns.get(u.speaker) || 0) + 1);

  return {
    fullText: merged.map((u) => u.text).join(" "),
    utterances: merged,
    language: null,
    speakers: [...turns].map(([name, n]) => ({ name, turns: n })).sort((a, b) => b.turns - a.turns),
  };
}

/**
 * Relabels speakers — how the user fixes a split the parser got wrong, and how
 * they say which voice is theirs.
 * @param {object} transcript
 * @param {Record<string,string>} renames  old label → new label
 */
export function renameSpeakers(transcript, renames) {
  return finalize(
    transcript.utterances.map((u) => ({ ...u, speaker: renames[u.speaker] || u.speaker })),
  );
}

/** A meeting title from the file's name — "" when it says nothing useful. */
export function titleFromFilename(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  if (!base || /^(transcript|transcription|notes?|untitled|export)$/i.test(base)) return "";
  return base;
}
