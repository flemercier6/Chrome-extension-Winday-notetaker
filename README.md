# Winday Notetaker — Chrome Extension

A **Chrome extension (Manifest V3)** that records your **Google Meet** calls,
transcribes them with **Deepgram (Nova‑3)**, summarizes them with **Gemini
(Flash)**, and pushes the summary, next steps and priorities to the **Winday
CRM** and **Notion** — all through the same secure **Supabase** backend as the
macOS [Winday Notetaker](https://github.com/flemercier6/winday-notetaker), so no
API secret ever lives in the browser.

This is a browser‑native port of the macOS app. It shares the account, the
database, the recordings and the Notion workspace — a call recorded from either
one shows up in the same place.

---

## How it works

```
 Chrome tab (Meet)                     Supabase (shared backend)          3rd parties
┌────────────────────┐  upload .webm  ┌────────────────────────────┐
│  offscreen doc     │ ─────────────▶ │ Storage: recordings bucket │
│  • tab audio  ─┐   │                │                            │
│  • microphone ─┴─▶ │  invoke fns    │ Edge Functions (hold the   │  Deepgram Nova‑3
│  stereo webm/opus  │ ─────────────▶ │  secrets via Deno.env):    │ ─▶ transcribe
└────────────────────┘                │   • transcribe             │  Gemini Flash
        ▲                             │   • summarize              │ ─▶ summarize
        │ tab MediaStream id          │   • enrich-meeting         │  Notion API
   ┌────┴─────┐   ┌──────────┐        │   • export-notion          │ ─▶ create page
   │  popup   │   │ content  │        │ Postgres: meetings (RLS)   │
   │ (start)  │   │  pill    │        └────────────────────────────┘
   └──────────┘   └──────────┘
```

1. **Record** — an **offscreen document** captures the Meet **tab audio**
   (`chrome.tabCapture`, i.e. the remote participants) and your **microphone**
   (`getUserMedia`), and mixes them with the Web Audio API into a single
   **stereo** stream: **left = you**, **right = the meeting**. It records that to
   `webm/opus` with `MediaRecorder`.
2. **Upload** — the recording is uploaded to the private Supabase `recordings`
   bucket and a `meetings` row is created (Row‑Level Security: you only ever see
   your own).
3. **Transcribe / Summarize / Export** — the extension invokes the same Edge
   Functions the macOS app uses, by meeting id. They call Deepgram
   (`multichannel=true`, so **channel 0 = "You"**, **channel 1 = the others**),
   Gemini and Notion **using secrets stored server‑side**, then write the
   results back to the meeting row.

The third‑party keys (Deepgram, Gemini, Notion) are **never shipped to the
extension** — they live only as Supabase Edge Function secrets. The extension
only carries the **publishable** Supabase URL + anon key (safe to distribute;
access is gated by Supabase Auth + RLS).

---

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top‑right).
3. Click **Load unpacked** and select this folder.
4. Pin the **Winday Notetaker** icon to the toolbar.

> The icons are prebuilt. To regenerate them: `node icons/gen-icons.mjs`.

## Use

1. Click the toolbar icon and **sign in** with your Winday account (same
   credentials as the macOS app / CRM).
2. Open **Settings** (⚙) once and click **Autoriser le microphone** so your side
   of the call is captured. Set your **Notion database ID** there too.
3. Join a **Google Meet** call. A small pill appears at the top of the tab.
4. Click the toolbar icon → **Enregistrer cet appel**. Recording starts; you can
   stop it from the pill or the popup.
5. When the call ends and you stop, the extension uploads, transcribes,
   summarizes and (if enabled) exports to Notion. The result appears in the
   popup list and in the Winday CRM.

### Notes & limitations (v1)

- **Starting a recording** is done from the toolbar **popup** (or the pill's
  *Enregistrer* button, which opens it): Chrome only mints a tab‑capture stream
  from a real user gesture with `activeTab`, which the popup provides.
- **Microphone permission** must be granted from the **Settings** page (a full
  tab) — extension pages are where Chrome shows the mic prompt. Without it, the
  call is still recorded (participants only); your voice just won't be on the
  "You" channel.
- **You still hear the call** while recording: captured tab audio is routed back
  to your speakers.
- **Calendar arming** (auto‑pre‑filling the company/contacts from Google
  Calendar, as the macOS app does) is not wired into the UI yet — the meeting is
  still created in the CRM, just without the pre‑resolved company link. The
  `upcoming-meetings` function is available server‑side for a follow‑up.

---

## Backend

The `supabase/` folder mirrors the shared backend for reference. **These
functions are already deployed** to the Winday CRM's Supabase project
(`gagfovgnuttmngnhqzwd`) and are used as‑is by both the macOS app and this
extension — you do **not** need to redeploy anything to use the extension. The
required secrets (`DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `NOTION_TOKEN`) already
live there as Edge Function secrets.

## Project layout

```
manifest.json          MV3 manifest
config.js              publishable Supabase URL + anon key + model defaults
background.js          service worker: offscreen lifecycle + message routing + state
offscreen.html/.js     capture (tab + mic → stereo) + upload + pipeline
content/content.js     meet.google.com detection + floating pill (shadow DOM)
popup/                 sign‑in + recordings list + the "record" trigger
options/               settings: mic permission, Notion db, models, prompt
lib/supabase.js        auth / storage / Edge Function REST client
lib/pipeline.js        upload → transcribe → summarize → export orchestration
lib/store.js           chrome.storage: session, settings, meetings cache
icons/                 prebuilt PNG icons (+ generator)
supabase/              shared Edge Functions (reference; already deployed)
```
