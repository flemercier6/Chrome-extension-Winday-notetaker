import * as store from "../lib/store.js";
import { requestMicPermission } from "../lib/capture.js";
import { applyTheme } from "../lib/theme.js";

const $ = (id) => document.getElementById(id);
const fields = ["theme", "transcriptionLanguage", "panelMode", "notionDatabaseID", "autoExportToNotion", "summaryPrompt", "summaryLength", "deepgramModel", "geminiModel"];

async function load() {
  const s = await store.getSettings();
  applyTheme(s.theme);
  $("theme").value = s.theme;
  $("transcriptionLanguage").value = s.transcriptionLanguage || "multi";
  $("panelMode").value = s.panelMode === "docked" ? "docked" : "native";
  $("notionDatabaseID").value = s.notionDatabaseID;
  $("autoExportToNotion").checked = s.autoExportToNotion;
  $("summaryPrompt").value = s.summaryPrompt;
  $("summaryLength").value = s.summaryLength;
  $("deepgramModel").value = s.deepgramModel;
  $("geminiModel").value = s.geminiModel;
  updateMicStatus(await store.getMicGranted());
}

async function save() {
  const patch = {
    theme: $("theme").value,
    transcriptionLanguage: $("transcriptionLanguage").value,
    panelMode: $("panelMode").value === "docked" ? "docked" : "native",
    notionDatabaseID: $("notionDatabaseID").value.trim(),
    autoExportToNotion: $("autoExportToNotion").checked,
    summaryPrompt: $("summaryPrompt").value,
    summaryLength: $("summaryLength").value,
    deepgramModel: $("deepgramModel").value.trim() || "nova-3",
    geminiModel: $("geminiModel").value.trim() || "gemini-2.5-flash",
  };
  applyTheme(patch.theme); // reflect the choice on this page immediately
  await store.setSettings(patch);
  chrome.runtime.sendMessage({ type: "WN_SETTINGS_CHANGED" }).catch(() => {});
  flashSaved();
}

let savedTimer = null;
function flashSaved() {
  const el = $("saved");
  el.textContent = "✓ Saved";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = "Settings are saved automatically."), 1200);
}

function updateMicStatus(granted) {
  $("mic-status").textContent = granted ? "✓ Microphone allowed" : "Not allowed";
  $("btn-mic").disabled = granted;
}

async function requestMic() {
  try {
    await requestMicPermission(); // reports WN_MIC_GRANTED -> background persists + broadcasts
    updateMicStatus(true);
  } catch (e) {
    $("mic-status").textContent = "Denied: " + (e?.message || e);
  }
}

// Wire up
for (const id of fields) {
  const el = $(id);
  const evt = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
  el.addEventListener(evt, save);
}
$("btn-reset-prompt").addEventListener("click", async () => {
  $("summaryPrompt").value = store.DEFAULT_SUMMARY_PROMPT;
  await save();
});
$("btn-mic").addEventListener("click", requestMic);

load();
