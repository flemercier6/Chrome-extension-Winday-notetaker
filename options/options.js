import * as store from "../lib/store.js";

const $ = (id) => document.getElementById(id);
const fields = ["notionDatabaseID", "autoExportToNotion", "summaryPrompt", "summaryLength", "deepgramModel", "geminiModel"];

async function load() {
  const s = await store.getSettings();
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
    notionDatabaseID: $("notionDatabaseID").value.trim(),
    autoExportToNotion: $("autoExportToNotion").checked,
    summaryPrompt: $("summaryPrompt").value,
    summaryLength: $("summaryLength").value,
    deepgramModel: $("deepgramModel").value.trim() || "nova-3",
    geminiModel: $("geminiModel").value.trim() || "gemini-2.5-flash",
  };
  await store.setSettings(patch);
  chrome.runtime.sendMessage({ type: "WN_SETTINGS_CHANGED" }).catch(() => {});
  flashSaved();
}

let savedTimer = null;
function flashSaved() {
  const el = $("saved");
  el.textContent = "✓ Enregistré";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = "Les réglages sont enregistrés automatiquement."), 1200);
}

function updateMicStatus(granted) {
  $("mic-status").textContent = granted ? "✓ Micro autorisé" : "Non autorisé";
  $("btn-mic").disabled = granted;
}

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await store.setMicGranted(true);
    updateMicStatus(true);
    chrome.runtime.sendMessage({ type: "WN_SETTINGS_CHANGED" }).catch(() => {});
  } catch (e) {
    $("mic-status").textContent = "Refusé : " + (e?.message || e);
  }
}

// Wire up
for (const id of fields) {
  const el = $(id);
  el.addEventListener(el.type === "checkbox" ? "change" : "input", save);
}
$("btn-reset-prompt").addEventListener("click", async () => {
  $("summaryPrompt").value = store.DEFAULT_SUMMARY_PROMPT;
  await save();
});
$("btn-mic").addEventListener("click", requestMic);

load();
