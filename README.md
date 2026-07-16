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
   ┌────┴───────┐   ┌──────────┐      │   • export-notion          │ ─▶ create page
   │   docked   │   │ content  │      │ Postgres: meetings (RLS)   │
   │ panel (UI) │   │  pill    │      └────────────────────────────┘
   └────────────┘   └──────────┘
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

Works in **Chrome** and in **Arc** (Arc doesn't render Chrome's native side
panel, so the panel is docked *inside* the Meet page instead — same look, and it
still pushes the page content aside rather than overlaying it).

1. Join a **Google Meet** call. A small pill appears at the top of the tab —
   its **Ouvrir le panneau** button docks the panel on the right (the call page
   is pushed aside, no overlay). The toolbar icon and `⌘⇧9` do the same.
   **Sign in** in the panel with your Winday account (same credentials as the
   macOS app / CRM).
2. Open **Settings** (⚙) once and click **Autoriser le microphone** so your side
   of the call is captured. Set your **Notion database ID** there too.
3. Start recording — two ways:
   - **Enregistrer cet appel** in the panel. If Chromium hasn't *invoked* the
     extension on that tab yet, the native **share picker** opens as a fallback:
     pick the call's tab (keep *share audio* enabled) and recording starts.
   - **Right‑click the call page → “Winday Notetaker — Enregistrer ce call”** —
     fully silent (the menu click itself authorizes the capture, no picker).
4. The elapsed time stays visible in the panel and the pill; stop from either.
5. When you stop, the extension uploads, transcribes, summarizes and (if
   enabled) exports to Notion. Progress and the result stay visible in the
   panel, and the meeting appears in the Winday CRM.

### Notes & limitations (v1)

- **Capture authorization**: Chromium only allows *silent* tab capture on a tab
  where the extension was invoked (toolbar icon, right‑click menu item, `⌘⇧9`).
  Without that grant, the panel's record button falls back to the native share
  picker (`desktopCapture`) — one extra click, works everywhere including Arc.
  The right‑click menu path is always silent.
- On non‑Meet tabs, the toolbar icon opens the same UI as a full‑tab
  **dashboard** (recordings list, retry, export).
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
content/content.js     meet.google.com: pill + docks the panel iframe (pushes the page)
sidepanel/             the panel UI: docked in the Meet page (iframe) or full‑tab dashboard
options/               settings: mic permission, Notion db, models, prompt
lib/supabase.js        auth / storage / Edge Function REST client
lib/pipeline.js        upload → transcribe → summarize → export orchestration
lib/store.js           chrome.storage: session, settings, meetings cache
icons/                 prebuilt PNG icons (+ generator)
supabase/              shared Edge Functions (reference; already deployed)
```
