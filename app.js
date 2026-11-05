(() => {
const $ = id => document.getElementById(id);
const STORE = "englishDesk.v1", CFG = "englishDesk.cfg";
const st = { cards: [], logs: [], deleted: {}, speakMode: "live", inline: false, topic: "", ctl: null, speakItems: [], writeItems: [], writeLevel: "", writeTopic: "" };
let cfg = { geminiKey: "", geminiModel: "gemini-3.5-flash-lite", liveModel: "gemini-3.8-live", claudeKey: "", claudeGrade: "claude-opus-5-5", azureKey: "", azureRegion: "", use: { grade: null, pron: null, brief: null, speed: null }, keyOk: {} };

const today = () => new Date().toLocaleDateString("sv-SE");
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE") };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let toastT;
function toast(msg) { let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t) } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600) }
function banner(msg, link) { const b = $("banner"); b.replaceChildren(msg); if (link) { const a = document.createElement("a"); a.href = "#settings"; a.textContent = " Go to Settings"; b.append(a) } b.hidden = !msg }

/* ---------- storage ---------- */
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE) || "{}"); st.cards = d.cards || []; st.logs = d.logs || []; st.deleted = d.deleted || {} } catch { }
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(CFG) || "{}") } } catch { }
  // Older versions had one site-wide provider and Sonnet as the default grader.
  cfg.use = { grade: null, pron: null, brief: null, speed: null, ...cfg.use }; cfg.keyOk = cfg.keyOk || {};
  if ("provider" in cfg) { if (cfg.claudeKey) cfg.use.grade = cfg.provider === "claude" ? "claude" : "gemini"; delete cfg.provider }
  if (!cfg.claudeGrade || cfg.claudeGrade === "claude-sonnet-5-5") cfg.claudeGrade = "claude-opus-5-5";
  delete cfg.claudeChat;
}
// Things that want to know about every save (sync.js pushes a few seconds later). `quiet` skips them, for saves that came from sync itself.
const saveHooks = [], changeHooks = []; // changeHooks: every change, including ones that came from sync (reader.js redraws its speed chart)
function persist(quiet) {
  try { localStorage.setItem(STORE, JSON.stringify({ cards: st.cards, logs: st.logs, deleted: st.deleted })) }
  catch { toast("The browser refused to save. Export a backup first.") }
  renderList(); renderLogs(); if (!$("v-cards").hidden) renderFlash();
  if (!quiet) saveHooks.forEach(f => f());
  changeHooks.forEach(f => { try { f() } catch { } });
}
/* Merging two copies of the data (backup import now, cloud sync later). Pure: returns new arrays, changes nothing.
   Cards: one per id, the newer `updated` wins; on a tie (old cards have no `updated`) the later `due`, then the higher `box`.
   A deletion (`deleted[id]` = when) removes the card unless the card was changed after that. Logs: union by `ts`, newest 500;
   a log changed after it was made (a timed read gets its quiz and AI verdict later) carries `updated`, and the newer copy wins;
   a deleted practice session is marked `deleted["log:" + ts]`.
   Deletion marks older than 90 days are dropped; by then every device has seen them. */
const TOMB_DAYS = 90, LOG_MAX = 500;
function mergeData(local, incoming) {
  const cutoff = Date.now() - TOMB_DAYS * 864e5, deleted = {};
  for (const src of [local.deleted, incoming.deleted]) for (const [id, t] of Object.entries(src || {}))
    if (+t > cutoff && !(deleted[id] >= +t)) deleted[id] = +t;
  const newer = (a, b) => (a.updated || 0) - (b.updated || 0) || String(a.due || "").localeCompare(String(b.due || "")) || (a.box || 0) - (b.box || 0);
  const byId = new Map();
  for (const c of [...(local.cards || []), ...(incoming.cards || [])]) {
    if (!c || !c.id || !c.mine) continue;
    const have = byId.get(c.id);
    if (!have || newer(c, have) > 0) byId.set(c.id, c);
  }
  const cards = [...byId.values()].filter(c => !(deleted[c.id] >= (c.updated || 0)));
  const logs = new Map();
  for (const l of [...(local.logs || []), ...(incoming.logs || [])]) if (l && l.ts && !deleted["log:" + l.ts] && (!logs.has(l.ts) || (l.updated || 0) > (logs.get(l.ts).updated || 0))) logs.set(l.ts, l);
  return { cards, logs: [...logs.values()].sort((a, b) => a.ts - b.ts).slice(-LOG_MAX), deleted };
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- AI ---------- */
const keyFor = p => p === "azure" ? !!(cfg.azureKey && cfg.azureRegion) : !!cfg[p + "Key"];
const anyTextKey = () => keyFor("gemini") || keyFor("claude");
// Which provider a feature uses: the one picked if it still has a key, otherwise the best one that does.
function use(f) {
  const opts = f === "grade" || f === "brief" || f === "speed" ? ["claude", "gemini"] : ["azure", "gemini"], pick = cfg.use[f];
  return pick && keyFor(pick) ? pick : opts.find(keyFor) || opts.at(-1);
}
const DEF_CLAUDE = "claude-opus-5-5";
function hasKey(f = "grade") { return keyFor(use(f)) }
class AiError extends Error { constructor(msg, code) { super(msg); this.code = code } }
async function callApi(url, headers, body, signal) {
  let res;
  try { res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) }
  catch (e) { if (e.name === "AbortError") throw new AiError("", "cancelled"); throw new AiError("Can't reach the AI service. Check your connection and try again.", "network") }
  let data = {}; try { data = await res.json() } catch { }
  if (!res.ok) {
    const m = data?.error?.message || "";
    if (res.status === 401 || res.status === 403 || /API key/i.test(m)) throw new AiError("The API key isn't valid. Check it in Settings.", "auth");
    if (res.status === 429) throw new AiError("You've hit the usage limit or sent too many requests. Try again in a moment.", "rate");
    if (res.status === 413 || /too large|payload size/i.test(m)) throw new AiError("The audio is too large. Pick a shorter clip and try again.", "size");
    if (res.status === 404 || /model/i.test(m)) throw new AiError("That model name wasn't found. Check it in Settings.", "model");
    throw new AiError("The AI returned an error: " + (m || res.status), "upstream");
  }
  return data;
}
function finish(text, json) {
  if (!text.trim()) throw new AiError("The AI sent an empty reply. Try again.", "empty");
  return json ? parseJson(text) : text.trim();
}
// Grading and review: whichever provider "Grading and feedback" uses.
// `feature` lets another text feature (the news brief) use its own pick.
async function ai(system, turns, { json = false, signal, feature = "grade" } = {}) {
  if (!hasKey(feature)) throw new AiError("No API key set yet.", "nokey");
  if (use(feature) === "gemini") return gemini(system, null, { json, signal, turns });
  return claude(system, turns, { json, signal });
}
// Opus thinks before it answers, and thinking counts toward max_tokens, so leave plenty of room.
async function claude(system, turns, { json = false, signal, max = 16000 } = {}) {
  if (!cfg.claudeKey) throw new AiError("This needs Claude. Add a Claude API key in Settings first.", "nokey");
  const data = await callApi("https://api.anthropic.com/v1/messages",
    { "x-api-key": cfg.claudeKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    { model: cfg.claudeGrade || DEF_CLAUDE, max_tokens: max, system, messages: turns }, signal);
  if (data.stop_reason === "refusal") throw new AiError("Claude declined to answer this. Try Gemini instead.", "refusal");
  if (data.stop_reason === "max_tokens") throw new AiError("The reply was too long and got cut off. Try again.", "length");
  return finish((data.content || []).filter(b => b.type === "text").map(b => b.text).join(""), json);
}
// Gemini directly, whatever provider is picked: audio (shadowing) only works here. `parts` may hold inlineData audio.
async function gemini(system, parts, { json = false, signal, turns } = {}) {
  if (!cfg.geminiKey) throw new AiError("This needs Gemini. Add a Gemini API key in Settings first.", "nokey");
  const contents = turns ? turns.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })) : [{ role: "user", parts }];
  const data = await callApi(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, { "x-goog-api-key": cfg.geminiKey },
    { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: json ? { responseMimeType: "application/json" } : {} }, signal);
  return finish((data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join(""), json);
}
function parseJson(text) {
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const t of tries) { if (!t) continue; try { return JSON.parse(t) } catch { } }
  throw new AiError("The AI reply was in the wrong format. Try again.", "json");
}
const errText = e => e?.message || "Something went wrong. Try again.";

/* ---------- routing ---------- */
const VIEWS = ["today", "speak", "write", "echo", "history", "cards", "settings", "read"];
function route() {
  const h = location.hash.slice(1).split("/")[0], v = VIEWS.includes(h) ? h : "today";
  VIEWS.forEach(x => { $("v-" + x).hidden = x !== v });
  document.querySelectorAll("nav a").forEach(a => a.dataset.v === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "cards") renderFlash();
  if (v !== "echo" && typeof echoLeave === "function") echoLeave();
  if (v === "echo" && typeof loadPodcasts === "function") loadPodcasts();
}
addEventListener("hashchange", route);

/* ---------- schedule ---------- */
const PLAN = [
  { d: "Sun", t: "Review", go: "cards", long: "Review every card you saved this week" },
  { d: "Mon", t: "Speak", go: "speak", long: "Talk with the AI for 10 minutes, then review 5 key fixes" },
  { d: "Tue", t: "Write", go: "write", long: "Write 150–200 words, get feedback, then rewrite it yourself" },
  { d: "Wed", t: "Speak", go: "speak", long: "Talk with the AI for 10 minutes, then review 5 key fixes" },
  { d: "Thu", t: "Write", go: "write", long: "Write 150–200 words, get feedback, then rewrite it yourself" },
  { d: "Fri", t: "Speak", go: "speak", long: "Talk with the AI for 10 minutes, then review 5 key fixes" },
  { d: "Sat", t: "Echo", go: "echo", long: "Shadow a podcast: listen sentence by sentence, hold to repeat, then compare with the original" },
];
const KIND = { speak: "speak", write: "write", echo: "echo", cards: "cards" };
function weekDates() { const d = new Date(), off = (d.getDay() + 6) % 7; return [0, 1, 2, 3, 4, 5, 6].map(i => { const x = new Date(d); x.setDate(d.getDate() - off + i); return x.toLocaleDateString("sv-SE") }) }
function renderToday() {
  const n = new Date().getDay(), p = PLAN[n];
  $("todayLabel").textContent = "Today · " + p.d;
  $("todayTask").textContent = p.long;
  const go = $("todayGo");
  go.href = "#" + p.go; go.textContent = "Start"; $("todayEnjoy").hidden = p.go !== "echo";
  renderWeek();
}
function renderWeek() {
  const n = new Date().getDay(), dates = weekDates();
  const counts = dates.map(d => st.logs.filter(l => l.date === d).length);
  $("week").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((i, k) => { const el = document.createElement("div");
    el.className = "day" + (i === n ? " today" : ""); el.dataset.s = KIND[PLAN[i].go];
    el.innerHTML = `<b>${PLAN[i].d}</b><span>${PLAN[i].t}</span>` + (counts[k] ? '<span class="tick">✓ Done</span>' : "");
    return el }));
  $("weekDone").textContent = counts.filter(Boolean).length;
  const max = Math.max(1, ...counts);
  $("bars").replaceChildren(...counts.map((c, k) => { const el = document.createElement("div");
    el.innerHTML = (c ? `<span class="n">${c}</span>` : "") + `<i class="${c ? "" : "zero"}" style="height:${c ? Math.round(c / max * 64) + 8 : 8}px"></i><span>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][k]}</span>`;
    return el }));
}
function renderLogs() {
  const box = $("logs");
  if ($("bars")) renderWeek();
  if (!st.logs.length) return;
  box.replaceChildren(...[...st.logs].sort((a, b) => b.ts - a.ts).slice(0, 12).map(l => { const el = document.createElement("div");
    const t = document.createElement("time"); t.textContent = l.date;
    const lv = document.createElement("span"); lv.className = "level"; lv.textContent = l.type === "read" ? (l.wpm || "—") : l.level || (l.score != null ? l.score + " pts" : "—");
    const s = document.createElement("span"); s.textContent = ({ write: "Write · ", echo: "Echo · ", read: "Read wpm · " }[l.type] || "Speak · ") + (l.topic || "");
    el.append(t, lv, s); return el }));
}
function addLog(l, full) {
  const log = { ...l, date: today(), ts: Date.now() };
  st.logs.push(log); if (st.logs.length > LOG_MAX) st.logs.splice(0, st.logs.length - LOG_MAX);
  if (full) savePractice({ ...log, ...full }).then(() => { if (log.ctx && log.ctx.link) attachArticle(log.ts) });
  persist(); if (st.redo) renderRedo(); return log.ts;
}
/* ---------- practice history ---------- */
// The log above is the short index. The whole session (transcript or paragraph, all feedback, rewrite, times) goes to IndexedDB through practice.js.
const changed = () => saveHooks.forEach(f => f());
let practiceWarned = false;
async function savePractice(rec) {
  try { await EDPractice.put({ ...rec, updated: Date.now() }); changed() }
  catch { if (!practiceWarned) { practiceWarned = true; toast("The browser refused to save the full session. Only the level was kept.") } }
}
async function updatePractice(ts, patch) {
  const log = st.logs.find(l => l.ts === ts), have = await EDPractice.get(ts).catch(() => null);
  await savePractice({ ...(log || {}), ...(have || {}), ...patch, ts });
}
// A news topic: keep the story itself (title, link, full text) with the session, fetched the same way the reader does.
// If that fails, the session still has the headline, summary and link, and History offers to try again.
async function attachArticle(ts) {
  const r = (await EDPractice.get(ts).catch(() => null)) || st.logs.find(l => l.ts === +ts), c = r && r.ctx;
  if (!c || !c.link || (r.article && r.article.paras) || !window.EnglishDeskReader?.text) return false;
  try {
    const a = await EnglishDeskReader.text({ title: r.topic, link: c.link, source: c.source, section: c.section, summary: c.summary });
    await updatePractice(ts, { article: { title: a.title || r.topic, link: c.link, source: c.source || "", section: c.section || "", paras: a.paras, saved: Date.now() } });
    return true;
  } catch { return false }
}
function deleteSession(ts) {
  st.logs = st.logs.filter(l => l.ts !== +ts); st.deleted["log:" + ts] = Date.now();
  EDPractice.del(ts).catch(() => { }); persist(); renderRedo();
}
// Active time: gaps under 90 s between keystrokes count, so a break with the tab open doesn't.
function timer() { return { start: 0, ms: 0, last: 0 } }
function tick(t) { const n = Date.now(); if (!t.start) t.start = n; if (t.last && n - t.last < 90000) t.ms += n - t.last; t.last = n; return t }
const secsOf = t => t && t.ms ? Math.round(t.ms / 1000) : 0;

/* ---------- news + topics ---------- */
// news.json is refreshed daily by .github/workflows/news.yml (BBC + CNN, or NPR when CNN is down).
const SECTION = { business: "Business", tech: "Tech", world: "World" };
const TOPICS = ["What I did this week", "A book I'm reading", "A project I'm working on", "Something I want to buy", "A place I'd like to visit"].map(title => ({ title }));
const WTOPICS = ["A book I read recently", "A project I'm working on", "A tool I use all the time", "An email turning down an invitation", "My ideal weekend"].map(title => ({ title }));
const SHOW = 6;
const topicLists = { speak: TOPICS, write: WTOPICS }, picked = { speak: TOPICS[0], write: WTOPICS[0] };
const ROWS = { speak: ["topics", "topicNote"], write: ["wtopics", "wtopicNote"] };

