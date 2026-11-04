// Today in brief: a short English summary of today's news, written in the browser with the user's own AI key.
// Uses whichever AI "grading" uses (Settings). One summary per news.json update, kept in localStorage,
// so the AI is called at most once per day's news unless the user asks for a new one.
(() => {
const $ = id => document.getElementById(id);
const CACHE = "englishDesk.brief", N = 10;
const D = window.EnglishDesk;
if (!D || !$("briefSheet")) return;
let news = null, busy = null, waitingForKey = false;

const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE) || "null") } catch { return null } };
const writeCache = v => { try { localStorage.setItem(CACHE, JSON.stringify(v)) } catch { } };

function show({ text, meta, action, link }) {
  const body = $("briefBody");
  body.replaceChildren(...(Array.isArray(text) ? text : [text]).map(t => { const p = document.createElement("p"); p.textContent = t; if (Array.isArray(text)) p.lang = "en"; return p }));
  body.className = "brief" + (Array.isArray(text) ? "" : " muted");
  $("briefMeta").textContent = meta || "";
  const row = $("briefActions"); row.replaceChildren();
  if (link) { const a = document.createElement("a"); a.className = "btn"; a.href = "#settings"; a.textContent = link; row.append(a) }
  if (action) { const b = document.createElement("button"); b.className = "btn"; b.textContent = action; b.onclick = () => write(true); row.append(b) }
  row.hidden = !row.children.length;
}

function render() {
  if (!news) { show({ text: "No news yet today, so there's nothing to sum up." }); return }
  const c = readCache();
  if (c && c.updated === news.updated && Array.isArray(c.paras)) {
    show({ text: c.paras, meta: `Written by ${c.by} from ${c.count} ${news.sources.join(" + ")} headlines`, action: "Write a new one" });
    return;
  }
  waitingForKey = !D.hasKey();
  if (waitingForKey) { show({ text: "Add an AI key in Settings and a short summary of today's news will appear here.", link: "Go to Settings" }); return }
  write(false);
}

async function write(force) {
  if (busy) return;
  const items = news.items.slice(0, N);
  show({ text: force ? "Writing a new summary…" : "Writing today's summary…" });
  const list = items.map((it, i) => `${i + 1}. [${it.source}, ${it.section || "news"}] ${it.title}${it.summary ? " — " + it.summary : ""}`).join("\n");
  const by = D.aiName();
  busy = new AbortController();
  try {
    const r = await D.ai(
      "You write a daily news brief for an advanced English learner (B2, aiming for C1). You reply with JSON only.",
      [{ role: "user", content: `Here are today's top headlines, most important first, each with the outlet's one-line summary:

${list}

Write "Today in brief": 2 short paragraphs, 120–170 words in total, covering the 4–6 most important stories.
- Natural, clear English at C1 level: varied sentence structure and a few precise, useful collocations, but no rare or showy words.
- Group related stories; lead with the most important one.
- Use only facts given above. Don't add numbers, names, reasons or outcomes that aren't there.
- No headline-style fragments, no bullet points, no opinions.
Reply with only JSON: {"paragraphs": ["...", "..."]}` }],
      { json: true, signal: busy.signal });
    const paras = (Array.isArray(r.paragraphs) ? r.paragraphs : []).map(p => String(p || "").trim()).filter(Boolean);
    if (!paras.length) throw new Error("The AI sent back an empty summary. Try again.");
    writeCache({ updated: news.updated, paras, by, count: items.length });
    render();
  } catch (e) {
    if (e?.code === "cancelled") return;
    show({ text: e?.message || "Something went wrong. Try again.", action: "Try again", link: e?.code === "auth" || e?.code === "nokey" || e?.code === "model" ? "Go to Settings" : "" });
  } finally { busy = null }
}

async function load() {
  try {
    const res = await fetch("news.json?d=" + new Date().toLocaleDateString("sv-SE"), { cache: "no-cache" });
    if (res.ok) {
      const d = await res.json(), items = (d.items || []).filter(i => i && i.title);
      if (items.length) news = { updated: d.updated, sources: d.sources || [], items };
    }
  } catch { }
  render();
}
// A key added in Settings: try again when the user comes back to Today.
addEventListener("hashchange", () => { if (waitingForKey && (location.hash === "#today" || !location.hash)) render() });
load();
})();