// Round-robin over section × source so the first few headlines mix business, tech and world.
function mixNews(items) {
  const groups = {};
  for (const it of items) (groups[it.section + "|" + it.source] ||= []).push(it);
  const lists = Object.keys(groups).sort((a, b) => Object.keys(SECTION).indexOf(a.split("|")[0]) - Object.keys(SECTION).indexOf(b.split("|")[0])).map(k => groups[k]);
  const out = [];
  for (let i = 0; lists.some(l => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
function noteFor(it) {
  if (!it.summary) return null;
  const f = document.createDocumentFragment();
  f.append(it.summary + " ");
  if (it.link) { const a = document.createElement("a"); a.href = it.link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Read on " + it.source; f.append(a) }
  return f;
}
function renderTopics(kind) {
  const [rowId, noteId] = ROWS[kind], list = topicLists[kind];
  if (!list.includes(picked[kind])) picked[kind] = list[0];
  $(rowId).replaceChildren(...list.map(t => { const b = document.createElement("button"); b.className = "chip"; b.textContent = t.title;
    b.setAttribute("aria-pressed", t === picked[kind] ? "true" : "false");
    b.onclick = () => { picked[kind] = t; renderTopics(kind); if (st.redo) renderRedo() }; return b }));
  const note = noteFor(picked[kind]);
  $(noteId).replaceChildren(...(note ? [note] : [])); $(noteId).hidden = !note;
}
// Pick a headline from the Today card: put it first in that tab's chips and jump there.
function useNews(kind, it) {
  topicLists[kind] = [it, ...topicLists[kind].filter(t => t !== it)].slice(0, SHOW);
  picked[kind] = it; $(kind === "speak" ? "topicCustom" : "wtopicCustom").value = "";
  renderTopics(kind); location.hash = kind;
}
// Articles sent to Chicklist (the reader records them; the app doesn't report back) get a ✓ on the news list.
let chickSaved = {};
try { chickSaved = JSON.parse(localStorage.getItem("englishDesk.chicklist") || "{}") || {} } catch { }
function markChick(h) { if (h.querySelector(".cl")) return; const s = document.createElement("span"); s.className = "cl"; s.textContent = " · ✓ In Chicklist"; h.append(s) }
function renderNews(news) {
  const box = $("newsList");
  if (!news) { box.innerHTML = '<p class="muted">Today\'s news isn\'t in yet, so Speak and Write use the default topics for now.</p>'; return }
  const d = new Date(news.updated);
  $("newsMeta").textContent = (news.sources || []).join(" + ") + " · " + "updated " + (d.getMonth() + 1) + "/" + d.getDate();
  box.replaceChildren(...news.mixed.slice(0, SHOW).map(it => { const el = document.createElement("div"); el.className = "news-item";
    const h = document.createElement("h3"); h.textContent = it.source + " · " + (SECTION[it.section] || it.section);
    el.dataset.link = it.link || ""; if (it.link && chickSaved[it.link]) markChick(h);
    const a = document.createElement("a"); a.href = it.link; a.target = "_blank"; a.rel = "noopener"; a.lang = "en"; a.textContent = it.title;
    const p = document.createElement("p"); p.className = "muted"; p.lang = "en"; p.textContent = it.summary || "";
    const row = document.createElement("div"); row.className = "row";
    const rd = document.createElement("button"); rd.className = "btn c-save"; rd.textContent = "Read"; rd.onclick = () => window.EnglishDeskReader?.open(it); row.append(rd);
    for (const [kind, label] of [["speak", "Talk about it"], ["write", "Write about it"]]) { const b = document.createElement("button"); b.className = "btn c-save"; b.textContent = label; b.onclick = () => useNews(kind, it); row.append(b) }
    el.append(h, a, ...(it.summary ? [p] : []), row); return el }));
}
async function loadNews() {
  let news = null;
  try {
    const res = await fetch("news.json?d=" + today(), { cache: "no-cache" });
    if (res.ok) { news = await res.json(); news.mixed = mixNews((news.items || []).filter(i => i && i.title)); if (!news.mixed.length) news = null }
  } catch { }
  if (news) {
    topicLists.speak = news.mixed.slice(0, SHOW);
    // Writing gets the next batch so the two tabs don't offer the same headlines.
    topicLists.write = news.mixed.length >= SHOW * 2 ? news.mixed.slice(SHOW, SHOW * 2) : news.mixed.slice(0, SHOW);
  }
  renderNews(news); renderTopics("speak"); renderTopics("write");
}
function currentTopic(kind) {
  const custom = $(kind === "speak" ? "topicCustom" : "wtopicCustom").value.trim();
  return custom ? { title: custom } : picked[kind];
}
// What the AI is told about a news topic: headline + one-line summary only.
function newsContext(t) {
  if (!t.summary) return "";
  return `This topic is a news story (${t.source}, ${SECTION[t.section] ? t.section : "news"}).
Headline: ${t.title}
Summary: ${t.summary}
I've only read this headline and summary, not the full article. Don't invent facts beyond the summary; if a detail isn't in it, say you're not sure.`;
}

/* ---------- speaking ---------- */
// Two modes: a live voice chat over the Gemini Live API, or grading a transcript pasted from elsewhere.
const LIVE_DEFAULT = "gemini-3.8-live", LIVE_MAX = 14 * 60;
const live = { ws: null, ctx: null, mic: null, node: null, src: null, buf: [], playAt: 0, playing: [], turns: [], muted: false, ready: false, t0: 0, timer: 0, ended: false };
function setSpeakMode(m) {
  st.speakMode = m;
  $("modeLive").setAttribute("aria-pressed", m === "live"); $("modePaste").setAttribute("aria-pressed", m === "paste");
  $("livePanel").hidden = m !== "live"; $("pastePanel").hidden = m !== "paste";
  if (m === "paste") $("liveBox").hidden = true;
  liveAvailability();
}
$("modeLive").onclick = () => setSpeakMode("live");
$("modePaste").onclick = () => setSpeakMode("paste");
function setCorr(inline) { st.inline = inline; $("corrInline").setAttribute("aria-pressed", inline); $("corrAfter").setAttribute("aria-pressed", !inline) }
$("corrInline").onclick = () => setCorr(true);
$("corrAfter").onclick = () => setCorr(false);
function liveAvailability() {
  const why = !cfg.geminiKey ? "Voice chat needs Gemini. Add a Gemini key in Settings first."
    : !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket && (window.AudioContext || window.webkitAudioContext)) ? "This browser can't record from the mic. Use Paste a transcript instead." : "";
  $("liveStart").disabled = !!why || !!live.ws; $("liveHint").textContent = why;
}

// What the partner is told before the conversation starts (also copied for the Gemini App in paste mode).
function opening(topic, voice) {
  return `You are my English conversation partner. I'm a Taiwanese learner at about CEFR B2, aiming for C1. Talk like a friendly, curious friend. Keep each turn to 1–3 short sentences and end with one follow-up question, so I do most of the talking. Speak at a natural pace with clear, everyday English. Today's topic: ${topic.title}.
` + (topic.summary ? newsContext(topic) + `
Open by retelling the story in one or two simple sentences, then ask what I think. Keep the talk on my views and experience, such as how it affects people in Taiwan or my own work.
` : "") + (voice && st.inline
    ? `If I make a mistake a native speaker would notice, first say the natural version in one short sentence starting with "You could say", then carry on. Fix at most one thing per turn, and skip it when nothing is worth fixing.`
    : `Do not correct my English during the chat; just keep the conversation flowing. I'll review my mistakes afterwards.`);
}

function liveStatus(t) { $("liveStatus").textContent = t }
function addMsg(role, text) {
  const el = document.createElement("div"); el.className = "msg " + (role === "me" ? "me" : "ai"); el.lang = "en";
  el.textContent = text; $("log").append(el); $("log").scrollTop = $("log").scrollHeight; return el;
}
// Transcription arrives in fragments; glue them onto the current turn of the same speaker.
function addText(role, text) {
  if (!text) return;
  let last = live.turns.at(-1);
  if (!last || last.role !== role) { last = { role, text: "", el: addMsg(role, "") }; live.turns.push(last) }
  last.text += text; last.el.textContent = last.text.trim(); $("log").scrollTop = $("log").scrollHeight;
}

// Mic → 16 kHz 16-bit PCM. The AudioContext runs at the device rate (iOS ignores custom rates for mic input), so we downsample here.
const WORKLET = `class Tap extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true } } registerProcessor("tap", Tap)`;
function pushMic(f32) {
  if (live.muted || !live.ws || live.ws.readyState !== 1 || !live.ready) return;
  live.buf.push(f32);
  const rate = live.ctx.sampleRate, need = Math.round(rate / 10); // ~100 ms per message
  let n = live.buf.reduce((s, b) => s + b.length, 0); if (n < need) return;
  const out = to16k(concat(live.buf), rate); live.buf = [];
  live.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: b64(new Uint8Array(out.buffer)) } } }));
}
function concat(chunks) { const all = new Float32Array(chunks.reduce((s, b) => s + b.length, 0)); let o = 0; for (const b of chunks) { all.set(b, o); o += b.length } return all }
// Float32 at `rate` → 16 kHz 16-bit PCM (box-filter average, good enough for speech).
function to16k(all, rate) {
  const n = all.length, ratio = rate / 16000, out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), z = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0;
    for (let j = a; j < z; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, z - a))); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}
function wav16k(f32, rate) {
  const pcm = to16k(f32, rate), out = new Uint8Array(44 + pcm.byteLength), v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i) };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer), 44); return out;
}
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s) }
// Gemini speaks 24 kHz 16-bit PCM; queue chunks back to back.
function playPcm(data) {
  const bin = atob(data), n = bin.length >> 1, buf = live.ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | bin.charCodeAt(2 * i + 1) << 8; if (v > 32767) v -= 65536; ch[i] = v / 32768 }
  const s = live.ctx.createBufferSource(); s.buffer = buf; s.connect(live.ctx.destination);
  live.playAt = Math.max(live.playAt, live.ctx.currentTime + .05); s.start(live.playAt); live.playAt += buf.duration;
  live.playing.push(s); s.onended = () => { live.playing = live.playing.filter(x => x !== s) };
}
function stopPlayback() { for (const s of live.playing) try { s.stop() } catch { } live.playing = []; live.playAt = 0 }

async function liveStartFn() {
  if (live.ws) return;
  st.topic = currentTopic("speak");
  $("liveStart").disabled = true; $("liveHint").textContent = "Getting the mic ready…";
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
  // Create and resume the AudioContext inside the tap: iOS Safari only allows audio after a user gesture.
  const AC = window.AudioContext || window.webkitAudioContext;
  live.ctx = new AC(); try { await live.ctx.resume() } catch { }
  try {
    live.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    liveCleanup();
    const msg = e && e.name === "NotAllowedError" ? "Mic access was blocked. Allow this site to use the mic in your browser (on iPhone: Settings > Safari > Microphone) and try again." : "Can't open the mic. Check whether another app is using it.";
    $("liveHint").textContent = msg; toast(msg); return;
  }
  live.src = live.ctx.createMediaStreamSource(live.mic);
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await live.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    live.node = new AudioWorkletNode(live.ctx, "tap"); live.node.port.onmessage = e => pushMic(e.data);
  } catch {
    live.node = live.ctx.createScriptProcessor(4096, 1, 1); live.node.onaudioprocess = e => pushMic(e.inputBuffer.getChannelData(0).slice(0));
  }
  // Route through a muted gain so the graph runs without sending the mic to the speakers.
  const sink = live.ctx.createGain(); sink.gain.value = 0; live.src.connect(live.node); live.node.connect(sink); sink.connect(live.ctx.destination);

  live.turns = []; live.ended = false; live.ready = false; live.muted = false; $("liveMute").textContent = "Pause mic";
  $("log").replaceChildren(); $("liveBox").hidden = false; $("reviewBox").hidden = true; $("liveHint").textContent = "Topic: " + st.topic.title;
  liveStatus("Connecting…"); $("liveTime").textContent = "0:00"; $("liveBox").scrollIntoView({ behavior: "smooth", block: "start" });

  const ws = live.ws = new WebSocket("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" + encodeURIComponent(cfg.geminiKey));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ setup: {
    model: "models/" + (cfg.liveModel || LIVE_DEFAULT),
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: opening(st.topic, true) }] },
    inputAudioTranscription: {}, outputAudioTranscription: {} } }));
  ws.onmessage = async e => {
    if (live.ws !== ws) return;
    let m; try { m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data)) } catch { return }
    if (m.setupComplete) {
      live.ready = true; live.t0 = Date.now(); liveStatus("● Listening");
      live.timer = setInterval(() => { const s = Math.floor((Date.now() - live.t0) / 1000); $("liveTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); if (s >= LIVE_MAX) { toast("14 minutes are up. Ending the chat and reviewing it now."); liveEnd() } }, 1000);
      ws.send(JSON.stringify({ realtimeInput: { text: "Start now: greet me briefly and ask your first question about the topic." } }));
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) stopPlayback();
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) playPcm(p.inlineData.data);
      if (sc.inputTranscription?.text) addText("me", sc.inputTranscription.text);
      if (sc.outputTranscription?.text) addText("ai", sc.outputTranscription.text);
    }
    if (m.goAway) { toast("Gemini is closing the connection, so let's review now."); liveEnd() }
  };
  ws.onerror = () => { };
  ws.onclose = e => {
    if (live.ended) return;
    const r = e.reason || "";
    const msg = /API key|permission|unauth/i.test(r) || e.code === 1008 && !live.ready ? "The API key isn't valid or has no Live API access. Check it in Settings."
      : /model|not found|not supported/i.test(r) ? "Can't find the voice model \"" + (cfg.liveModel || LIVE_DEFAULT) + "\". Check it in Settings."
      : /quota|exhaust|rate/i.test(r) ? "You've hit the usage limit. Try again in a moment."
      : !live.ready ? "Can't connect to Gemini Live" + (r ? ": " + r : ". Check your connection and try again.") : "The connection dropped" + (r ? ": " + r : "") + ".";
    toast(msg); if (!live.ready && /Settings/.test(msg)) banner(msg, true);
    liveEnd();
  };
}
function liveCleanup() {
  clearInterval(live.timer); stopPlayback();
  try { live.node && (live.node.port ? live.node.port.onmessage = null : live.node.onaudioprocess = null) } catch { }
  try { live.src && live.src.disconnect(); live.node && live.node.disconnect() } catch { }
  try { live.mic && live.mic.getTracks().forEach(t => t.stop()) } catch { }
  try { live.ctx && live.ctx.close() } catch { }
  const ws = live.ws; live.ws = null; live.ready = false;
  try { ws && ws.readyState < 2 && ws.close() } catch { }
  Object.assign(live, { ctx: null, mic: null, node: null, src: null, buf: [] });
  liveAvailability();
}
function liveEnd() {
  if (live.ended) return; live.ended = true;
  liveCleanup(); liveStatus("Ended");
  const transcript = live.turns.map(t => (t.role === "me" ? "ME: " : "PARTNER: ") + t.text.trim()).filter(l => l.length > 4).join("\n");
  if (live.turns.filter(t => t.role === "me").length < 2) { toast("Fewer than two turns from you, so there's nothing to review this time."); return }
  review(transcript, $("liveEnd"), "End and review", false, { mode: "live", start: live.t0 || Date.now(), secs: live.t0 ? Math.round((Date.now() - live.t0) / 1000) : 0 });
}
$("liveStart").onclick = liveStartFn;
$("liveEnd").onclick = () => { if (live.ws) liveEnd() };
$("liveMute").onclick = () => { live.muted = !live.muted; $("liveMute").textContent = live.muted ? "Resume mic" : "Pause mic"; liveStatus(live.muted ? "Mic paused" : "● Listening") };
addEventListener("pagehide", () => { if (live.ws) { live.ended = true; liveCleanup() } });

/* paste mode */
$("copyOpening").onclick = async () => {
  const t = currentTopic("speak"), text = opening(t, false);
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it to your partner before you start.") }
  catch { $("pasteIn").value = text; $("pasteIn").select(); toast("Couldn't copy automatically, so it's in the box below. Copy it yourself, then clear the box.") }
};
$("pasteIn").addEventListener("input", () => { const n = ($("pasteIn").value.match(/[A-Za-z’']+/g) || []).length; $("pasteCount").textContent = n ? n + " words" : "" });
$("pasteGrade").onclick = () => {
  const text = $("pasteIn").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 40) { toast("The transcript is too short. It needs at least a few back-and-forth turns."); return }
  if (!hasKey()) { banner("Add an API key before grading.", true); return }
  st.topic = currentTopic("speak");
  const mins = Math.min(180, Math.max(0, Math.round(+$("pasteMins").value || 0)));
  review(text, $("pasteGrade"), "Grade it", true, { mode: "paste", start: Date.now() - mins * 60000, secs: mins * 60 });
};
$("stopPaste").onclick = () => st.ctl?.abort();

/* review: CEFR level + 5 corrections, shared by both modes */
async function review(transcript, btn, label, pasted, meta = {}) {
  btn.disabled = true; btn.textContent = "Reviewing…";
  const prevRedo = activeRedo("speak");
  st.ctl = new AbortController(); if (pasted) $("stopPaste").hidden = false;
  try {
    const r = await ai("You are a strict but kind English speaking coach. You reply with JSON only.", [{ role: "user", content: `Here's a transcript of me speaking English with a conversation partner. I'm around B2, aiming for C1. Topic: ${st.topic.title}.
${pasted
  ? "I pasted it from another app, so the speaker labels may be names, \"You\"/\"Gemini\", or missing. Work out which lines are mine (the learner's) and only judge those."
  : "Lines starting with ME are mine; PARTNER lines are the AI."}
It came from speech recognition, so ignore spelling, punctuation and obvious mishearings; judge grammar, word choice and how natural it sounds.
Don't fix every small slip. Pick the 5 places (fewer only if there aren't 5) where a native speaker would most likely have said it differently, the ones most worth practising.
Reply with only JSON of this shape:
{"level":"B2","summary":"one or two sentences of overall feedback in plain English, explaining the level","items":[{"mine":"my original phrase","natural":"the natural version","why":"one line in plain English"}]}
"level" is your CEFR estimate of my speaking from this sample (A2, B1, B2, C1 or C2).

${redoPrompt("speak", prevRedo)}
Transcript:
${transcript.slice(-12000)}` }], { json: true, signal: st.ctl.signal });
    st.speakItems = Array.isArray(r.items) ? r.items.filter(i => i && i.mine && i.natural).slice(0, 5) : [];
    $("speakLevel").textContent = r.level || "—"; $("speakSummary").textContent = r.summary || "";
    renderCorr($("speakCorr"), st.speakItems, "speak");
    $("reviewBox").hidden = false; $("reviewBox").scrollIntoView({ behavior: "smooth", block: "start" });
    renderCompare("speak", prevRedo, { level: r.level, summary: r.summary, compare: r.compare });
    addLog({ type: "speak", topic: st.topic.title, ctx: topicCtx(st.topic), level: r.level || "", summary: r.summary || "", secs: meta.secs || 0,
      items: st.speakItems.map(i => ({ mine: i.mine, natural: i.natural })), ...(prevRedo ? { redoOf: prevRedo.ts } : {}) },
      { mode: meta.mode, start: meta.start, transcript: transcript.slice(0, 60000), words: (transcript.match(/[A-Za-z’']+/g) || []).length,
        items: st.speakItems.map(i => ({ mine: String(i.mine), natural: String(i.natural), why: String(i.why || "") })), ...(r.compare ? { compare: String(r.compare) } : {}) });
    if (pasted) $("pasteMins").value = "";
    if (prevRedo) { st.redo.speak = null; renderRedo() }
  } catch (e) { if (e.code !== "cancelled") { toast(errText(e)); if (e.code === "nokey" || e.code === "auth" || e.code === "model") banner(errText(e), true) } }
  finally { btn.disabled = false; btn.textContent = label; $("stopPaste").hidden = true; liveAvailability() }
}
$("saveAllSpeak").onclick = () => saveAll(st.speakItems, "speak", $("speakCorr"));

/* ---------- monthly redo ---------- */
// Once a month, do last month's speaking / writing topics again and put the two results side by side.
st.redo = { speak: null, write: null };
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const cefrIdx = l => CEFR.indexOf(String(l || "").trim().slice(0, 2).toUpperCase());
function cefrDiff(a, b) {
  const x = cefrIdx(a), y = cefrIdx(b); if (x < 0 || y < 0) return "";
  return y > x ? `up ${y - x} level${y - x > 1 ? "s" : ""}` : y < x ? `down ${x - y} level${x - y > 1 ? "s" : ""}` : "same level";
}
const ym = d => d.slice(0, 7);
function lastMonth() { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toLocaleDateString("sv-SE").slice(0, 7) }
const topicCtx = t => t && t.summary ? { summary: t.summary, source: t.source, section: t.section, link: t.link } : undefined;
// Up to 2 topics per kind from last month, latest first, one per topic title.
function redoCandidates() {
  const lm = lastMonth(), out = [];
  for (const type of ["speak", "write"]) {
    const seen = new Set();
    for (const l of [...st.logs].filter(l => l.type === type && l.level && l.topic && ym(l.date) === lm).sort((a, b) => b.ts - a.ts)) {
      if (seen.has(l.topic)) continue; seen.add(l.topic); out.push(l); if (seen.size === 2) break;
    }
  }
  return out;
}
const redoneBy = l => st.logs.find(x => x.redoOf === l.ts);
function activeRedo(kind) { const r = st.redo[kind]; return r && currentTopic(kind).title === r.topic ? r : null }
function startRedo(l) {
  const kind = l.type, t = { title: l.topic, ...(l.ctx || {}) };
  st.redo[kind] = l;
  topicLists[kind] = [t, ...topicLists[kind].filter(x => x.title !== t.title)].slice(0, SHOW); picked[kind] = t;
  $(kind === "speak" ? "topicCustom" : "wtopicCustom").value = ""; renderTopics(kind); renderRedo(); location.hash = kind;
}
function redoPrompt(kind, prev) {
  if (!prev) return "";
  const shape = `Also add a field "compare": one or two sentences in plain English comparing with last month: what improved and which problems are still there.`;
  if (kind === "write") return `\nI wrote on this same topic last month and it was graded ${prev.level}.` + (prev.text ? ` Here is last month's paragraph:\n${prev.text.slice(0, 3000)}\n` : "\n") + shape + "\n";
  return `\nI talked about this same topic last month and was rated ${prev.level}.` + (prev.summary ? ` The feedback then: ${prev.summary}` : "")
    + (prev.items?.length ? ` My mistakes then: ${prev.items.map(i => `"${i.mine}" → "${i.natural}"`).join("; ")}. Note whether any of them came back.` : "") + "\n" + shape + "\n";
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
// Today: the redo list. Shown all month while last month has results; moved to the top on the 1st.
function renderRedo() {
  const box = $("redoSheet"), list = redoCandidates();
  box.hidden = !list.length; if (!list.length) return;
  const lm = lastMonth(), first = new Date().getDate() === 1, undone = list.some(l => !redoneBy(l));
  $("redoEyebrow").textContent = first && undone ? "It's the 1st, so start with this" : "Monthly redo";
  $("redoIntro").textContent = `Do the topics you practised in ${new Date(lm + "-15").toLocaleDateString("en", { month: "long" })} again, and see the results side by side with last month. As always, speak and write on your own first, without looking at the old version.`;
  $("redoList").replaceChildren(...list.map(l => {
    const row = el("div", "redo-item"), done = redoneBy(l);
    const meta = el("h3", "", (l.type === "write" ? "Write" : "Speak") + " · " + l.date.slice(5).replace("-", "/") + " · " + l.level);
    const t = el("p", "", l.topic); t.lang = "en";
    row.append(meta, t);
    if (done) row.append(el("p", "muted", `Redone: ${l.level} → ${done.level || "—"}` + (cefrDiff(l.level, done.level) ? ", " + cefrDiff(l.level, done.level) : "")));
    else { const b = el("button", "btn c-save", st.redo[l.type] === l ? "In progress, go" : "Redo this"); b.onclick = () => startRedo(l); row.append(b) }
    return row }));
  if (first && undone) $("v-today").prepend(box);
  ["speak", "write"].forEach(k => { const r = st.redo[k], n = $(k === "speak" ? "speakRedoNote" : "writeRedoNote");
    n.hidden = !activeRedo(k); if (r) n.textContent = `Monthly redo: you did this on ${r.date.slice(5).replace("-", "/")} and got ${r.level}. Practise as usual and you'll see both side by side at the end.` });
}
// Result side by side: last month | this time, plus the level change and the AI's comparison.
function renderCompare(kind, prev, now) {
  const box = $(kind === "speak" ? "speakCompare" : "writeCompare");
  box.hidden = !prev; if (!prev) return;
  const col = (title, level, body, extra) => { const c = el("div", "cmp-col"); const h = el("div", "verdict"); h.append(el("h3", "", title), el("span", "level", level || "—")); c.append(h);
    if (body) { const p = el("p", kind === "write" ? "cmp-text" : "muted", body); if (kind === "write") p.lang = "en"; c.append(p) } if (extra) c.append(extra); return c };
  let old = null;
  if (kind === "speak" && prev.items?.length) { old = el("div", "cmp-list"); for (const i of prev.items) { const p = el("p", "c-mine", i.mine); p.lang = "en"; old.append(p) } }
  const grid = el("div", "cmp");
  grid.append(col(`Last month · ${prev.date.slice(5).replace("-", "/")}`, prev.level, kind === "write" ? (prev.text || "(This is an older entry, so the text wasn't saved.)") : prev.summary || "", old),
    col("This time", now.level, kind === "write" ? now.text : now.summary || ""));
  const diff = cefrDiff(prev.level, now.level);
  box.replaceChildren(el("h2", "", "Compared with last month" + (diff ? ": " + diff : "")), grid, ...(now.compare ? [el("div", "habit", now.compare)] : []));
}

/* ---------- writing ---------- */
function wc() { const n = ($("essay").value.match(/[A-Za-z’']+/g) || []).length; $("wc").textContent = n + " words" + (n && (n < 150 || n > 200) ? " (aim for 150–200)" : "") }
// The draft's timer and, once it has been graded, the session it belongs to (`ts`), so grading it again updates that session.
const DRAFT_T = "englishDesk.draftT";
let draftT = timer(); try { draftT = { ...draftT, ...JSON.parse(localStorage.getItem(DRAFT_T) || "{}") } } catch { }
const keepDraftT = () => { try { localStorage.setItem(DRAFT_T, JSON.stringify(draftT)) } catch { } };
$("essay").addEventListener("input", () => {
  wc(); try { localStorage.setItem("englishDesk.draft", $("essay").value) } catch { }
  if (!$("essay").value.trim()) draftT = timer(); else tick(draftT); keepDraftT();
});
let attemptT = timer();
$("redo").addEventListener("input", () => tick(attemptT));
$("grade").onclick = async () => {
  const text = $("essay").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 30) { toast("Write at least 30 words first."); return }
  if (!hasKey()) { banner("Add an API key before getting feedback.", true); return }
  const topic = currentTopic("write"); st.writeTopic = topic; st.writeText = text; st.writeWhy = ""; st.writeRedo = activeRedo("write");
  st.ctl = new AbortController(); $("grade").disabled = true; $("grade").textContent = "Checking…"; $("stopGrade").hidden = false;
  try {
    const r = await ai("You are a strict English writing examiner. You reply with JSON only.", [{ role: "user", content: `I'm a B2-high English writer aiming for C1. Assess my paragraph (topic: ${topic.title}).
${topic.summary ? newsContext(topic) + "\nI was asked to give my opinion on this story. Judge how well I respond to it, but grade my English, not my opinion.\n" : ""}Reply with only JSON of this shape:
{"level":"B2","levelWhy":"one or two sentences in plain English explaining the level (grammar range, vocabulary, coherence, accuracy)","rewrite":"the paragraph rewritten as a C1 writer would, keeping my meaning","changes":[{"mine":"my original phrase","natural":"the better version","why":"one line in plain English on why"}],"habit":"one sentence in plain English: the one recurring habit I most need to fix"}
Give 3–5 changes, the ones that matter most. Be strict, not encouraging.
${redoPrompt("write", st.writeRedo)}
My paragraph:
${text.slice(0, 6000)}` }], { json: true, signal: st.ctl.signal });
    st.writeItems = Array.isArray(r.changes) ? r.changes.filter(i => i && i.mine && i.natural) : [];
    st.writeLevel = r.level || ""; st.writeWhy = r.levelWhy || "";
    renderCompare("write", st.writeRedo, { level: r.level, text, compare: r.compare });
    $("wLevel").textContent = r.level || "—"; $("wLevelWhy").textContent = r.levelWhy || "";
    $("wRewrite").textContent = r.rewrite || ""; $("wRewrite").hidden = false; $("hideModel").textContent = "Hide C1 version";
    $("wHabit").textContent = r.habit ? "Habit to fix: " + r.habit : ""; $("wHabit").hidden = !r.habit;
    renderCorr($("wCorr"), st.writeItems, "write");
    $("gradeBox").hidden = false; $("redoBox").hidden = false; $("redo").value = ""; attemptT = timer();
    const words = (text.match(/[A-Za-z’']+/g) || []).length, prev = st.writeRedo;
    const short = { level: st.writeLevel, why: st.writeWhy, text: text.slice(0, 3000), secs: secsOf(draftT) };
    const full = { start: draftT.start || Date.now(), text: text.slice(0, 8000), words, rewrite: String(r.rewrite || ""), habit: String(r.habit || ""),
      changes: st.writeItems.map(i => ({ mine: String(i.mine), natural: String(i.natural), why: String(i.why || "") })), ...(r.compare ? { compare: String(r.compare) } : {}) };
    const again = draftT.ts && st.logs.find(l => l.ts === draftT.ts);
    if (again) { Object.assign(again, short, { updated: Date.now() }); persist(); updatePractice(again.ts, { ...short, ...full }) }
    else draftT.ts = addLog({ type: "write", topic: topic.title, ctx: topicCtx(topic), ...short, ...(prev ? { redoOf: prev.ts } : {}) }, full);
    keepDraftT();
    if (prev) { st.redo.write = null; st.writeRedo = null; renderRedo() }
    $("gradeBox").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { if (e.code !== "cancelled") toast(errText(e)) }
  finally { $("grade").disabled = false; $("grade").textContent = "Get feedback"; $("stopGrade").hidden = true }
};
$("stopGrade").onclick = () => st.ctl?.abort();
$("saveAllWrite").onclick = () => saveAll(st.writeItems, "write", $("wCorr"));
$("hideModel").onclick = () => { const h = !$("wRewrite").hidden; $("wRewrite").hidden = h; $("hideModel").textContent = h ? "Show C1 version" : "Hide C1 version" };
$("redoDone").onclick = () => {
  if (!$("redo").value.trim()) { toast("Rewrite it first, then tap Done."); return }
  // The feedback was saved when it arrived; this adds your rewrite to the same session.
  if (draftT.ts) updatePractice(draftT.ts, { attempt: $("redo").value.trim().slice(0, 8000), attemptSecs: secsOf(attemptT) });
  try { localStorage.removeItem("englishDesk.draft"); localStorage.removeItem(DRAFT_T) } catch { }
  draftT = timer(); attemptT = timer();
  $("essay").value = ""; wc(); $("redoBox").hidden = true; toast("Saved. You'll find it under History.");
};

/* ---------- shadowing (echo) ---------- */
// Pick 1–3 minutes of a podcast, Gemini splits it into timed sentences, then loop / record / compare / score one sentence at a time.
// Everything plays from the decoded clip in memory, so sentence times stay consistent even when the clip's start in the file is approximate.
const ECHO_CACHE = "englishDesk.echo", REC_MAX = 30;
const echo = { blob: null, name: "", dur: 0, len: 120, ctx: null, buf: null, data: null, rate: 0, sents: [], i: 0, loop: false, speed: 1,
  src: null, loopT: 0, mic: null, micSrc: null, node: null, chunks: [], holding: false, recording: false, recT: 0, t0: 0, mine: {}, scores: {}, ctl: null, title: "" };
const fmt = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const echoHint = t => { $("echoHint").textContent = t };
function parseStart(v) {
  v = String(v || "").trim(); if (!v) return 0;
  const m = v.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] * 60 + +m[2];
  const n = parseFloat(v); return isFinite(n) && n >= 0 ? n * 60 : NaN;
}
function audioDuration(blob) {
  return new Promise(res => { const a = new Audio(), u = URL.createObjectURL(blob); let done = false;
    const end = d => { if (done) return; done = true; URL.revokeObjectURL(u); res(isFinite(d) && d > 0 ? d : 0) };
    a.preload = "metadata"; a.onloadedmetadata = () => end(a.duration); a.onerror = () => end(0); setTimeout(() => end(0), 15000); a.src = u });
}
function echoCtx() {
  if (!echo.ctx) { const AC = window.AudioContext || window.webkitAudioContext; echo.ctx = new AC() }
  try { echo.ctx.resume() } catch { } return echo.ctx;
}
async function setEchoSource(blob, name) {
  echoStopPlay(); echo.blob = blob; echo.name = name; echo.title = name.replace(/\.[a-z0-9]{2,4}$/i, "");
  $("echoSrc").textContent = "Loading…";
  echo.dur = await audioDuration(blob);
  $("echoSrc").textContent = name + (echo.dur ? " · " + fmt(echo.dur) + " total" : "") + " · " + (blob.size / 1e6).toFixed(1) + " MB";
  $("echoRange").hidden = false; $("echoGo").disabled = false; echoHint("");
  // A transcript picked from the episode list in the last 3 hours goes with the next audio you open.
  const px = echo.podScript && Date.now() - echo.podScript.at < 3 * 3600e3 ? echo.podScript : null; echo.podScript = null;
  $("echoScript").value = px ? px.text : ""; scriptInfo();
  if (px) echoHint(`Using the full transcript of "${px.title}". Pick a start time and tap Make script; no AI is needed. Clear the transcript box if this is a different episode.`);
}
/* your own transcript: .srt / .vtt / "0:12 text" lines keep their times; plain text gets timed by Gemini against the clip */
const tsec = t => { const p = t.replace(",", ".").split(":").map(Number); return p.reduce((a, b) => a * 60 + b, 0) };
const cleanCue = t => t.replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]|\([A-Z ]+\)/g, " ").replace(/^\s*(>>|-)\s*/gm, "").replace(/^[A-Z][A-Z .'-]{1,30}:\s*/gm, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
function parseScript(raw) {
  const txt = String(raw || "").replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (!txt) return null;
  const cues = [], arrow = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  if (arrow.test(txt)) {
    let prev = "";
    for (const block of txt.split(/\n\s*\n/)) {
      const lines = block.split("\n"), k = lines.findIndex(l => arrow.test(l)); if (k < 0) continue;
      const m = lines[k].match(arrow);
      let body = lines.slice(k + 1).map(l => cleanCue(l).trim()).filter(Boolean);
      // rolling captions (YouTube) repeat the previous cue's last line on top
      while (body.length && body[0] === prev) body.shift();
      if (!body.length) continue; prev = body[body.length - 1];
      cues.push({ start: tsec(m[1]), end: tsec(m[2]), text: body.join(" ") });
    }
  } else {
    // "0:12 text", "[00:12] text", or a time on its own line with the text below (copied YouTube / Apple transcripts)
    const lines = txt.split("\n"), stamp = /^\s*\[?((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\]?\s*(.*)$/;
    if (lines.filter(l => stamp.test(l)).length >= 3) {
      let cur = null;
      for (const l of lines) { const m = l.match(stamp);
        if (m) { cur = { start: tsec(m[1]), text: m[2] }; cues.push(cur) } else if (cur) cur.text += " " + l }
      cues.forEach((c, i) => { c.text = cleanCue(c.text).trim(); c.end = cues[i + 1] ? cues[i + 1].start : c.start + Math.max(2, c.text.split(/\s+/).length / 2.8) });
    }
  }
  const timed = cues.filter(c => c.text && c.end > c.start).sort((a, b) => a.start - b.start);
  if (timed.length >= 2) return { timed: toSentences(timed) };
  const plain = cleanCue(txt.split("\n").filter(l => !/^\d+$|^WEBVTT/.test(l.trim())).join("\n")).replace(/\s+/g, " ").trim();
  return plain ? { plain } : null;
}
// Cues are caption chunks, not sentences: cut each cue at sentence ends (timing split by length), then join pieces into sentences of up to ~20 words.
function toSentences(cues) {
  const pieces = [];
  for (const c of cues) {
    const parts = c.text.replace(/\s+/g, " ").trim().match(/[^.?!]+(?:[.?!]+["')\]]*|$)/g) || [c.text], total = parts.join("").length || 1;
    let t = c.start;
    for (const p of parts) { const d = (c.end - c.start) * p.length / total, x = p.trim(); if (x) pieces.push({ start: t, end: t + d, text: x }); t += d }
  }
  const out = []; let acc = null;
  for (const p of pieces) {
    if (!acc) acc = { ...p }; else { acc.text += " " + p.text; acc.end = p.end }
    if (/[.?!]["')\]]*$/.test(acc.text) || acc.text.split(" ").length >= 20) { out.push(acc); acc = null }
  }
  if (acc) out.push(acc);
  return out;
}
function scriptInfo() {
  const s = parseScript($("echoScript").value);
  $("echoScriptInfo").textContent = !s ? "Files with timestamps (.srt, .vtt) are used as they are, with no AI needed."
    : s.timed ? `Timestamps found, ${s.timed.length} lines. The part you pick is cut straight from it, with no AI needed.`
    : "No timestamps. When you tap Make script, Gemini lines up your transcript with the audio instead of transcribing it again.";
}
$("echoScript").oninput = scriptInfo;
$("echoScriptFile").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (f.size > 3e6) { toast("The transcript file is too large. Keep it under 3 MB."); return }
  $("echoScript").value = await f.text(); scriptInfo() };
function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }
$("echoFile").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) setEchoSource(f, f.name) };
$("echoLoadUrl").onclick = () => {
  const url = $("echoUrl").value.trim();
  if (/spotify\.(com|link)/i.test(url)) { echoHint("Spotify audio is encrypted, so web pages can't read it. Find the same episode's mp3 on Apple Podcasts or the show's website, or use the shows above."); return }
  if (!/^https?:\/\//i.test(url)) { toast("Paste an audio link starting with https://"); return }
  loadAudioUrl(url, $("echoLoadUrl"));
};
async function loadAudioUrl(url, b, name) {
  b.disabled = true; echoHint("Downloading, an episode is about 10–20 MB…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("This link didn't open (" + res.status + "). Make sure it points to the audio file itself.");
    const blob = await res.blob();
    if (!/audio|octet-stream|mpeg|mp4/i.test(blob.type) && blob.size < 200000) throw new Error("This link doesn't look like audio. Use a direct link ending in something like .mp3, not the episode page.");
    await setEchoSource(blob, name || decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "podcast"));
  } catch (e) {
    echoHint(e instanceof TypeError ? "This site doesn't let other pages read its audio. Download the file, then tap Upload audio." : e.message);
  } finally { b.disabled = false }
}
// podcasts.json is refreshed daily by .github/workflows/news.yml: latest episodes of one UK and one US show, links only.
// Also re-checked each time Echo opens (at most every 30 minutes), so a phone that keeps the page open for days
// still gets the new episodes; the hour in the query stops an old copy from being reused.
let pods = null, podPick = 0, podsAt = 0, podTx = null;
// Full-episode transcripts: a daily job (.github/workflows/transcripts.yml) runs Whisper on each new episode and keeps the
// result in the owner's secret gist, never in the public repo. The page reads that gist with the Sync token.
const TX_DESC = "English Desk transcripts (made by the daily job; used by the Echo tab)", TX_KEY = "englishDesk.tx";
const txFile = (show, title) => show + "-" + strHash(title) + ".json";
async function loadTranscripts() {
  let token = ""; try { token = JSON.parse(localStorage.getItem("englishDesk.sync") || "{}").token || "" } catch { }
  if (!token) return null;
  const gh = async u => { const r = await fetch(u.startsWith("http") ? u : "https://api.github.com" + u, { cache: "no-store",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" } }); if (!r.ok) throw new Error(r.status); return r.json() };
  let id = ""; try { id = localStorage.getItem(TX_KEY) || "" } catch { }
  let g = id ? await gh("/gists/" + id).catch(() => null) : null;
  if (!g) {
    for (let page = 1; page <= 5 && !g; page++) { const list = await gh(`/gists?per_page=100&page=${page}`); g = list.find(x => x.description === TX_DESC); if (list.length < 100) break }
    if (!g) return {}; g = await gh("/gists/" + g.id); try { localStorage.setItem(TX_KEY, g.id) } catch { }
  }
  const out = {};
  await Promise.all(Object.values(g.files || {}).filter(f => /\.json$/.test(f.filename)).map(async f => {
    try { out[f.filename] = f.truncated ? await (await fetch(f.raw_url)).json() : JSON.parse(f.content) } catch { } }));
  return out;
}
function toVtt(sents) {
  const ts = t => { const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = (t % 60).toFixed(3).padStart(6, "0"); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${x}` };
  return "WEBVTT\n\n" + sents.map(([a, b, t]) => `${ts(a)} --> ${ts(b)}\n${t}`).join("\n\n");
}
// The transcript waits here until the audio arrives (straight away, or after you download and upload it).
function pickTranscript(doc) { echo.podScript = doc ? { text: toVtt(doc.sentences), title: doc.title, at: Date.now() } : null }
async function loadPodcasts() {
  if (Date.now() - podsAt < 30 * 60e3) return; podsAt = Date.now();
  try { const r = await fetch("podcasts.json?d=" + today() + "-" + new Date().getHours(), { cache: "no-cache" }); if (r.ok) pods = (await r.json()).shows?.filter(s => s.episodes?.length) } catch { podsAt = 0 }
  if (pods?.length) renderPods();
  try { podTx = await loadTranscripts() } catch { podTx = null }
  if (pods?.length) renderPods();
}
function renderPods() {
  $("podBox").hidden = false;
  $("podShows").replaceChildren(...pods.map((s, k) => { const c = el("button", "chip", `${s.name} (${s.accent})`); c.setAttribute("aria-pressed", k === podPick); c.onclick = () => { podPick = k; renderPods() }; return c }));
  const s = pods[podPick];
  $("podEps").replaceChildren(...s.episodes.slice(0, 4).map(ep => { const it = el("div", "news-item"), d = ep.published ? new Date(ep.published) : null;
    const t = el("p", "pod-title", ep.title); t.lang = "en";
    it.append(el("h3", "", s.by + (d ? ` · ${d.getMonth() + 1}/${d.getDate()}` : "") + (ep.duration ? ` · ${Math.round(ep.duration / 60)} min` : "")), t);
    const row = el("div", "row");
    const tx = podTx?.[txFile(s.id, ep.title)];
    if (s.cors !== false) { const b = el("button", "btn c-save", "Use this episode"); b.onclick = () => { pickTranscript(tx); loadAudioUrl(ep.url, b, s.name + " · " + ep.title) }; row.append(b) }
    const a = el("a", "btn c-save", "Download"); a.onclick = () => pickTranscript(tx); a.href = ep.url; a.target = "_blank"; a.rel = "noopener"; a.download = ""; row.append(a);
    // Listen in a podcast app: Apple's own episode page when the daily job found it, else the show; Spotify has no
    // keyless way to look up an episode, so its link searches for the episode title.
    const ap = ep.apple || s.apple; if (ap) { const l = el("a", "btn c-save", "Apple Podcasts"); l.href = ap; l.target = "_blank"; l.rel = "noopener"; row.append(l) }
    const sp = el("a", "btn c-save", "Spotify"); sp.href = "https://open.spotify.com/search/" + encodeURIComponent(ep.title) + "/episodes"; sp.target = "_blank"; sp.rel = "noopener"; row.append(sp);
    if (s.cors === false) row.append(el("span", "muted", "This show doesn't let web pages read its audio. Download it, then tap Upload audio."));
    it.append(row); if (tx) it.append(el("p", "muted", `Full transcript ready (${tx.sentences.length} sentences), filled in when you use this episode.`)); return it }));
  const note = $("podTx"), n = podTx ? Object.keys(podTx).length : 0;
  note.hidden = !!n; note.textContent = podTx === null ? "Turn on Sync in Settings to get a full transcript of each episode, made every day with Whisper."
    : "Full transcripts are made a few hours after each episode comes out. None are ready yet.";
}
document.querySelectorAll("#echoLens .chip").forEach(c => c.onclick = () => {
  echo.len = +c.dataset.len; document.querySelectorAll("#echoLens .chip").forEach(x => x.setAttribute("aria-pressed", x === c));
});

// An ID3 tag (cover art can be hundreds of KB) sits before the audio and would push every byte-offset cut late.
async function id3Size(blob) {
  try { const h = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (h[0] !== 73 || h[1] !== 68 || h[2] !== 51) return 0;
    return 10 + ((h[6] & 127) << 21 | (h[7] & 127) << 14 | (h[8] & 127) << 7 | (h[9] & 127)) + (h[5] & 16 ? 10 : 0) } catch { return 0 }
}
// Decode just the chosen stretch. Big MP3s are cut by byte offset first (MP3 frames resync), so a phone never decodes an hour of audio.
async function decodeClip(start, len) {
  const blob = echo.blob, ctx = echoCtx();
  const mp3 = /mpeg|mp3/i.test(blob.type) || /\.mp3$/i.test(echo.name);
  let part = blob, off = 0;
  if (echo.dur && blob.size > 6e6) {
    if (mp3) { const id3 = await id3Size(blob), bps = (blob.size - id3) / echo.dur; part = blob.slice(id3 + Math.floor(start * bps), id3 + Math.ceil((start + len + 2) * bps)); off = start }
    else if (blob.size > 12e6) throw new Error("The file is too large. Trim non-mp3 files to under 10 minutes first, or use an mp3.");
  }
  let audio;
  try { const ab = await part.arrayBuffer(); audio = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)) }
  catch { throw new Error("This audio can't be decoded. Try an mp3 or m4a.") }
  const r = audio.sampleRate, s0 = Math.max(0, Math.round((start - off) * r)), n = Math.min(audio.length - s0, Math.round(len * r));
  if (n < r * 5) throw new Error("This clip is too short. Check that the start time is within the audio.");
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[s0 + i] / audio.numberOfChannels }
  return { data: mono, rate: r };
}
// Gemini's times can be a few hundred ms off: move each edge to the quietest 20 ms frame within ±0.5 s.
function snapTimes(sents, data, rate) {
  const hop = Math.round(rate * .02), nf = Math.floor(data.length / hop), e = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; for (let j = f * hop; j < (f + 1) * hop; j++) s += data[j] * data[j]; e[f] = s }
  const quiet = t => { const c = Math.round(t / .02); let best = Math.max(0, Math.min(nf - 1, c));
    for (let f = Math.max(0, c - 25); f <= Math.min(nf - 1, c + 25); f++) if (e[f] < e[best] * .7) best = f;
    return best * .02 };
  const dur = data.length / rate; let prev = 0;
  return sents.map(s => { let a = Math.max(prev, quiet(s.start)), b = Math.min(dur, quiet(s.end));
    if (b - a < .4) { a = Math.max(prev, s.start); b = Math.min(dur, s.end) } prev = b; return { ...s, start: a, end: b } }).filter(s => s.end - s.start >= .4);
}
function cacheKey(start, len) { return [echo.name, echo.blob.size, Math.round(start), len].join("|") }
function cacheGet(k) { try { return (JSON.parse(localStorage.getItem(ECHO_CACHE) || "[]").find(x => x.k === k) || {}).sents } catch { } }
function cachePut(k, sents) {
  try { const list = JSON.parse(localStorage.getItem(ECHO_CACHE) || "[]").filter(x => x.k !== k); list.unshift({ k, sents }); localStorage.setItem(ECHO_CACHE, JSON.stringify(list.slice(0, 5))) } catch { }
}
$("echoGo").onclick = async () => {
  if (!echo.blob) return;
  const start = parseStart($("echoStart").value), len = echo.len;
  if (isNaN(start)) { toast("Write the start time as 12:30 or 12.5 (minutes)."); return }
  if (echo.dur && start >= echo.dur - 5) { toast("The start time is past the end of the audio."); return }
  const btn = $("echoGo"); btn.disabled = true; btn.textContent = "Working…"; echoHint("Cutting the clip…");
  echoStopPlay(); echo.ctl = new AbortController(); $("echoStop").hidden = false;
  try {
    const clip = await decodeClip(start, Math.min(len, echo.dur ? echo.dur - start : len));
    const dur = clip.data.length / clip.rate, script = parseScript($("echoScript").value);
    const key = cacheKey(start, len) + (script?.plain ? "|" + strHash(script.plain) : ""); let sents = script?.timed ? null : cacheGet(key);
    if (script?.timed) {
      // Times in the file are from the start of the episode; keep the sentences that sit inside this clip.
      sents = script.timed.filter(s => s.start >= start - .3 && s.end <= start + dur + .3).map(s => ({ start: Math.max(0, s.start - start), end: Math.min(dur, s.end - start), text: s.text }));
      if (!sents.length) throw new Error(`No transcript timestamps fall within ${fmt(start)}–${fmt(start + dur)}. Check the start time, or whether the transcript is for this episode.`);
      sents = snapTimes(sents, clip.data, clip.rate);
    } else if (!sents) {
      if (!cfg.geminiKey) throw new AiError(script ? "A transcript without timestamps needs Gemini to line it up. Add a Gemini API key in Settings, or upload an .srt / .vtt instead." : "Scripts are made with Gemini. Add a Gemini API key in Settings first.", "nokey");
      echoHint(script ? "Gemini is lining up your transcript, about 20–60 seconds…" : "Gemini is transcribing and splitting sentences, about 20–60 seconds…");
      const ask = script ? `Here is my own transcript of the episode this clip comes from. It may cover much more than the clip.
Find the part of it that is spoken in this clip and split that part into sentences for shadowing practice. If a sentence runs past about 20 words, split it at a natural pause.
Keep the transcript's own wording and spelling: don't rewrite, correct or re-transcribe it. Leave out speaker names and notes like [music].
For each piece give its start and end time in seconds from the start of this clip, to 0.1 s: start right as the first word begins, end right after the last word.
Leave out a sentence that is cut off at the very start or the very end of the clip.
Reply with only JSON: {"sentences":[{"start":0.0,"end":3.2,"text":"..."}]}

Transcript:
${script.plain.slice(0, 60000)}` : `Transcribe this clip word for word and split it into sentences for shadowing practice. If a sentence runs past about 20 words, split it at a natural pause. Drop fillers like "um" and "uh".
For each piece give its start and end time in seconds from the start of this clip, to 0.1 s: start right as the first word begins, end right after the last word.
Leave out a sentence that is cut off at the very start or the very end of the clip.
Reply with only JSON: {"sentences":[{"start":0.0,"end":3.2,"text":"..."}]}`;
      const r = await gemini(script ? "You line up a given transcript with English audio for a shadowing exercise. You reply with JSON only." : "You transcribe English audio for a shadowing exercise. You reply with JSON only.", [
        { inlineData: { mimeType: "audio/wav", data: b64(wav16k(clip.data, clip.rate)) } },
        { text: ask }], { json: true, signal: echo.ctl.signal });
      sents = (Array.isArray(r.sentences) ? r.sentences : []).map(s => ({ start: +s.start, end: +s.end, text: String(s.text || "").trim() }))
        .filter(s => s.text && isFinite(s.start) && isFinite(s.end) && s.end > s.start && s.start < dur).sort((a, b) => a.start - b.start);
      sents = snapTimes(sents, clip.data, clip.rate);
      if (!sents.length) throw new Error(script ? "Gemini couldn't find the transcript's sentences in this clip. Check the start time, or whether the transcript is for this episode." : "Gemini didn't hear any sentences. Try a part where someone is talking.");
      cachePut(key, sents);
    }
    const ab = echo.ctx.createBuffer(1, clip.data.length, clip.rate); ab.getChannelData(0).set(clip.data);
    Object.assign(echo, { buf: ab, data: clip.data, rate: clip.rate, sents, i: 0, mine: {}, scores: {}, pitchCache: {} });
    $("echoClip").textContent = "About " + fmt(start) + "–" + fmt(start + clip.data.length / clip.rate);
    $("echoPlayer").hidden = false; $("echoListBox").hidden = false; echoHint("");
    renderSents(); showSentence(0); $("echoPlayer").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.code !== "cancelled") { echoHint(errText(e)); if (e.code === "nokey" || e.code === "auth" || e.code === "model") banner(errText(e), true) } else echoHint("");
  } finally { btn.disabled = false; btn.textContent = "Make script"; $("echoStop").hidden = true }
};
$("echoStop").onclick = () => echo.ctl?.abort();

/* playback */
function echoStopPlay() { clearTimeout(echo.loopT); const s = echo.src; echo.src = null; if (s) try { s.stop() } catch { } $("echoPlay").textContent = "▶ Original" }
function playBuf(buf, a, b, then, rate = 1) {
  echoStopPlay(); const ctx = echoCtx(), s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.connect(ctx.destination);
  s.onended = () => { if (echo.src !== s) return; echo.src = null; $("echoPlay").textContent = "▶ Original"; then && then() };
  echo.src = s; s.start(0, a, Math.max(.05, b - a));
}
function clipOf(i) { const x = echo.sents[i]; return [Math.max(0, x.start - .05), Math.min(echo.buf.duration, x.end + .15)] }
function playSentence(then) {
  const [a, b] = clipOf(echo.i);
  // In loop mode, leave a gap as long as the sentence so you can say it along before it plays again.
  playBuf(echo.buf, a, b, then || (() => { if (echo.loop) echo.loopT = setTimeout(() => playSentence(), Math.max(1500, (b - a) / echo.speed * 1000 + 600)) }), echo.speed);
  $("echoPlay").textContent = "■ Stop";
}
function playMine(then) { const m = echo.mine[echo.i]; if (!m) return; playBuf(m.buf, 0, m.buf.duration, then) }
$("echoPlay").onclick = () => { if (echo.src) echoStopPlay(); else playSentence() };
$("echoMine").onclick = () => playMine();
$("echoBoth").onclick = () => playSentence(() => setTimeout(() => playMine(), 400));
$("echoLoop").onclick = () => { echo.loop = !echo.loop; $("echoLoop").setAttribute("aria-pressed", echo.loop); if (!echo.loop) clearTimeout(echo.loopT); else if (!echo.src) playSentence() };
document.querySelectorAll("#echoSpeeds .chip").forEach(c => c.onclick = () => {
  echo.speed = +c.dataset.speed; document.querySelectorAll("#echoSpeeds .chip").forEach(x => x.setAttribute("aria-pressed", x === c));
});
$("echoPrev").onclick = () => showSentence(echo.i - 1, true);
$("echoNext").onclick = () => showSentence(echo.i + 1, true);

function showSentence(i, play) {
  if (i < 0 || i >= echo.sents.length) return;
  echoStopPlay(); echo.i = i;
  $("echoPos").textContent = `Sentence ${i + 1} / ${echo.sents.length}`;
  $("echoPrev").disabled = i === 0; $("echoNext").disabled = i === echo.sents.length - 1;
  const m = echo.mine[i];
  $("echoMineRow").hidden = !m; $("echoScore").disabled = !m;
  if (m) $("echoDur").textContent = durText(i);
  drawPitch(); renderScore(); renderSents();
  if (play) playSentence();
}
/* pitch: a YIN-style F0 track every 10 ms, in semitones from the speaker's own median, original and take on one chart */
function pitchTrack(data, rate) {
  const k = Math.max(1, Math.round(rate / 8000)), r = rate / k, n = Math.floor(data.length / k), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < k; j++) s += data[i * k + j]; x[i] = s / k } // average = rough low-pass before thinning
  const W = Math.round(r * .04), hop = Math.round(r * .01), tMin = Math.floor(r / 400), tMax = Math.ceil(r / 70), d = new Float32Array(tMax + 1);
  const frames = [], rms = [];
  for (let f = 0; f + W + tMax < n; f += hop) {
    let e = 0; for (let i = 0; i < W; i++) e += x[f + i] * x[f + i]; rms.push(Math.sqrt(e / W));
    let sum = 0, best = -1;
    for (let t = 1; t <= tMax; t++) { let v = 0; for (let i = 0; i < W; i++) { const q = x[f + i] - x[f + i + t]; v += q * q } sum += v; d[t] = sum ? v * t / sum : 1 }
    for (let t = tMin; t <= tMax; t++) if (d[t] < .15) { while (t < tMax && d[t + 1] < d[t]) t++; best = t; break }
    // parabolic interpolation around the dip, so the line isn't a staircase of whole-sample lags
    if (best > 0 && best < tMax) { const a0 = d[best - 1], a1 = d[best], a2 = d[best + 1], den = a0 - 2 * a1 + a2; if (den > 0) best += .5 * (a0 - a2) / den }
    frames.push(best > 0 ? r / best : 0);
  }
  const loud = Math.max(...rms, 1e-6) * .08;
  const hz = frames.map((v, i) => (v && rms[i] > loud ? v : 0));
  const voiced = hz.filter(Boolean).sort((a, b) => a - b); if (voiced.length < 5) return null;
  const mid = voiced[voiced.length >> 1];
  let st = hz.map(v => (v ? 12 * Math.log2(v / mid) : null));
  // drop single-frame jumps (octave errors) and trim silence at both ends
  st = st.map((v, i) => (v != null && Math.abs(v) > 12 ? null : v));
  const a = st.findIndex(v => v != null), b = st.length - [...st].reverse().findIndex(v => v != null);
  return st.slice(a, b);
}
function drawPitch() {
  const box = $("echoPitchBox"), m = echo.mine[echo.i];
  if (!m || !echo.buf) { box.hidden = true; return }
  const [a, b] = clipOf(echo.i), r = echo.rate;
  m.pitch = m.pitch || pitchTrack(m.data, m.rate);
  const cache = echo.pitchCache ||= {}, orig = cache[echo.i] ??= pitchTrack(echo.data.subarray(Math.floor(a * r), Math.floor(b * r)), r);
  if (!orig || !m.pitch) { box.hidden = true; return }
  box.hidden = false;
  const cv = $("echoPitch"), dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 600, h = cv.clientHeight || 120;
  cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement), pad = 10, y = v => h / 2 - v / 8 * (h / 2 - pad); // ±8 semitones fills the height
  g.strokeStyle = css.getPropertyValue("--line").trim(); g.globalAlpha = .25; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  const line = (st, color, width) => { g.strokeStyle = color; g.lineWidth = width; g.lineJoin = g.lineCap = "round"; g.beginPath(); let on = false;
    st.forEach((v, i) => { const px = pad + i / Math.max(1, st.length - 1) * (w - 2 * pad);
      if (v == null) { on = false; return } const py = y(Math.max(-8, Math.min(8, v))); if (on) g.lineTo(px, py); else g.moveTo(px, py); on = true }); g.stroke() };
  line(orig, css.getPropertyValue("--ink-muted").trim(), 3); line(m.pitch, css.getPropertyValue("--strike").trim(), 2.5);
}
function durText(i) { const [a, b] = clipOf(i); return `Original ${(b - a).toFixed(1)}s · You ${echo.mine[i].buf.duration.toFixed(1)}s` }
function renderSents() {
  $("echoList").replaceChildren(...echo.sents.map((s, i) => { const li = document.createElement("li"), b = document.createElement("button");
    if (i === echo.i) b.setAttribute("aria-current", "true");
    const n = document.createElement("span"); n.className = "num"; n.textContent = i + 1;
    const t = document.createElement("span"); t.lang = "en"; t.textContent = s.text;
    const sc = document.createElement("span"); sc.className = "sc"; const r = echo.scores[i];
    sc.textContent = r ? (r.engine === "azure" ? Math.round(r.overall) + " pts" : "Tips") : echo.mine[i] ? "Recorded" : "";
    if (r?.tips?.length) t.append(el("span", "tip", r.tips[0]));
    b.append(n, t, sc); b.onclick = () => showSentence(i, true); li.append(b); return li }));
}

/* recording: hold the button, release to stop */
async function echoMic() {
  if (echo.mic) return true;
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
  const ctx = echoCtx();
  try { echo.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }) }
  catch (e) {
    const msg = e && e.name === "NotAllowedError" ? "Mic access was blocked. Allow this site to use the mic in your browser (on iPhone: Settings > Safari > Microphone) and try again." : "Can't open the mic. Check whether another app is using it.";
    toast(msg); echoHint(msg); return false;
  }
  echo.micSrc = ctx.createMediaStreamSource(echo.mic);
  const take = f => { if (echo.recording) echo.chunks.push(f) };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    echo.node = new AudioWorkletNode(ctx, "tap"); echo.node.port.onmessage = e => take(e.data);
  } catch { echo.node = ctx.createScriptProcessor(4096, 1, 1); echo.node.onaudioprocess = e => take(e.inputBuffer.getChannelData(0).slice(0)) }
  const sink = ctx.createGain(); sink.gain.value = 0; echo.micSrc.connect(echo.node); echo.node.connect(sink); sink.connect(ctx.destination);
  return true;
}
function echoMicOff() {
  try { echo.micSrc && echo.micSrc.disconnect(); echo.node && echo.node.disconnect() } catch { }
  try { echo.mic && echo.mic.getTracks().forEach(t => t.stop()) } catch { }
  Object.assign(echo, { mic: null, micSrc: null, node: null, recording: false, holding: false }); clearInterval(echo.recT);
}
const recBtn = $("echoRec");
async function recStart() {
  if (echo.holding || !echo.buf) return;
  echo.holding = true; echoStopPlay(); echo.loop = false; $("echoLoop").setAttribute("aria-pressed", "false");
  if (!echo.mic) { recBtn.textContent = "Getting the mic ready…"; const ok = await echoMic(); recBtn.textContent = "Hold to record";
    if (!ok) { echo.holding = false; return }
    if (!echo.holding) { toast("The mic is ready. Hold the button and say it again."); return } }
  echo.chunks = []; echo.recording = true; echo.t0 = Date.now(); recBtn.classList.add("on");
  const tick = () => { const s = (Date.now() - echo.t0) / 1000; recBtn.textContent = "● Recording " + fmt(s) + " · let go to stop"; if (s >= REC_MAX) recStop() };
  tick(); echo.recT = setInterval(tick, 250);
}
function recStop() {
  echo.holding = false; if (!echo.recording) return;
  echo.recording = false; clearInterval(echo.recT); recBtn.classList.remove("on"); recBtn.textContent = "Hold to record";
  const data = concat(echo.chunks), rate = echo.ctx.sampleRate; echo.chunks = [];
  if (data.length < rate * .4) { toast("Too short. Hold the button through the whole sentence, then let go."); return }
  const buf = echo.ctx.createBuffer(1, data.length, rate); buf.getChannelData(0).set(data);
  echo.mine[echo.i] = { data, rate, buf }; delete echo.scores[echo.i];
  $("echoMineRow").hidden = false; $("echoScore").disabled = false; $("echoDur").textContent = durText(echo.i);
  drawPitch(); renderScore(); renderSents();
}
recBtn.addEventListener("pointerdown", e => { if (e.button) return; e.preventDefault(); try { recBtn.setPointerCapture(e.pointerId) } catch { } recStart() });
recBtn.addEventListener("pointerup", recStop); recBtn.addEventListener("pointercancel", recStop);
recBtn.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); recStart() } });
recBtn.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); recStop() } });
recBtn.addEventListener("contextmenu", e => e.preventDefault());

/* scoring: Azure pronunciation assessment, or Gemini advice without a key */
class AzureError extends Error { }
async function azureAssess(wav, text, signal) {
  const params = { ReferenceText: text, GradingSystem: "HundredMark", Granularity: "Phoneme", PhonemeAlphabet: "IPA", Dimension: "Comprehensive", EnableMiscue: "True", EnableProsodyAssessment: "True" };
  const header = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(params))));
  let res;
  try {
    res = await fetch(`https://${encodeURIComponent(cfg.azureRegion)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`, { method: "POST", signal,
      headers: { "Ocp-Apim-Subscription-Key": cfg.azureKey, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", "Pronunciation-Assessment": header, Accept: "application/json" }, body: wav });
  } catch (e) { if (e.name === "AbortError") throw new AiError("", "cancelled"); throw new AzureError("Can't reach Azure. Check your connection and the region in Settings (e.g. eastasia).") }
  if (res.status === 401 || res.status === 403) throw new AzureError("The Azure key or region is wrong. Check them in Settings.");
  if (res.status === 429) throw new AzureError("The Azure free quota is used up or there were too many requests. Try again in a moment.");
  if (!res.ok) throw new AzureError("Azure returned an error: " + res.status);
  return res.json();
}
function azureResult(d) {
  if (d.RecognitionStatus !== "Success" || !d.NBest?.length) throw new AzureError("Azure didn't hear you. Move closer to the mic and record again.");
  const n = d.NBest[0], p = n.PronunciationAssessment || n;
  return { engine: "azure", overall: p.PronScore, acc: p.AccuracyScore, flu: p.FluencyScore, comp: p.CompletenessScore, pros: p.ProsodyScore,
    words: (n.Words || []).map(w => { const q = w.PronunciationAssessment || w; return { word: w.Word, score: q.AccuracyScore, err: q.ErrorType || "None",
      breakErr: (q.Feedback?.Prosody?.Break?.ErrorTypes || []).filter(x => x !== "None"), tone: (q.Feedback?.Prosody?.Intonation?.ErrorTypes || []).filter(x => x !== "None"),
      phones: (w.Phonemes || []).map(ph => ({ ph: ph.Phoneme, score: (ph.PronunciationAssessment || ph).AccuracyScore })).filter(ph => ph.ph && ph.score != null) } }) };
}
/* advice next to each Azure score: quick rules right away, then Gemini's wording when there's a Gemini key */
// Mouth positions for the sounds Mandarin speakers most often trip on (Azure's IPA symbols).
const PHONE_TIP = {
  "θ": "tongue tip between the teeth and blow, as in think, not s or f", "ð": "tongue between the teeth with your voice on, as in this, not d or z",
  "v": "top teeth on the lower lip with your voice on, not b or w", "ɹ": "curl the tongue back without touching the roof of the mouth, lips a little round",
  "r": "curl the tongue back without touching the roof of the mouth, lips a little round",
  "l": "touch the tongue tip behind the top teeth, and keep it there at the end of a word (feel), don't turn it into o",
  "æ": "open the mouth wide and spread the lips, as in cat, not the e of bet", "ɪ": "short and relaxed, as in sit, not the long ee of seat",
  "i": "long and tense, smile a little, as in seat", "ʊ": "short and relaxed, as in book, not the long oo of food", "u": "long, with rounded lips, as in food",
  "z": "keep your voice on and buzz, as in is and was, not s", "ʃ": "round the lips and push air, as in she, not s", "ʒ": "like sh with your voice on, as in usual",
  "ŋ": "lift the back of the tongue, as in sing, and don't add a g", "n": "tongue tip behind the top teeth; keep it clear at the end of a word",
  "ɚ": "keep the tongue curled for an r colour, as in teacher", "ɝ": "tongue curled back, lips relaxed, as in bird", "ə": "keep it short and weak, as in about",
  "ʌ": "short and open, as in cup, not the o of cop", "ɑ": "open the mouth wide, as in father", "ɔ": "round the lips, as in thought",
  "eɪ": "glide from e to ee, as in day", "oʊ": "glide from o to oo with rounding lips, as in go", "aɪ": "glide from ah to ee, as in my", "aʊ": "glide from ah to oo, as in now",
  "dʒ": "like j in judge, voice on", "tʃ": "like ch in church, a quick burst of air",
};
const STOPS = new Set(["p", "b", "t", "d", "k", "g", "s", "z", "f", "v", "θ", "ð", "ʃ", "ʒ", "tʃ", "dʒ", "l", "n", "m", "ŋ"]);
function phoneTip(w) {
  const ph = (w.phones || []).reduce((m, p) => (!m || p.score < m.score ? p : m), null);
  if (!ph || ph.score >= 70) return w.err === "Omission" ? `Say "${w.word}" too, even if it's short.` : "";
  const last = w.phones[w.phones.length - 1] === ph && STOPS.has(ph.ph);
  return `/${ph.ph}/ in "${w.word}"` + (PHONE_TIP[ph.ph] ? ": " + PHONE_TIP[ph.ph] : "") + (last && !PHONE_TIP[ph.ph] ? ": say the final sound, don't drop it" : last ? ". Don't drop it at the end of the word" : "") + ".";
}
function ruleTips(r, i) {
  const tips = [], ws = r.words.filter(w => w.err !== "Insertion");
  const missed = ws.filter(w => w.err === "Omission").map(w => w.word);
  if (missed.length) tips.push(`You left out ${missed.slice(0, 4).map(x => `"${x}"`).join(", ")}. Say every word, even the small ones.`);
  // the worst sound first, then rhythm, then the next sound, so one take's advice isn't all about sounds
  const sounds = ws.filter(w => w.err !== "Omission").map(w => ({ tip: phoneTip(w), low: Math.min(...(w.phones || []).map(p => p.score), 100) }))
    .filter(x => x.tip).sort((a, b) => a.low - b.low).map(x => x.tip.charAt(0).toUpperCase() + x.tip.slice(1));
  if (sounds[0]) tips.push(sounds[0]);
  const brk = ws.find(w => w.breakErr.includes("UnexpectedBreak")), miss = ws.find(w => w.breakErr.includes("MissingBreak")), flat = ws.find(w => w.tone.includes("Monotone"));
  if (brk) tips.push(`Don't stop before "${brk.word}". Keep that phrase in one breath.`);
  if (miss) tips.push(`Take a short pause after "${miss.word}", like the speaker does.`);
  if (flat) tips.push(`Your voice is flat around "${flat.word}". Let it rise and fall like the original; the pitch chart shows where.`);
  if (sounds[1]) tips.push(sounds[1]);
  const m = echo.mine[i];
  if (m) { const [a, b] = clipOf(i), ratio = m.buf.duration / (b - a);
    if (ratio > 1.35) tips.push(`You took ${m.buf.duration.toFixed(1)}s and the speaker ${(b - a).toFixed(1)}s. Link the words and don't stop between them.`);
    else if (ratio < .7) tips.push("You were much faster than the speaker. Slow down so each word is clear."); }
  if (r.flu != null && r.flu < 70 && !brk && tips.length < 3) tips.push("The flow was choppy. Play it on loop and say it along a few times before recording.");
  if (!tips.length) tips.push(r.overall >= 85 ? "Very close to the original. Try it at full speed without looking at the text." : "Good overall. Listen once more for the stress and try again.");
  const wordTips = {}; ws.forEach(w => { const t = phoneTip(w); if (t) wordTips[w.word.toLowerCase()] = t });
  return { tips: tips.slice(0, 3), wordTips };
}
async function aiCoach(i, r, signal) {
  const s = echo.sents[i], m = echo.mine[i], [a, b] = clipOf(i);
  const words = r.words.filter(w => w.err !== "Insertion").map(w => ({ word: w.word, score: Math.round(w.score), error: w.err,
    pauses: w.breakErr, intonation: w.tone, weakSounds: (w.phones || []).filter(p => p.score < 75).map(p => `/${p.ph}/ ${Math.round(p.score)}`) }));
  const res = await gemini("You are a precise, encouraging English pronunciation coach for a Taiwanese learner (Mandarin first language, around B2). You reply with JSON only.", [{ text:
`Azure scored my shadowing of this sentence. Turn the scores into advice I can use on my next try.
Sentence: ${s.text}
Overall ${Math.round(r.overall)}, accuracy ${Math.round(r.acc)}, fluency ${Math.round(r.flu)}, completeness ${Math.round(r.comp)}${r.pros != null ? ", prosody " + Math.round(r.pros) : ""}.
Original took ${(b - a).toFixed(1)}s; I took ${m ? m.buf.duration.toFixed(1) : "?"}s.
Per word: ${JSON.stringify(words)}
Focus on the 2 or 3 things that would raise the score most. For a sound, say how to place the tongue, lips or teeth. For rhythm, say which words to link, stress or pause on. Plain English, short.
Reply with only JSON: {"summary":"one short sentence","tips":["up to 3 tips, most important first"],"words":[{"word":"a word that needs work","tip":"one short tip"}]}` }], { json: true, signal });
  const wordTips = {}; (Array.isArray(res.words) ? res.words : []).forEach(w => { if (w && w.word && w.tip) wordTips[String(w.word).toLowerCase()] = String(w.tip) });
  return { tips: (Array.isArray(res.tips) ? res.tips : []).slice(0, 3).map(String).filter(Boolean), wordTips, summary: String(res.summary || "") };
}
async function geminiAdvice(i, signal) {
  const s = echo.sents[i], [a, b] = clipOf(i), r = echo.rate, orig = echo.data.subarray(Math.floor(a * r), Math.floor(b * r)), m = echo.mine[i];
  const res = await gemini("You are a precise English pronunciation coach for a Taiwanese learner. You reply with JSON only.", [
    { text: "Reference sentence: " + s.text + "\nFirst, the original speaker:" },
    { inlineData: { mimeType: "audio/wav", data: b64(wav16k(orig, r)) } },
    { text: "Now my recording, shadowing that sentence:" },
    { inlineData: { mimeType: "audio/wav", data: b64(wav16k(m.data, m.rate)) } },
    { text: `Compare my recording with the original and the reference text. Judge pronunciation only: individual sounds, word stress, linking, rhythm and intonation. Be honest and specific; don't praise what isn't there.
Reply with only JSON: {"words":[{"word":"each word of the reference sentence, in order","status":"good|unclear|wrong|missing","tip":"a short tip in plain English, only when status isn't good"}],"tips":["up to 3 tips in plain English, most important first"],"summary":"one sentence of overall feedback in plain English"}` }], { json: true, signal });
  return { engine: "gemini", words: (Array.isArray(res.words) ? res.words : []).filter(w => w && w.word).map(w => ({ word: String(w.word), status: w.status, tip: w.tip || "" })),
    tips: (Array.isArray(res.tips) ? res.tips : []).slice(0, 3).map(String), summary: res.summary || "" };
}
$("echoScore").onclick = async () => {
  const i = echo.i, m = echo.mine[i]; if (!m) return;
  const azure = use("pron") === "azure";
  if (!azure && !cfg.geminiKey) { banner("Pronunciation scoring needs an Azure or Gemini key. Add one in Settings first.", true); return }
  const btn = $("echoScore"); btn.disabled = true; btn.textContent = "Scoring…"; echo.ctl = new AbortController();
  try {
    const r = azure ? azureResult(await azureAssess(wav16k(m.data, m.rate), echo.sents[i].text, echo.ctl.signal)) : await geminiAdvice(i, echo.ctl.signal);
    if (azure) Object.assign(r, ruleTips(r, i));
    echo.scores[i] = r;
    if (echo.i === i) renderScore(); renderSents();
    // Gemini rewrites the rule tips into advice for this exact take; the score is already on screen, so this never blocks.
    if (azure && cfg.geminiKey) aiCoach(i, r, echo.ctl.signal).then(c => {
      if (echo.scores[i] !== r || !c.tips.length) return;
      Object.assign(r, { tips: c.tips, summary: c.summary, wordTips: { ...r.wordTips, ...c.wordTips }, coach: "gemini" });
      if (echo.i === i) renderScore(); renderSents();
    }).catch(() => { if (echo.scores[i] === r) { r.coach = "none"; if (echo.i === i) renderScore() } });
  } catch (e) { if (e.code !== "cancelled") { toast(e.message || errText(e)); if (/Settings/.test(e.message || "")) banner(e.message, true) } }
  finally { btn.disabled = false; btn.textContent = "Score pronunciation" }
};
const ERR = { Mispronunciation: "mispronounced", Omission: "missed", Insertion: "extra word", UnexpectedBreak: "unexpected pause", MissingBreak: "missing pause", Monotone: "flat intonation" };
const QUALITY = { good: "", unclear: "mid", wrong: "bad", missing: "miss" };
function renderScore() {
  const r = echo.scores[echo.i], box = $("echoResult"), line = $("echoLine"), s = echo.sents[echo.i];
  $("echoEngine").textContent = use("pron") === "azure" ? "Scored by Azure pronunciation assessment" : keyFor("azure") ? "Tips from Gemini (chosen in Settings)" : "No Azure key, so Gemini gives tips instead";
  box.hidden = !r;
  if (!r) { line.textContent = s ? s.text : ""; return }
  // Words: colour plus a text list below, so colour is never the only signal.
  const words = r.engine === "azure"
    ? r.words.filter(w => w.err !== "Insertion").map(w => ({ word: w.word, q: w.err === "Omission" ? "miss" : w.err === "Mispronunciation" || w.score < 60 ? "bad" : w.score < 80 ? "mid" : "", title: Math.round(w.score) + " pts" }))
    : r.words.map(w => ({ word: w.word, q: QUALITY[w.status] || "", title: w.tip }));
  line.replaceChildren(...words.flatMap((w, k) => { const sp = document.createElement("span"); sp.className = "w"; if (w.q) sp.dataset.q = w.q; sp.textContent = w.word; if (w.title) sp.title = w.title; return k ? [" ", sp] : [sp] }));
  const tiles = $("echoTiles"), weak = $("echoWeak"), tips = $("echoTips");
  tiles.hidden = r.engine !== "azure";
  if (r.engine === "azure") {
    tiles.replaceChildren(...[["Overall", r.overall], ["Accuracy", r.acc], ["Fluency", r.flu], ["Completeness", r.comp], ["Prosody", r.pros]].filter(x => x[1] != null).map(([k, v]) => {
      const d = document.createElement("div"), b = document.createElement("b"), l = document.createElement("span"); b.textContent = Math.round(v); l.textContent = k; d.append(b, l); return d }));
    const list = r.words.filter(w => w.err !== "None" || w.score < 80 || w.breakErr.length || w.tone.length);
    weak.replaceChildren(...(list.length ? list.slice(0, 8).map(w => { const p = document.createElement("p"); p.className = "c-why";
      const why = [w.err !== "None" ? ERR[w.err] || w.err : "", ...w.breakErr.map(x => ERR[x] || x), ...w.tone.map(x => ERR[x] || x)].filter(Boolean);
      const tip = (r.wordTips || {})[w.word.toLowerCase()];
      p.innerHTML = ""; const b = document.createElement("b"); b.lang = "en"; b.textContent = w.word; p.append(b, ` ${Math.round(w.score)} pts` + (why.length ? " · " + why.join(", ") : "") + (tip ? " · " + tip : "")); return p })
      : [Object.assign(document.createElement("p"), { className: "c-why", textContent: "Every word scored 80 or higher." })]));
    tips.replaceChildren(...(r.tips || []).map(t => Object.assign(document.createElement("li"), { textContent: t })));
    $("echoSummary").textContent = (r.summary ? r.summary + " " : "") + (r.coach === "gemini" ? "Advice written by Gemini from Azure's scores." : r.coach === "none" ? "" : cfg.geminiKey ? "Gemini is writing more specific advice…" : "Add a Gemini key in Settings for advice written for each take.");
  } else {
    const list = r.words.filter(w => w.status && w.status !== "good");
    weak.replaceChildren(...list.slice(0, 8).map(w => { const p = document.createElement("p"); p.className = "c-why"; const b = document.createElement("b"); b.lang = "en"; b.textContent = w.word;
      p.append(b, " " + ({ unclear: "unclear", wrong: "mispronounced", missing: "missed" }[w.status] || w.status) + (w.tip ? " · " + w.tip : "")); return p }));
    tips.replaceChildren(...r.tips.map(t => Object.assign(document.createElement("li"), { textContent: t })));
    $("echoSummary").textContent = r.summary + " These are Gemini's tips, without exact scores. Add an Azure key in Settings to get a score for each word.";
  }
}
$("echoDone").onclick = () => {
  const n = Object.keys(echo.mine).length;
  if (!n) { toast("Shadow a few sentences before you finish."); return }
  const sc = Object.values(echo.scores).filter(r => r.engine === "azure").map(r => r.overall);
  addLog({ type: "echo", topic: echo.title + ` · ${n} sentences`, level: "", score: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null });
  echoStopPlay(); echoMicOff(); toast("Saved and counted toward this week.");
};
function echoLeave() { echoStopPlay(); if (echo.recording) recStop(); echoMicOff() }
addEventListener("pagehide", echoLeave);

/* ---------- corrections + cards ---------- */
function renderCorr(box, items, source) {
  if (!items.length) { box.innerHTML = '<p class="muted">Nothing needed fixing this time.</p>'; return }
  box.replaceChildren(...items.map(it => { const el = document.createElement("div"); el.className = "c-item";
    const a = document.createElement("div"); a.className = "c-mine"; a.textContent = it.mine;
    const b = document.createElement("div"); b.className = "c-nat"; b.textContent = it.natural;
    const c = document.createElement("div"); c.className = "c-why"; c.textContent = it.why || "";
    const s = document.createElement("button"); s.className = "btn c-save"; s.textContent = "Save as card";
    s.onclick = () => { saveCard(it, source); persist(); s.textContent = "Saved"; s.disabled = true };
    el.append(a, b, c, s); return el }));
}
function saveCard(it, source) {
  if (st.cards.some(c => c.mine === it.mine && c.natural === it.natural)) return false;
  st.cards.push({ id: uid(), mine: String(it.mine), natural: String(it.natural), why: String(it.why || ""), source, created: today(), due: today(), box: 0, updated: Date.now() });
  return true;
}
function saveAll(items, source, box) {
  let n = 0; for (const it of items) if (saveCard(it, source)) n++;
  persist(); box.querySelectorAll(".c-save").forEach(b => { b.textContent = "Saved"; b.disabled = true });
  toast(n ? `Saved ${n} card${n > 1 ? "s" : ""}` : "These are already saved");
}
/* ---------- review: Anki-style spacing (SM-2) ---------- */
// Each card keeps `ease` (2.5 to start), `ivl` (days, 0 = still learning), `lapses` and `last` (when it was last graded).
// `due` and `box` stay as before so older copies of the site and backups still read them; `box` is now the review count.
// Cards from before this change have only `box`: their interval comes from the old fixed gaps.
const GAPS = [1, 2, 4, 8, 16, 32, 64];
const srs = c => ({ ease: c.ease || 2.5, ivl: c.ivl ?? (c.box ? GAPS[Math.min(c.box, GAPS.length) - 1] : 0) });
// What each button would do to this card: new interval in days (0 = again today) and new ease.
function plan(c, g) {
  const { ease, ivl } = srs(c);
  if (!ivl) return { again: { ivl: 0, ease }, hard: { ivl: 1, ease }, good: { ivl: c.lapses ? 1 : 2, ease }, easy: { ivl: 4, ease: ease + .15 } }[g];
  const next = { again: 0, hard: ivl * 1.2, good: ivl * ease, easy: ivl * ease * 1.3 }[g];
  const e = Math.max(1.3, ease + { again: -.2, hard: -.15, good: 0, easy: .15 }[g]);
  return { ivl: g === "again" ? 0 : Math.min(3650, Math.max(ivl + (g === "hard" ? 0 : 1), Math.round(next))), ease: e };
}
const ivlText = d => !d ? "today" : d < 30 ? d + "d" : d < 365 ? Math.round(d / 30) + "mo" : (d / 365).toFixed(1).replace(".0", "") + "y";
function grade(c, g) {
  flashShown = false;
  const p = plan(c, g);
  if (g === "again" && srs(c).ivl) c.lapses = (c.lapses || 0) + 1;
  c.ease = Math.round(p.ease * 100) / 100; c.ivl = p.ivl; c.box = (c.box || 0) + 1;
  c.due = addDays(p.ivl); c.last = Date.now();
  if (c.kind === "word") { c.exI = (c.exI || 0) + 1; spellAdd(c) } // next time, show another sentence
  c.updated = Date.now();
  persist();
}

/* ---------- spelling round ---------- */
// After every 10 word cards you grade (or when today's cards run out), you spell those words: you hear the word, see its
// meaning and one of its sentences with the word blanked out, and type it. A wrong spelling shows the right one, you copy
// it, and the word comes back at the end of the round. A word you misspelled comes back tomorrow at the latest, even if you
// knew its meaning (its interval drops to 1 day; ease stays, since you did remember the meaning).
// Kept in memory only: reloading the page drops a half-done round.
const SPELL_EVERY = 10;
const spell = { batch: [], round: null, said: "" };
function spellAdd(c) { if (!spell.round && !spell.batch.includes(c.id)) spell.batch.push(c.id) }
const spellNorm = t => String(t || "").trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
// The form of the word in this sentence ("criticised" for "criticise"). markWord highlights it; the spelling round blanks it.
function spellForm(sentence, word) {
  const w = word.toLowerCase(), stem = w.length > 4 ? w.replace(/(e|y|ies|es|s)$/, "") : w;
  const m = sentence.match(new RegExp("\\b" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[a-z'’-]*", "i"));
  return m ? { at: m.index, form: m[0] } : null;
}
function spellStart() {
  const cards = spell.batch.map(id => st.cards.find(c => c.id === id)).filter(c => c && c.kind === "word");
  spell.batch = [];
  if (!cards.length) return false;
  spell.round = { queue: cards.map(c => c.id), total: cards.length, missed: [], wrong: null, done: false };
  return true;
}
function spellMiss(c) {
  c.spellMiss = (c.spellMiss || 0) + 1;
  if (c.due > addDays(1)) { c.due = addDays(1); c.ivl = Math.min(srs(c).ivl, 1) }
  c.updated = Date.now();
}
function spellEnd() { spell.round = null; spell.said = ""; flashShown = false; $("flash").dataset.spell = ""; renderFlash() }
function renderSpell() {
  const r = spell.round, f = $("flash"), btns = $("flashBtns");
  const mk = (t, cls, fn) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = t; b.onclick = fn; return b };
  ygClose();
  if (r.done || !r.queue.length) {
    r.done = true;
    $("dueLabel").textContent = "";
    const first = r.total - r.missed.length;
    const words = r.missed.map(id => st.cards.find(c => c.id === id)?.mine).filter(Boolean);
    const key = "end"; if (f.dataset.spell === key) return; f.dataset.spell = key;
    f.replaceChildren();
    const h = document.createElement("p"); h.className = "spell-score"; h.textContent = `${first} of ${r.total} right the first time`;
    const p = document.createElement("p"); p.className = "muted";
    p.textContent = words.length ? `${words.join(", ")} will come back by tomorrow so you can spell ${words.length > 1 ? "them" : "it"} again.` : "Every word spelled right.";
    f.append(h, p);
    btns.replaceChildren(mk(due().length ? "Keep reviewing" : "Done", "primary", spellEnd));
    return;
  }
  const c = st.cards.find(k => k.id === r.queue[0]);
  if (!c) { r.queue.shift(); renderSpell(); return }
  const left = r.queue.length;
  $("dueLabel").textContent = `Spelling · ${left} left`;
  // Don't rebuild while you're typing (a sync or save elsewhere re-renders the cards screen).
  const key = c.id + "|" + left + "|" + (r.wrong ? "w" : "");
  if (f.dataset.spell === key) return;
  f.dataset.spell = key;
  const exs = examples(c), ex = exs.length ? exs[(c.exI || 0) % exs.length] : null, hit = ex && spellForm(ex.s, c.mine);
  const answers = [spellNorm(c.mine)]; if (hit) answers.push(spellNorm(hit.form));
  f.replaceChildren();
  const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = r.wrong ? "Type it the right way to go on." : "Spell the word you hear.";
  const mean = document.createElement("div"); mean.className = "a spell-mean"; mean.textContent = c.natural.length > 90 ? c.natural.slice(0, 88) + "…" : c.natural;
  f.append(hint, mean);
  if (hit) {
    const s = document.createElement("blockquote"); s.className = "ex"; s.lang = "en";
    const gap = document.createElement("span"); gap.className = "gap"; gap.textContent = r.wrong ? hit.form : "_".repeat(Math.max(4, hit.form.length));
    gap.setAttribute("aria-label", r.wrong ? hit.form : "blank");
    s.append(ex.s.slice(0, hit.at), gap, ex.s.slice(hit.at + hit.form.length));
    f.append(s);
  }
  if (r.wrong) {
    const fix = document.createElement("div"); fix.className = "spell-fix";
    const mine = document.createElement("span"); mine.className = "q"; mine.lang = "en"; mine.textContent = r.wrong;
    const right = document.createElement("span"); right.className = "a"; right.lang = "en"; right.textContent = c.mine;
    fix.append(mine, right); f.append(fix);
  }
  const form = document.createElement("form"); form.className = "spell-form";
  const inp = document.createElement("input"); inp.type = "text"; inp.lang = "en"; inp.setAttribute("aria-label", "Type the word");
  Object.assign(inp, { autocomplete: "off", spellcheck: false, placeholder: hit && !r.wrong ? `${hit.form.length} letters` : "" });
  inp.setAttribute("autocapitalize", "off"); inp.setAttribute("autocorrect", "off");
  const hear = mk("▶ Hear it", "", () => { say(c.mine); inp.focus() }); hear.type = "button";
  form.append(inp, hear);
  form.onsubmit = e => {
    e.preventDefault();
    const v = spellNorm(inp.value); if (!v) return;
    if (answers.includes(v)) {
      if (r.wrong) { r.wrong = null; r.queue.push(r.queue.shift()) } // copied it right: try it once more at the end
      else r.queue.shift();
      f.dataset.spell = ""; renderSpell(); return;
    }
    if (r.wrong) { inp.value = ""; toast("Not quite. Copy the word in the highlight."); return }
    if (!r.missed.includes(c.id)) { r.missed.push(c.id); spellMiss(c); persist() }
    r.wrong = inp.value.trim(); f.dataset.spell = ""; renderSpell();
  };
  f.append(form);
  btns.replaceChildren(mk("Check", "primary", () => form.requestSubmit()), mk("Skip spelling", "", () => { r.queue = []; r.done = true; f.dataset.spell = ""; renderSpell() }));
  if (spell.said !== key && !r.wrong) { spell.said = key; say(c.mine) }
  setTimeout(() => inp.focus(), 0);
}

/* ---------- word cards: real sentences ---------- */
// A word card keeps up to 5 sentences from articles you read (`ex`: [{ s: sentence, src: "BBC" }]). Cards saved before this
// change have one sentence in `why` ("sentence — source"), which is read the same way.
const EX_MAX = 5;
function examples(c) {
  if (Array.isArray(c.ex) && c.ex.length) return c.ex;
  if (!c.why) return [];
  const m = c.why.match(/^(.*) — ([^—]{1,40})$/s);
  return [m ? { s: m[1], src: m[2] } : { s: c.why, src: "" }];
}
// Highlight the word (or a form of it, like "criticised" for "criticise") inside its sentence.
function markWord(el, sentence, word) {
  const m = spellForm(sentence, word);
  if (!m) { el.textContent = sentence; return }
  const b = document.createElement("mark"); b.textContent = m.form;
  el.replaceChildren(sentence.slice(0, m.at), b, sentence.slice(m.at + m.form.length));
}
function say(text) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = .95; speechSynthesis.speak(u) } catch { toast("This browser can't read aloud.") } }

/* ---------- real voices ---------- */
// Two ways to hear a real person say the word in one sentence:
// 1. "Real voice": sound only. Tatoeba (tatoeba.org) has sentences recorded by real people, shared under open licences;
//    we play one recording of one sentence that has the word, and show the sentence and who recorded it.
// 2. "Video clip": YouGlish's official embed plays a YouTube clip of someone saying the word. YouTube's rules don't allow
//    hiding its player, so the video stays visible, but it pauses as soon as the sentence with the word is over.
// Nothing is downloaded or stored; both load only when tapped.
// One audio element for all recordings. iPhone Safari only lets a page play sound that starts during a tap, and the
// recording arrives after the lookup, so the tap first plays a moment of silence on this element; after that it may play.
const voice = { card: null, list: [], i: 0, seq: 0, el: new Audio() };
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
function voiceUnlock() { try { voice.el.src = SILENCE; voice.el.play().catch(() => { }) } catch { } }
function voiceStop() { voice.seq++; try { voice.el.pause() } catch { } }
async function tatoeba(word) {
  const u = "https://api.tatoeba.org/v1/sentences?lang=eng&has_audio=yes&include=audios&sort=relevance&limit=50&q=" + encodeURIComponent(word);
  let d;
  try { const r = await fetch(u); if (!r.ok) throw 0; d = await r.json() }
  catch { const r = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(u)); if (!r.ok) throw new Error("net"); d = await r.json() }
  const out = [];
  for (const x of d.data || []) {
    const n = String(x.text || "").split(/\s+/).length, aus = (x.audios || []).filter(a => a.download_url || a.id);
    if (!aus.length || n < 5) continue;
    // Several addresses per sentence, tried in order: each recording's API file link (refused when the recorder doesn't
    // allow reuse outside Tatoeba), the download link the Tatoeba site uses, and the older audio server.
    const urls = [];
    for (const a of aus) { if (a.download_url) urls.push(a.download_url); if (a.id) urls.push(`https://tatoeba.org/audio/download/${a.id}`) }
    urls.push(`https://audio.tatoeba.org/sentences/eng/${x.id}.mp3`);
    const a = aus.find(a => a.licence) || aus[0];
    out.push({ s: x.text, urls, by: a.author || "", lic: a.licence || "", link: a.attribution_url || "https://tatoeba.org/en/sentences/show/" + x.id });
  }
  // Recordings with an open licence first (they can be played outside Tatoeba), then everyday-length sentences.
  return out.sort((p, q) => (!p.lic - !q.lic) || Math.abs(p.s.length - 70) - Math.abs(q.s.length - 70));
}
function voiceShow(c) {
  const box = $("ygBox"), v = voice.list[voice.i % voice.list.length];
  box.replaceChildren(); box.hidden = false;
  const s = document.createElement("p"); s.className = "ex voice"; s.lang = "en"; markWord(s, v.s, c.mine);
  const credit = document.createElement("p"); credit.className = "muted";
  const a = document.createElement("a"); a.href = v.link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Tatoeba";
  credit.append(`Recorded by ${v.by || "a Tatoeba member"}${v.lic ? " (" + v.lic + ")" : ""} · `, a);
  const row = document.createElement("div"); row.className = "row"; row.style.justifyContent = "center";
  const again = document.createElement("button"); again.className = "btn"; again.textContent = "Play again"; again.onclick = () => voicePlay(c);
  row.append(again);
  if (voice.list.length > 1) { const nx = document.createElement("button"); nx.className = "btn"; nx.textContent = `Another sentence (${voice.i % voice.list.length + 1}/${voice.list.length})`; nx.onclick = () => { voice.i++; voiceShow(c); voicePlay(c) }; row.append(nx) }
  box.append(s, row, credit);
}
// Try each address of this recording; if none plays, move on to the next sentence (once round the list at most).
// Try each address of this sentence (8 s each at most). A sentence none of them plays is dropped from the list, and the
// next one is tried, so a word only gives up when no sentence for it plays.
function voicePlay(c) {
  voiceStop();
  const v = voice.list[voice.i % voice.list.length]; if (!v) return;
  const seq = ++voice.seq; let k = 0, timer;
  const next = () => {
    clearTimeout(timer); if (seq !== voice.seq) return;
    if (k < v.urls.length) {
      voice.el.src = v.urls[k++];
      timer = setTimeout(next, 8000);
      voice.el.play().then(() => clearTimeout(timer), e => e && e.name === "NotAllowedError" ? (clearTimeout(timer), toast("Tap Play again to hear it.")) : next());
      return;
    }
    voice.list.splice(voice.i % voice.list.length, 1);
    if (c && voice.list.length) { voiceShow(c); voicePlay(c) }
    else { $("ygBox").innerHTML = '<p class="muted">None of the recordings for this word would play. Try Video clip.</p>' }
  };
  next();
}
async function voiceOpen(c) {
  ygClose(); voiceUnlock(); const box = $("ygBox"); box.hidden = false;
  if (voice.card === c.id && voice.list.length) { voiceShow(c); voicePlay(c); return }
  voice.card = c.id; voice.list = []; voice.i = 0;
  box.innerHTML = '<p class="muted">Finding a real recording…</p>';
  try { voice.list = await tatoeba(c.mine) } catch { if (voice.card === c.id) box.innerHTML = '<p class="muted">Couldn\'t reach Tatoeba. Check your connection, or try Video clip.</p>'; return }
  if (voice.card !== c.id) return;
  if (!voice.list.length) { box.innerHTML = '<p class="muted">No real recording with this word yet. Try Video clip.</p>'; return }
  voiceShow(c); voicePlay(c);
}

const yg = { ready: null, w: null, card: null, n: 0, heard: false };
function ygLoad() {
  if (yg.ready) return yg.ready;
  yg.ready = new Promise((ok, no) => {
    window.onYouglishAPIReady = ok;
    const t = document.createElement("script"); t.src = "https://youglish.com/public/emb/widget.js"; t.async = true;
    t.onerror = () => { yg.ready = null; no(new Error("load")) }; document.head.append(t);
  });
  return yg.ready;
}
function ygClose() { voiceStop(); const box = $("ygBox"); try { yg.w?.close?.() } catch { } yg.w = null; yg.card = null; box.replaceChildren(); box.hidden = true }
async function ygOpen(c) {
  const box = $("ygBox"), id = "yg" + ++yg.n;
  ygClose(); yg.card = c.id; yg.heard = false; box.hidden = false;
  const note = document.createElement("p"); note.className = "muted"; note.textContent = "Loading a clip…";
  const el = document.createElement("div"); el.id = id; el.className = "yg-frame";
  box.append(note, el);
  try { await ygLoad() } catch { note.textContent = "Couldn't reach YouGlish. Check your connection and try again."; return }
  if (yg.card !== c.id) return;
  // components: caption 8 + control buttons 64 (no search box, title or speed panel). Captions mark the word as [[[word]]]:
  // once a caption with the word has been shown and the next caption doesn't have it, the sentence is over, so pause.
  // Colours from the site's own tokens (so dark mode matches too); captions at body size instead of YouGlish's 40px.
  const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  yg.w = new YG.Widget(id, { components: 72, autoStart: 1, restrictionMode: 1, captionSize: 18,
    backgroundColor: tok("--surface"), panelsBackgroundColor: tok("--surface"), textColor: tok("--ink-muted"), titleColor: tok("--ink"),
    captionColor: tok("--ink"), keywordColor: tok("--accent-text"), queryColor: tok("--accent-text"), markerColor: tok("--tint-yellow"), linkColor: tok("--ink"),
    events: {
    onFetchDone: e => { note.textContent = e.totalResult ? "Stops after the sentence. Use the arrows for another speaker." : "No clips for this word." },
    onVideoChange: () => { yg.heard = false },
    onCaptionChange: e => { const has = String(e.caption || "").includes("[[["); if (has) yg.heard = true; else if (yg.heard) { yg.heard = false; try { yg.w.pause() } catch { } } } } });
  yg.w.fetch(c.mine, "english", "us");
}

/* ---------- review screen ---------- */
// Due cards, least recently seen first, so a card you just pressed Again on comes back after the others.
const due = () => st.cards.filter(c => c.due <= today()).sort((a, b) => (a.last || 0) - (b.last || 0));
let flashShown = false;
function renderFlash() {
  const list = due(), f = $("flash"), btns = $("flashBtns");
  if (!spell.round && !flashShown && (spell.batch.length >= SPELL_EVERY || (spell.batch.length && !list.length))) spellStart();
  if (spell.round) { renderSpell(); return }
  f.dataset.spell = "";
  const toSpell = SPELL_EVERY - spell.batch.length;
  $("dueLabel").textContent = list.length ? `${list.length} left` + (spell.batch.length ? ` · spelling in ${toSpell}` : "") : "";
  if (!list.length) { ygClose(); f.innerHTML = st.cards.length ? '<p class="muted">All done for today.</p>' : '<p class="muted">No cards yet. Tap a word while reading the news and add it to your word list, or tap Save as card after a speaking or writing review.</p>'; btns.replaceChildren(); return }
  const c = list[0], word = c.kind === "word";
  if ((yg.card && yg.card !== c.id) || (voice.card && voice.card !== c.id && !$("ygBox").hidden)) ygClose();
  f.replaceChildren();
  const mk = (t, cls, fn, label) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = t; b.onclick = fn; if (label) b.setAttribute("aria-label", label); return b };
  if (word) {
    const exs = examples(c), ex = exs.length ? exs[(c.exI || 0) % exs.length] : null;
    const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = ex ? "What does it mean in this sentence?" : "What does this word mean?";
    const q = document.createElement("div"); q.className = "q word"; q.lang = "en"; q.textContent = c.mine;
    f.append(hint, q);
    if (ex) {
      const s = document.createElement("blockquote"); s.className = "ex"; s.lang = "en"; markWord(s, ex.s, c.mine);
      const meta = document.createElement("div"); meta.className = "ex-src";
      meta.append((ex.src ? "— " + ex.src : "— from your reading") + (exs.length > 1 ? ` · sentence ${(c.exI || 0) % exs.length + 1} of ${exs.length}` : ""));
      meta.append(mk("Play", "say", () => say(ex.s), "Read this sentence aloud with the computer voice"));
      f.append(s, meta);
    }
    const real = document.createElement("div"); real.className = "row"; real.style.justifyContent = "center";
    real.append(mk("Real voice", "", () => voiceOpen(c), "Hear a real person say one sentence with this word, sound only"),
      mk("Video clip", "", () => ygOpen(c), "Watch one sentence from a YouTube clip with this word"));
    f.append(real);
    if (flashShown) { const a = document.createElement("div"); a.className = "a"; a.textContent = c.natural; f.append(a) }
  } else {
    const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = "This is what you said. What's the natural way to say it?";
    const q = document.createElement("div"); q.className = "q"; q.lang = "en"; q.textContent = c.mine;
    f.append(hint, q);
    if (flashShown) { const a = document.createElement("div"); a.className = "a"; a.lang = "en"; a.textContent = c.natural; const w = document.createElement("p"); w.className = "muted"; w.textContent = c.why; f.append(a, w) }
  }
  const G = [["again", "Again", "red"], ["hard", "Hard", ""], ["good", "Good", "accent"], ["easy", "Easy", ""]];
  btns.replaceChildren(...(flashShown
    ? G.map(([g, t, cls]) => { const b = mk("", "grade " + cls, () => grade(c, g)); const n = document.createElement("small"); n.textContent = ivlText(plan(c, g).ivl); b.append(t, n); return b })
    : [mk("Show answer", "primary", () => { flashShown = true; renderFlash() })]));
}
function renderList() {
  const box = $("cardList");
  const n = due().length; $("dueCount").textContent = n ? n : "";
  if (!st.cards.length) { box.innerHTML = '<p class="muted">No cards yet.</p>'; return }
  box.replaceChildren(...[...st.cards].sort((a, b) => (b.created || "").localeCompare(a.created || "")).map(c => {
    const el = document.createElement("div"); el.className = "c-item";
    const d = document.createElement("div");
    const a = document.createElement("div"); a.className = "c-mine"; a.textContent = c.mine;
    const b = document.createElement("div"); b.className = "c-nat"; b.textContent = c.natural;
    d.append(a, b);
    if (c.kind === "word") {
      a.className = "c-word"; b.className = "c-why";
      const exs = examples(c);
      if (exs.length) { const s = document.createElement("div"); s.className = "c-ex"; s.lang = "en"; markWord(s, exs[0].s, c.mine); d.append(s) }
    }
    const { ivl } = srs(c), exN = c.kind === "word" ? examples(c).length : 0;
    const w = document.createElement("div"); w.className = "c-why";
    w.textContent = ({ write: "Write · ", read: "Word list · " }[c.source] || "Speak · ") + (exN > 1 ? exN + " sentences · " : "") + "next review " + c.due + (ivl ? ` (every ${ivlText(ivl)})` : "");
    d.append(w);
    const x = document.createElement("button"); x.className = "del"; x.textContent = "Delete"; x.setAttribute("aria-label", "Delete this card");
    x.onclick = () => { if (x.dataset.armed) { st.cards = st.cards.filter(k => k.id !== c.id); st.deleted[c.id] = Date.now(); persist() } else { x.dataset.armed = 1; x.textContent = "Delete for sure?"; setTimeout(() => { delete x.dataset.armed; x.textContent = "Delete" }, 3000) } };
    el.append(d, x); return el }));
}
// Anki CSV: Front, Back, Tags. The header lines tell Anki (2.1.55 or later) the separator, that fields are HTML, and which column holds tags.
// Word cards: the word and its real sentence on the front, the meaning and where the sentence came from on the back.
$("exportAnki").onclick = () => {
  if (!st.cards.length) { toast("There are no cards to export yet."); return }
  const q = s => '"' + String(s || "").replace(/"/g, '""') + '"';
  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bold = (s, w) => { const t = document.createElement("div"); markWord(t, s, w); return [...t.childNodes].map(n => n.nodeName === "MARK" ? "<b>" + esc(n.textContent) + "</b>" : esc(n.textContent)).join("") };
  const rows = st.cards.map(c => {
    if (c.kind !== "word") return [q(esc(c.mine)), q(esc(c.natural) + (c.why ? "<br><small>" + esc(c.why) + "</small>" : "")), q("english-desk " + (c.source || "speak"))].join(",");
    const exs = examples(c);
    const front = "<b>" + esc(c.mine) + "</b>" + exs.map(e => "<br><br><i>" + bold(e.s, c.mine) + "</i>").join("");
    const back = esc(c.natural) + (exs.some(e => e.src) ? "<br><small>" + [...new Set(exs.map(e => e.src).filter(Boolean))].map(esc).join(" · ") + "</small>" : "");
    return [q(front), q(back), q("english-desk word")].join(",");
  });
  download("english-desk-anki.csv", "﻿#separator:Comma\n#html:true\n#tags column:3\n" + rows.join("\n"), "text/csv");
  toast("Downloaded. In Anki, choose File > Import.");
};

/* ---------- settings + backup ---------- */
// Keys: one line per provider. Features: each picks a provider that can do it; null means "auto" (best one with a key).
const DEF = { geminiModel: "gemini-3.5-flash-lite", liveModel: LIVE_DEFAULT, claudeGrade: "claude-opus-5-5" };
const NAME = { gemini: "Gemini", claude: "Claude", azure: "Azure" };
const KEYS = { gemini: ["geminiKey"], claude: ["claudeKey"], azure: ["azureKey", "azureRegion"] };
const FEATURES = { useLive: { opts: ["gemini"] }, useGrade: { opts: ["gemini", "claude"], key: "grade" }, useTrans: { opts: ["gemini"] }, usePron: { opts: ["azure", "gemini"], key: "pron" }, useBrief: { opts: ["gemini", "claude"], key: "brief" }, useSpeed: { opts: ["gemini", "claude"], key: "speed" } };
// Settings that sync across devices (never the keys). `changed` marks a user edit to one of them, so the newest edit wins on every device.
const SYNC_CFG = ["use", "geminiModel", "liveModel", "claudeGrade"];
function storeCfg(changed) {
  if (changed) cfg.updated = Date.now();
  try { localStorage.setItem(CFG, JSON.stringify(cfg)) } catch { toast("The browser refused to save your settings."); return false }
  if (changed) saveHooks.forEach(f => f());
  return true;
}
function renderKeys() {
  for (const p of Object.keys(KEYS)) {
    const P = NAME[p], tag = $("st" + P), has = keyFor(p), open = !$("k" + P).hidden;
    tag.textContent = !has ? "Not set" : cfg.keyOk[p] ? "✓ Working" : "Added, not tested";
    tag.className = "tag" + (!has ? " no" : cfg.keyOk[p] ? " ok" : "");
    const b = document.querySelector(`[data-open="k${P}"]`); b.textContent = open ? "Close" : has ? "Edit" : "Add"; b.setAttribute("aria-expanded", open);
  }
}
function renderUse() {
  for (const [id, f] of Object.entries(FEATURES)) {
    const cur = f.key ? use(f.key) : "gemini";
    $(id).replaceChildren(...f.opts.map(p => { const b = document.createElement("button"); b.className = "chip"; b.textContent = NAME[p];
      b.disabled = !keyFor(p); if (b.disabled) b.title = "Add a " + NAME[p] + " key first";
      b.setAttribute("aria-pressed", keyFor(p) && p === cur ? "true" : "false");
      if (f.key && f.opts.length > 1) b.onclick = () => { cfg.use[f.key] = p; storeCfg(true); renderUse(); toast(`${{ grade: "Grading and feedback", pron: "Pronunciation", brief: "News brief", speed: "Reading speed" }[f.key]} now uses ${NAME[p]}`) };
      return b }));
  }
  $("advSum").textContent = "Advanced: model names (grading uses " + (use("grade") === "claude" ? cfg.claudeGrade : cfg.geminiModel) + ")";
}
function renderSettings() {
  for (const f of ["geminiKey", "claudeKey", "azureKey", "azureRegion", "geminiModel", "liveModel", "claudeGrade"]) $(f).value = cfg[f] || "";
  if (!anyTextKey()) $("kGemini").hidden = false;
  renderKeys(); renderUse();
}
// Re-read one provider's inputs; a changed key needs a fresh test.
function takeKey(p) {
  let changed = false;
  for (const f of KEYS[p]) { let v = $(f).value.trim(); if (f === "azureRegion") v = v.toLowerCase().replace(/\s+/g, ""); if (v !== (cfg[f] || "")) { cfg[f] = v; changed = true } }
  if (changed) cfg.keyOk[p] = false;
}
document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { const el = $(b.dataset.open); el.hidden = !el.hidden; renderKeys(); if (!el.hidden) el.querySelector("input").focus() });
async function testKey(p) {
  switch (p) {
    case "gemini": await gemini("Reply with exactly: OK", [{ text: "Say OK." }]); break;
    case "claude": await claude("Reply with exactly: OK", [{ role: "user", content: "Say OK." }], { max: 2000 }); break;
    case "azure": if (!cfg.azureKey || !cfg.azureRegion) throw new Error("Fill in both the key and the region.");
      await azureAssess(wav16k(new Float32Array(16000), 16000), "Hello.", undefined); break; // one second of silence: a good key answers 200
  }
}
document.querySelectorAll("[data-test]").forEach(b => b.onclick = async () => {
  const p = b.dataset.test, out = $("out" + NAME[p]);
  takeKey(p);
  if (!keyFor(p)) { cfg.keyOk[p] = false; storeCfg(); renderKeys(); renderUse(); out.textContent = "Cleared."; return }
  b.disabled = true; out.textContent = "Testing…";
  try { await testKey(p); cfg.keyOk[p] = true; out.textContent = ""; $("k" + NAME[p]).hidden = true; toast(NAME[p] + " is working") }
  catch (e) { cfg.keyOk[p] = false; out.textContent = errText(e) }
  finally { b.disabled = false; storeCfg(); renderKeys(); renderUse(); afterSettings() }
});
$("saveModels").onclick = () => {
  for (const f of Object.keys(DEF)) cfg[f] = $(f).value.trim() || DEF[f];
  if (storeCfg(true)) { renderSettings(); toast("Saved") }
};
function afterSettings() { liveAvailability(); if (anyTextKey()) banner(""); if (!$("echoPlayer").hidden) renderScore() }
$("exportBackup").onclick = async () => {
  const practice = await EDPractice.all().catch(() => []);
  download(`english-desk-backup-${today()}.json`, JSON.stringify({ app: "english-desk", version: 2, exported: new Date().toISOString(), cards: st.cards, logs: st.logs, deleted: st.deleted, practice }, null, 2), "application/json");
  toast("Backup exported (API keys not included)");
};
$("importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.cards) || !Array.isArray(d.logs)) throw 0;
    const before = new Map(st.cards.map(c => [c.id, c])), logsBefore = new Set(st.logs.map(l => l.ts));
    const m = mergeData(st, d), after = new Set(m.cards.map(c => c.id));
    const added = m.cards.filter(c => !before.has(c.id)).length, changed = m.cards.filter(c => before.has(c.id) && before.get(c.id) !== c).length;
    const removed = [...before.keys()].filter(id => !after.has(id)).length, sessions = m.logs.filter(l => !logsBefore.has(l.ts)).length;
    Object.assign(st, m);
    if (Array.isArray(d.practice)) await mergePractice(d.practice);
    persist(); backupInfo(); renderRedo();
    const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    toast(added || changed || removed || sessions ? `Imported: ${n(added, "new card")}, ${n(changed, "card")} updated, ${n(removed, "card")} removed, ${n(sessions, "new session")}` : "Nothing new in this backup");
  } catch { toast("This isn't an English Desk backup file.") }
};
// Full sessions from a backup or another device: keep the newer copy of each, and drop the ones deleted anywhere.
async function mergePractice(incoming) {
  const have = new Map((await EDPractice.all()).map(r => [r.ts, r])), put = [];
  for (const r of incoming) if (r && r.ts && !st.deleted["log:" + r.ts] && (!have.has(r.ts) || EDPractice.newer(r, have.get(r.ts)))) { put.push(r); have.set(r.ts, r) }
  if (put.length) await EDPractice.putMany(put);
  for (const ts of [...have.keys()]) if (st.deleted["log:" + ts]) { await EDPractice.del(ts); have.delete(ts) }
  return [...have.values()];
}
function backupInfo() { $("backupInfo").textContent = `${st.cards.length} cards and ${st.logs.length} sessions saved` }

/* ---------- word book (used by reader.js) ---------- */
// A saved word is a card with kind "word": front = the word, back = definition, note = the sentence it came from.
window.EnglishDesk = {
  // For sync.js: run after every save; merge what came from the gist into this browser and return everything that should be up there.
  onSave: f => saveHooks.push(f), onChange: f => changeHooks.push(f),
  syncApply(remote) {
    if (remote) {
      Object.assign(st, mergeData(st, remote)); persist(true); backupInfo(); renderToday(); renderRedo();
      const rs = remote.settings;
      if (rs && (rs.updated || 0) > (cfg.updated || 0)) {
        for (const f of SYNC_CFG) if (rs[f] !== undefined) cfg[f] = f === "use" ? { ...cfg.use, ...rs.use } : rs[f];
        cfg.updated = rs.updated; storeCfg(); renderSettings();
      }
    }
    const settings = { updated: cfg.updated || 0 }; for (const f of SYNC_CFG) settings[f] = cfg[f];
    return { cards: st.cards, logs: st.logs, deleted: st.deleted, settings };
  },
  toast,
  // For sync.js: merge sessions from the gist's monthly files into this browser; returns every session kept here.
  practiceMerge: async incoming => { const all = await mergePractice(incoming); if (typeof EDHistory !== "undefined") EDHistory.refresh(); return all },
  // For history.js.
  logs: () => st.logs, renderCorr, saveAll, startRedo, cefrDiff, deleteSession, attachArticle, hasSync: () => { try { return !!JSON.parse(localStorage.getItem("englishDesk.sync") || "{}").token } catch { return false } },
  // For brief.js: the AI picked for "News brief" and its display name.
  ai: (s, t, o = {}) => ai(s, t, { ...o, feature: "brief" }), hasKey: () => hasKey("brief"), aiName: () => NAME[use("brief")],
  // For reader.js: timed reads are logs of type "read"; their quiz and AI verdict are patched in afterwards.
  speedAi: (s, t, o = {}) => ai(s, t, { ...o, feature: "speed" }), speedHasKey: () => hasKey("speed"), speedAiName: () => NAME[use("speed")],
  addLog: l => addLog(l),
  patchLog(ts, patch) { const l = st.logs.find(x => x.ts === ts); if (!l) return; Object.assign(l, patch, { updated: Date.now() }); persist() },
  logs: type => st.logs.filter(l => l.type === type),
  markChicklist(link) { chickSaved[link] = true; for (const el of document.querySelectorAll("#newsList .news-item")) if (el.dataset.link === link) markChick(el.querySelector("h3")) },
  words: () => st.cards.filter(c => c.kind === "word").map(c => c.mine),
  // Returns "new" for a new card, "more" when the word was saved before and this sentence was added to it, or false.
  addWord({ word, def, sentence, source }) {
    const have = st.cards.find(c => c.kind === "word" && c.mine.toLowerCase() === word);
    const ex = sentence ? { s: String(sentence), src: String(source || "") } : null;
    if (have) {
      const exs = examples(have);
      if (!ex || exs.some(e => e.s === ex.s) || exs.length >= EX_MAX) return false;
      have.ex = [...exs, ex]; have.updated = Date.now(); persist(); return "more";
    }
    st.cards.push({ id: uid(), kind: "word", mine: word, natural: def || "(No definition. Try to recall it when you review.)", why: sentence ? sentence + (source ? " — " + source : "") : "", ex: ex ? [ex] : [], source: "read", created: today(), due: today(), box: 0, updated: Date.now() });
    persist(); return "new";
  },
};

/* ---------- boot ---------- */
load(); renderSettings(); loadNews(); loadPodcasts(); renderToday(); renderLogs(); renderList(); backupInfo(); renderRedo();
try { $("essay").value = localStorage.getItem("englishDesk.draft") || "" } catch { }
wc(); setSpeakMode("live"); route();

/* ---------- install + offline ---------- */
// The service worker lets the site open offline. Asking for persistent storage stops the browser from clearing cards on its own;
// on iPhone, Safari only exempts sites added to the Home Screen from its 7-day clean-up.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => { });
(async () => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let kept = false;
  try { kept = await navigator.storage.persisted() || await navigator.storage.persist() } catch { }
  const info = $("storageInfo");
  info.textContent = ios && !installed ? "On iPhone, Safari can clear this site's data after 7 days without a visit. Tap Share, then Add to Home Screen, and open English Desk from there to keep your cards."
    : kept || installed ? "Saved for good on this device: the browser won't clear your cards on its own. It also works offline."
    : "This browser may clear site data when the device is low on space. Export a backup now and then.";
  info.hidden = false;
})();
if (!anyTextKey()) banner("First time here? Add an API key to get started.", true);
})();
