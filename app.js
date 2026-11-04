(() => {
const $ = id => document.getElementById(id);
const STORE = "englishDesk.v1", CFG = "englishDesk.cfg";
const st = { cards: [], logs: [], speakMode: "live", inline: false, topic: "", ctl: null, speakItems: [], writeItems: [], writeLevel: "", writeTopic: "" };
let cfg = { provider: "gemini", geminiKey: "", geminiModel: "gemini-3.5-flash-lite", liveModel: "gemini-3.8-live", claudeKey: "", claudeChat: "claude-haiku-5-5", claudeGrade: "claude-sonnet-5-5", azureKey: "", azureRegion: "" };

const today = () => new Date().toLocaleDateString("sv-SE");
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE") };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let toastT;
function toast(msg) { let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t) } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600) }
function banner(msg, link) { const b = $("banner"); b.replaceChildren(msg); if (link) { const a = document.createElement("a"); a.href = "#settings"; a.textContent = " 前往設定"; b.append(a) } b.hidden = !msg }

/* ---------- storage ---------- */
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE) || "{}"); st.cards = d.cards || []; st.logs = d.logs || [] } catch { }
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(CFG) || "{}") } } catch { }
}
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({ cards: st.cards, logs: st.logs })) }
  catch { toast("瀏覽器拒絕儲存，請先匯出備份") }
  renderList(); renderLogs(); if (!$("v-cards").hidden) renderFlash();
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- AI ---------- */
function hasKey() { return cfg.provider === "claude" ? !!cfg.claudeKey : !!cfg.geminiKey }
class AiError extends Error { constructor(msg, code) { super(msg); this.code = code } }
async function callApi(url, headers, body, signal) {
  let res;
  try { res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) }
  catch (e) { if (e.name === "AbortError") throw new AiError("", "cancelled"); throw new AiError("連不上 AI 服務，檢查網路後再試。", "network") }
  let data = {}; try { data = await res.json() } catch { }
  if (!res.ok) {
    const m = data?.error?.message || "";
    if (res.status === 401 || res.status === 403 || /API key/i.test(m)) throw new AiError("API key 無效，請到設定檢查。", "auth");
    if (res.status === 429) throw new AiError("用量到上限或太頻繁了，等一下再試。", "rate");
    if (res.status === 413 || /too large|payload size/i.test(m)) throw new AiError("音檔太大了，選短一點的片段再試。", "size");
    if (res.status === 404 || /model/i.test(m)) throw new AiError("找不到這個模型名稱，請到設定檢查。", "model");
    throw new AiError("AI 回了錯誤：" + (m || res.status), "upstream");
  }
  return data;
}
function finish(text, json) {
  if (!text.trim()) throw new AiError("AI 沒有回覆內容，再試一次。", "empty");
  return json ? parseJson(text) : text.trim();
}
async function ai(system, turns, { json = false, heavy = false, signal } = {}) {
  if (!hasKey()) throw new AiError("還沒有設定 API key。", "nokey");
  if (cfg.provider !== "claude") return gemini(system, null, { json, signal, turns });
  const data = await callApi("https://api.anthropic.com/v1/messages",
    { "x-api-key": cfg.claudeKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    { model: heavy ? cfg.claudeGrade : cfg.claudeChat, max_tokens: heavy ? 3000 : 600, system, messages: turns }, signal);
  return finish((data.content || []).filter(b => b.type === "text").map(b => b.text).join(""), json);
}
// Gemini directly, whatever provider is picked: audio (shadowing) only works here. `parts` may hold inlineData audio.
async function gemini(system, parts, { json = false, signal, turns } = {}) {
  if (!cfg.geminiKey) throw new AiError("這裡要用 Gemini，先到設定填 Gemini API key。", "nokey");
  const contents = turns ? turns.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })) : [{ role: "user", parts }];
  const data = await callApi(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, { "x-goog-api-key": cfg.geminiKey },
    { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: json ? { responseMimeType: "application/json" } : {} }, signal);
  return finish((data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join(""), json);
}
function parseJson(text) {
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const t of tries) { if (!t) continue; try { return JSON.parse(t) } catch { } }
  throw new AiError("AI 回的格式跑掉了，再按一次試試。", "json");
}
const errText = e => e?.message || "出了點問題，再試一次。";

/* ---------- routing ---------- */
const VIEWS = ["today", "speak", "write", "echo", "cards", "settings"];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  VIEWS.forEach(x => { $("v-" + x).hidden = x !== v });
  document.querySelectorAll("nav a").forEach(a => a.dataset.v === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "cards") renderFlash();
  if (v !== "echo" && typeof echoLeave === "function") echoLeave();
}
addEventListener("hashchange", route);

/* ---------- schedule ---------- */
const PLAN = [
  { d: "日", t: "卡片總複習", go: "cards", long: "把這週存的卡片全部複習一遍" },
  { d: "一", t: "口說", go: "speak", long: "和 AI 聊 10 分鐘，再檢討 5 個重點" },
  { d: "二", t: "寫作", go: "write", long: "寫一段 150–200 字，批改後自己重寫" },
  { d: "三", t: "口說", go: "speak", long: "和 AI 聊 10 分鐘，再檢討 5 個重點" },
  { d: "四", t: "寫作", go: "write", long: "寫一段 150–200 字，批改後自己重寫" },
  { d: "五", t: "口說", go: "speak", long: "和 AI 聊 10 分鐘，再檢討 5 個重點" },
  { d: "六", t: "跟讀", go: "echo", long: "跟讀一段 podcast：逐句聽、按住跟著說，再和原音比對" },
];
const KIND = { speak: "speak", write: "write", echo: "echo", cards: "cards" };
function weekDates() { const d = new Date(), off = (d.getDay() + 6) % 7; return [0, 1, 2, 3, 4, 5, 6].map(i => { const x = new Date(d); x.setDate(d.getDate() - off + i); return x.toLocaleDateString("sv-SE") }) }
function renderToday() {
  const n = new Date().getDay(), p = PLAN[n];
  $("todayLabel").textContent = "今天 · 週" + p.d;
  $("todayTask").textContent = p.long;
  const go = $("todayGo");
  go.href = "#" + p.go; go.textContent = "開始"; $("todayEnjoy").hidden = p.go !== "echo";
  renderWeek();
}
function renderWeek() {
  const n = new Date().getDay(), dates = weekDates();
  const counts = dates.map(d => st.logs.filter(l => l.date === d).length);
  $("week").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((i, k) => { const el = document.createElement("div");
    el.className = "day" + (i === n ? " today" : ""); el.dataset.s = KIND[PLAN[i].go];
    el.innerHTML = `<b>${PLAN[i].d}</b><span>${PLAN[i].t === "卡片總複習" ? "複習" : PLAN[i].t}</span>` + (counts[k] ? '<span class="tick">✓ 已練</span>' : "");
    return el }));
  $("weekDone").textContent = counts.filter(Boolean).length;
  const max = Math.max(1, ...counts);
  $("bars").replaceChildren(...counts.map((c, k) => { const el = document.createElement("div");
    el.innerHTML = (c ? `<span class="n">${c}</span>` : "") + `<i class="${c ? "" : "zero"}" style="height:${c ? Math.round(c / max * 64) + 8 : 8}px"></i><span>${"一二三四五六日"[k]}</span>`;
    return el }));
}
function renderLogs() {
  const box = $("logs");
  if ($("bars")) renderWeek();
  if (!st.logs.length) return;
  box.replaceChildren(...[...st.logs].sort((a, b) => b.ts - a.ts).slice(0, 12).map(l => { const el = document.createElement("div");
    const t = document.createElement("time"); t.textContent = l.date;
    const lv = document.createElement("span"); lv.className = "level"; lv.textContent = l.level || (l.score != null ? l.score + "分" : "—");
    const s = document.createElement("span"); s.textContent = ({ write: "寫作 · ", echo: "跟讀 · " }[l.type] || "口說 · ") + (l.topic || "");
    el.append(t, lv, s); return el }));
}
function addLog(l) { st.logs.push({ ...l, date: today(), ts: Date.now() }); if (st.logs.length > 500) st.logs.splice(0, st.logs.length - 500); persist(); if (st.redo) renderRedo() }

/* ---------- news + topics ---------- */
// news.json is refreshed daily by .github/workflows/news.yml (BBC + CNN, or NPR when CNN is down).
const SECTION = { business: "財經", tech: "科技", world: "國際" };
const TOPICS = ["What I did this week", "A book I'm reading", "A project I'm working on", "Something I want to buy", "A place I'd like to visit"].map(title => ({ title }));
const WTOPICS = ["介紹最近讀的一本書", "描述一個正在做的專案", "說明一個你常用的工具", "婉拒一個邀請的 email", "你理想中的週末"].map(title => ({ title }));
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
  if (it.link) { const a = document.createElement("a"); a.href = it.link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "讀原文（" + it.source + "）"; f.append(a) }
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
function renderNews(news) {
  const box = $("newsList");
  if (!news) { box.innerHTML = '<p class="muted">今天的新聞還沒抓到，口說和寫作先用預設題目。</p>'; return }
  const d = new Date(news.updated);
  $("newsMeta").textContent = (news.sources || []).join(" + ") + " · " + (d.getMonth() + 1) + "/" + d.getDate() + " 更新";
  box.replaceChildren(...news.mixed.slice(0, SHOW).map(it => { const el = document.createElement("div"); el.className = "news-item";
    const h = document.createElement("h3"); h.textContent = it.source + " · " + (SECTION[it.section] || it.section);
    const a = document.createElement("a"); a.href = it.link; a.target = "_blank"; a.rel = "noopener"; a.lang = "en"; a.textContent = it.title;
    const p = document.createElement("p"); p.className = "muted"; p.lang = "en"; p.textContent = it.summary || "";
    const row = document.createElement("div"); row.className = "row";
    for (const [kind, label] of [["speak", "拿來口說"], ["write", "拿來寫作"]]) { const b = document.createElement("button"); b.className = "btn c-save"; b.textContent = label; b.onclick = () => useNews(kind, it); row.append(b) }
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
  const why = cfg.provider !== "gemini" ? "語音對話只支援 Gemini。到設定切換成 Gemini，或改用貼稿評分。"
    : !cfg.geminiKey ? "先到設定填 Gemini API key。"
    : !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket && (window.AudioContext || window.webkitAudioContext)) ? "這個瀏覽器不支援麥克風錄音，改用貼稿評分。" : "";
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
  $("liveStart").disabled = true; $("liveHint").textContent = "準備麥克風…";
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
  // Create and resume the AudioContext inside the tap: iOS Safari only allows audio after a user gesture.
  const AC = window.AudioContext || window.webkitAudioContext;
  live.ctx = new AC(); try { await live.ctx.resume() } catch { }
  try {
    live.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    liveCleanup();
    const msg = e && e.name === "NotAllowedError" ? "麥克風被拒絕了。到瀏覽器（iPhone 是「設定 > Safari > 麥克風」）允許這個網站使用麥克風再試。" : "打不開麥克風，檢查有沒有別的 App 正在用。";
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

  live.turns = []; live.ended = false; live.ready = false; live.muted = false; $("liveMute").textContent = "暫停麥克風";
  $("log").replaceChildren(); $("liveBox").hidden = false; $("reviewBox").hidden = true; $("liveHint").textContent = "題目：" + st.topic.title;
  liveStatus("連線中…"); $("liveTime").textContent = "0:00"; $("liveBox").scrollIntoView({ behavior: "smooth", block: "start" });

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
      live.ready = true; live.t0 = Date.now(); liveStatus("● 正在聽");
      live.timer = setInterval(() => { const s = Math.floor((Date.now() - live.t0) / 1000); $("liveTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); if (s >= LIVE_MAX) { toast("聊滿 14 分鐘了，幫你結束並檢討"); liveEnd() } }, 1000);
      ws.send(JSON.stringify({ realtimeInput: { text: "Start now: greet me briefly and ask your first question about the topic." } }));
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) stopPlayback();
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) playPcm(p.inlineData.data);
      if (sc.inputTranscription?.text) addText("me", sc.inputTranscription.text);
      if (sc.outputTranscription?.text) addText("ai", sc.outputTranscription.text);
    }
    if (m.goAway) { toast("Gemini 要結束這段連線了，幫你先檢討"); liveEnd() }
  };
  ws.onerror = () => { };
  ws.onclose = e => {
    if (live.ended) return;
    const r = e.reason || "";
    const msg = /API key|permission|unauth/i.test(r) || e.code === 1008 && !live.ready ? "API key 無效或沒有 Live API 權限，請到設定檢查。"
      : /model|not found|not supported/i.test(r) ? "找不到語音模型「" + (cfg.liveModel || LIVE_DEFAULT) + "」，請到設定檢查。"
      : /quota|exhaust|rate/i.test(r) ? "用量到上限了，等一下再試。"
      : !live.ready ? "連不上 Gemini Live" + (r ? "：" + r : "，檢查網路後再試。") : "連線中斷了" + (r ? "：" + r : "") + "。";
    toast(msg); if (!live.ready && /key|模型/.test(msg)) banner(msg, true);
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
  liveCleanup(); liveStatus("已結束");
  const transcript = live.turns.map(t => (t.role === "me" ? "ME: " : "PARTNER: ") + t.text.trim()).filter(l => l.length > 4).join("\n");
  if (live.turns.filter(t => t.role === "me").length < 2) { toast("說不到兩句，這次先不檢討"); return }
  review(transcript, $("liveEnd"), "結束並檢討");
}
$("liveStart").onclick = liveStartFn;
$("liveEnd").onclick = () => { if (live.ws) liveEnd() };
$("liveMute").onclick = () => { live.muted = !live.muted; $("liveMute").textContent = live.muted ? "繼續說" : "暫停麥克風"; liveStatus(live.muted ? "麥克風已暫停" : "● 正在聽") };
addEventListener("pagehide", () => { if (live.ws) { live.ended = true; liveCleanup() } });

/* paste mode */
$("copyOpening").onclick = async () => {
  const t = currentTopic("speak"), text = opening(t, false);
  try { await navigator.clipboard.writeText(text); toast("已複製，開始聊之前貼給對方") }
  catch { $("pasteIn").value = text; $("pasteIn").select(); toast("沒辦法自動複製，已放進下面的框，手動複製後清掉") }
};
$("pasteIn").addEventListener("input", () => { const n = ($("pasteIn").value.match(/[A-Za-z’']+/g) || []).length; $("pasteCount").textContent = n ? n + " 字" : "" });
$("pasteGrade").onclick = () => {
  const text = $("pasteIn").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 40) { toast("逐字稿太短了，至少要有幾來回的對話"); return }
  if (!hasKey()) { banner("先填好 API key 才能評分。", true); return }
  st.topic = currentTopic("speak");
  review(text, $("pasteGrade"), "請 AI 評分", true);
};
$("stopPaste").onclick = () => st.ctl?.abort();

/* review: CEFR level + 5 corrections, shared by both modes */
async function review(transcript, btn, label, pasted) {
  btn.disabled = true; btn.textContent = "整理中…";
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
{"level":"B2","summary":"一兩句繁體中文的整體評語，說明這個等級的依據","items":[{"mine":"my original phrase","natural":"the natural version","why":"一行繁體中文說明"}]}
"level" is your CEFR estimate of my speaking from this sample (A2, B1, B2, C1 or C2).

${redoPrompt("speak", prevRedo)}
Transcript:
${transcript.slice(-12000)}` }], { json: true, heavy: true, signal: st.ctl.signal });
    st.speakItems = Array.isArray(r.items) ? r.items.filter(i => i && i.mine && i.natural).slice(0, 5) : [];
    $("speakLevel").textContent = r.level || "—"; $("speakSummary").textContent = r.summary || "";
    renderCorr($("speakCorr"), st.speakItems, "speak");
    $("reviewBox").hidden = false; $("reviewBox").scrollIntoView({ behavior: "smooth", block: "start" });
    renderCompare("speak", prevRedo, { level: r.level, summary: r.summary, compare: r.compare });
    addLog({ type: "speak", topic: st.topic.title, ctx: topicCtx(st.topic), level: r.level || "", summary: r.summary || "",
      items: st.speakItems.map(i => ({ mine: i.mine, natural: i.natural })), ...(prevRedo ? { redoOf: prevRedo.ts } : {}) });
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
  return y > x ? `進步 ${y - x} 級` : y < x ? `退了 ${x - y} 級` : "等級持平";
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
  const shape = `Also add a field "compare": 一兩句繁體中文，和上個月比：哪裡進步了、哪個問題還在。`;
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
  $("redoEyebrow").textContent = first && undone ? "今天是月初，先做這個" : "每月同題重做";
  $("redoIntro").textContent = `把 ${+lm.slice(5)} 月練過的題目再做一次，做完會和上個月的結果並排對照。一樣先自己說、自己寫，不要先看舊版。`;
  $("redoList").replaceChildren(...list.map(l => {
    const row = el("div", "redo-item"), done = redoneBy(l);
    const meta = el("h3", "", (l.type === "write" ? "寫作" : "口說") + " · " + l.date.slice(5).replace("-", "/") + " · " + l.level);
    const t = el("p", "", l.topic); t.lang = "en";
    row.append(meta, t);
    if (done) row.append(el("p", "muted", `已重做：${l.level} → ${done.level || "—"}` + (cefrDiff(l.level, done.level) ? "，" + cefrDiff(l.level, done.level) : "")));
    else { const b = el("button", "btn c-save", st.redo[l.type] === l ? "進行中，前往" : "重做這題"); b.onclick = () => startRedo(l); row.append(b) }
    return row }));
  if (first && undone) $("v-today").prepend(box);
  ["speak", "write"].forEach(k => { const r = st.redo[k], n = $(k === "speak" ? "speakRedoNote" : "writeRedoNote");
    n.hidden = !activeRedo(k); if (r) n.textContent = `每月同題重做：${r.date.slice(5).replace("-", "/")} 做過這題，當時 ${r.level}。先照平常練，結束後會並排對照。` });
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
  grid.append(col(`上個月 · ${prev.date.slice(5).replace("-", "/")}`, prev.level, kind === "write" ? (prev.text || "（這筆紀錄是舊版，沒有存原文）") : prev.summary || "", old),
    col("這次", now.level, kind === "write" ? now.text : now.summary || ""));
  const diff = cefrDiff(prev.level, now.level);
  box.replaceChildren(el("h2", "", "和上個月對照" + (diff ? "：" + diff : "")), grid, ...(now.compare ? [el("div", "habit", now.compare)] : []));
}

/* ---------- writing ---------- */
function wc() { const n = ($("essay").value.match(/[A-Za-z’']+/g) || []).length; $("wc").textContent = n + " 字" + (n && (n < 150 || n > 200) ? "（目標 150–200）" : "") }
$("essay").addEventListener("input", () => { wc(); try { localStorage.setItem("englishDesk.draft", $("essay").value) } catch { } });
$("grade").onclick = async () => {
  const text = $("essay").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 30) { toast("先寫至少 30 個字"); return }
  if (!hasKey()) { banner("先填好 API key 才能批改。", true); return }
  const topic = currentTopic("write"); st.writeTopic = topic; st.writeText = text; st.writeWhy = ""; st.writeRedo = activeRedo("write");
  st.ctl = new AbortController(); $("grade").disabled = true; $("grade").textContent = "批改中…"; $("stopGrade").hidden = false;
  try {
    const r = await ai("You are a strict English writing examiner. You reply with JSON only.", [{ role: "user", content: `I'm a B2-high English writer aiming for C1. Assess my paragraph (topic: ${topic.title}).
${topic.summary ? newsContext(topic) + "\nI was asked to give my opinion on this story. Judge how well I respond to it, but grade my English, not my opinion.\n" : ""}Reply with only JSON of this shape:
{"level":"B2","levelWhy":"一兩句繁體中文，說明這個等級的依據（文法範圍、用字、連貫、準確度）","rewrite":"the paragraph rewritten as a C1 writer would, keeping my meaning","changes":[{"mine":"my original phrase","natural":"the better version","why":"一行繁體中文說明為什麼"}],"habit":"一句繁體中文：我反覆出現、最該改的一個習慣"}
Give 3–5 changes, the ones that matter most. Be strict, not encouraging.
${redoPrompt("write", st.writeRedo)}
My paragraph:
${text.slice(0, 6000)}` }], { json: true, heavy: true, signal: st.ctl.signal });
    st.writeItems = Array.isArray(r.changes) ? r.changes.filter(i => i && i.mine && i.natural) : [];
    st.writeLevel = r.level || ""; st.writeWhy = r.levelWhy || "";
    renderCompare("write", st.writeRedo, { level: r.level, text, compare: r.compare });
    $("wLevel").textContent = r.level || "—"; $("wLevelWhy").textContent = r.levelWhy || "";
    $("wRewrite").textContent = r.rewrite || ""; $("wRewrite").hidden = false; $("hideModel").textContent = "先收起 C1 版本";
    $("wHabit").textContent = r.habit ? "要改的習慣：" + r.habit : ""; $("wHabit").hidden = !r.habit;
    renderCorr($("wCorr"), st.writeItems, "write");
    $("gradeBox").hidden = false; $("redoBox").hidden = false; $("redo").value = "";
    $("gradeBox").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { if (e.code !== "cancelled") toast(errText(e)) }
  finally { $("grade").disabled = false; $("grade").textContent = "請 AI 批改"; $("stopGrade").hidden = true }
};
$("stopGrade").onclick = () => st.ctl?.abort();
$("saveAllWrite").onclick = () => saveAll(st.writeItems, "write", $("wCorr"));
$("hideModel").onclick = () => { const h = !$("wRewrite").hidden; $("wRewrite").hidden = h; $("hideModel").textContent = h ? "再看一次 C1 版本" : "先收起 C1 版本" };
$("redoDone").onclick = () => {
  if (!$("redo").value.trim()) { toast("先重寫一次再按完成"); return }
  const prev = st.writeRedo;
  addLog({ type: "write", topic: st.writeTopic.title, ctx: topicCtx(st.writeTopic), level: st.writeLevel, why: st.writeWhy, text: st.writeText.slice(0, 3000), ...(prev ? { redoOf: prev.ts } : {}) });
  if (prev) { st.redo.write = null; st.writeRedo = null; renderRedo() }
  try { localStorage.removeItem("englishDesk.draft") } catch { }
  $("essay").value = ""; wc(); $("redoBox").hidden = true; toast("已記錄");
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
  $("echoSrc").textContent = "讀取中…";
  echo.dur = await audioDuration(blob);
  $("echoSrc").textContent = name + (echo.dur ? " · 全長 " + fmt(echo.dur) : "") + " · " + (blob.size / 1e6).toFixed(1) + " MB";
  $("echoRange").hidden = false; $("echoGo").disabled = false; echoHint("");
}
$("echoFile").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) setEchoSource(f, f.name) };
$("echoLoadUrl").onclick = async () => {
  const url = $("echoUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) { toast("貼上以 https:// 開頭的音檔連結"); return }
  const b = $("echoLoadUrl"); b.disabled = true; echoHint("下載中…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("這個連結打不開（" + res.status + "），確認是音檔本身的網址。");
    const blob = await res.blob();
    if (!/audio|octet-stream|mpeg|mp4/i.test(blob.type) && blob.size < 200000) throw new Error("這個連結看起來不是音檔。要用結尾是 .mp3 之類的直接連結，不是節目網頁。");
    await setEchoSource(blob, decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "podcast"));
  } catch (e) {
    echoHint(e instanceof TypeError ? "這個網站不讓別的網頁直接讀它的音檔。先把音檔下載下來，再按「上傳音檔」。" : e.message);
  } finally { b.disabled = false }
};
document.querySelectorAll("#echoLens .chip").forEach(c => c.onclick = () => {
  echo.len = +c.dataset.len; document.querySelectorAll("#echoLens .chip").forEach(x => x.setAttribute("aria-pressed", x === c));
});

// Decode just the chosen stretch. Big MP3s are cut by byte offset first (MP3 frames resync), so a phone never decodes an hour of audio.
async function decodeClip(start, len) {
  const blob = echo.blob, ctx = echoCtx();
  const mp3 = /mpeg|mp3/i.test(blob.type) || /\.mp3$/i.test(echo.name);
  let part = blob, off = 0;
  if (echo.dur && blob.size > 6e6) {
    if (mp3) { const bps = blob.size / echo.dur; part = blob.slice(Math.floor(start * bps), Math.ceil((start + len + 2) * bps)); off = start }
    else if (blob.size > 12e6) throw new Error("檔案太大了。mp3 以外的格式請先剪成 10 分鐘以內再上傳，或改用 mp3。");
  }
  let audio;
  try { const ab = await part.arrayBuffer(); audio = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)) }
  catch { throw new Error("這個音檔沒辦法解碼，換成 mp3 或 m4a 試試。") }
  const r = audio.sampleRate, s0 = Math.max(0, Math.round((start - off) * r)), n = Math.min(audio.length - s0, Math.round(len * r));
  if (n < r * 5) throw new Error("這段太短了，檢查開始時間有沒有超過全長。");
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
  if (isNaN(start)) { toast("開始時間寫成 12:30 或 12.5（分鐘）"); return }
  if (echo.dur && start >= echo.dur - 5) { toast("開始時間超過全長了"); return }
  const btn = $("echoGo"); btn.disabled = true; btn.textContent = "處理中…"; echoHint("切出片段…");
  echoStopPlay(); echo.ctl = new AbortController(); $("echoStop").hidden = false;
  try {
    const clip = await decodeClip(start, Math.min(len, echo.dur ? echo.dur - start : len));
    const key = cacheKey(start, len); let sents = cacheGet(key);
    if (!sents) {
      if (!cfg.geminiKey) throw new AiError("逐句稿要用 Gemini 轉，先到設定填 Gemini API key。", "nokey");
      echoHint("Gemini 正在聽寫並斷句，約 20–60 秒…");
      const r = await gemini("You transcribe English audio for a shadowing exercise. You reply with JSON only.", [
        { inlineData: { mimeType: "audio/wav", data: b64(wav16k(clip.data, clip.rate)) } },
        { text: `Transcribe this clip word for word and split it into sentences for shadowing practice. If a sentence runs past about 20 words, split it at a natural pause. Drop fillers like "um" and "uh".
For each piece give its start and end time in seconds from the start of this clip, to 0.1 s: start right as the first word begins, end right after the last word.
Leave out a sentence that is cut off at the very start or the very end of the clip.
Reply with only JSON: {"sentences":[{"start":0.0,"end":3.2,"text":"..."}]}` }], { json: true, signal: echo.ctl.signal });
      const dur = clip.data.length / clip.rate;
      sents = (Array.isArray(r.sentences) ? r.sentences : []).map(s => ({ start: +s.start, end: +s.end, text: String(s.text || "").trim() }))
        .filter(s => s.text && isFinite(s.start) && isFinite(s.end) && s.end > s.start && s.start < dur).sort((a, b) => a.start - b.start);
      sents = snapTimes(sents, clip.data, clip.rate);
      if (!sents.length) throw new Error("Gemini 沒有聽出句子，換一段有人說話的地方試試。");
      cachePut(key, sents);
    }
    const ab = echo.ctx.createBuffer(1, clip.data.length, clip.rate); ab.getChannelData(0).set(clip.data);
    Object.assign(echo, { buf: ab, data: clip.data, rate: clip.rate, sents, i: 0, mine: {}, scores: {} });
    $("echoClip").textContent = "約 " + fmt(start) + "–" + fmt(start + clip.data.length / clip.rate);
    $("echoPlayer").hidden = false; $("echoListBox").hidden = false; echoHint("");
    renderSents(); showSentence(0); $("echoPlayer").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.code !== "cancelled") { echoHint(errText(e)); if (e.code === "nokey" || e.code === "auth" || e.code === "model") banner(errText(e), true) } else echoHint("");
  } finally { btn.disabled = false; btn.textContent = "轉成逐句稿"; $("echoStop").hidden = true }
};
$("echoStop").onclick = () => echo.ctl?.abort();

/* playback */
function echoStopPlay() { clearTimeout(echo.loopT); const s = echo.src; echo.src = null; if (s) try { s.stop() } catch { } $("echoPlay").textContent = "▶ 原音" }
function playBuf(buf, a, b, then, rate = 1) {
  echoStopPlay(); const ctx = echoCtx(), s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.connect(ctx.destination);
  s.onended = () => { if (echo.src !== s) return; echo.src = null; $("echoPlay").textContent = "▶ 原音"; then && then() };
  echo.src = s; s.start(0, a, Math.max(.05, b - a));
}
function clipOf(i) { const x = echo.sents[i]; return [Math.max(0, x.start - .05), Math.min(echo.buf.duration, x.end + .15)] }
function playSentence(then) {
  const [a, b] = clipOf(echo.i);
  // In loop mode, leave a gap as long as the sentence so you can say it along before it plays again.
  playBuf(echo.buf, a, b, then || (() => { if (echo.loop) echo.loopT = setTimeout(() => playSentence(), Math.max(1500, (b - a) / echo.speed * 1000 + 600)) }), echo.speed);
  $("echoPlay").textContent = "■ 停止";
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
  $("echoPos").textContent = `第 ${i + 1} / ${echo.sents.length} 句`;
  $("echoPrev").disabled = i === 0; $("echoNext").disabled = i === echo.sents.length - 1;
  const m = echo.mine[i];
  $("echoMineRow").hidden = !m; $("echoScore").disabled = !m;
  if (m) $("echoDur").textContent = durText(i);
  renderScore(); renderSents();
  if (play) playSentence();
}
function durText(i) { const [a, b] = clipOf(i); return `原音 ${(b - a).toFixed(1)} 秒 · 你 ${echo.mine[i].buf.duration.toFixed(1)} 秒` }
function renderSents() {
  $("echoList").replaceChildren(...echo.sents.map((s, i) => { const li = document.createElement("li"), b = document.createElement("button");
    if (i === echo.i) b.setAttribute("aria-current", "true");
    const n = document.createElement("span"); n.className = "num"; n.textContent = i + 1;
    const t = document.createElement("span"); t.lang = "en"; t.textContent = s.text;
    const sc = document.createElement("span"); sc.className = "sc"; const r = echo.scores[i];
    sc.textContent = r ? (r.engine === "azure" ? Math.round(r.overall) + " 分" : "已看建議") : echo.mine[i] ? "已錄" : "";
    b.append(n, t, sc); b.onclick = () => showSentence(i, true); li.append(b); return li }));
}

/* recording: hold the button, release to stop */
async function echoMic() {
  if (echo.mic) return true;
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
  const ctx = echoCtx();
  try { echo.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }) }
  catch (e) {
    const msg = e && e.name === "NotAllowedError" ? "麥克風被拒絕了。到瀏覽器（iPhone 是「設定 > Safari > 麥克風」）允許這個網站使用麥克風再試。" : "打不開麥克風，檢查有沒有別的 App 正在用。";
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
  if (!echo.mic) { recBtn.textContent = "準備麥克風…"; const ok = await echoMic(); recBtn.textContent = "按住錄音";
    if (!ok) { echo.holding = false; return }
    if (!echo.holding) { toast("麥克風好了，再按住說一次"); return } }
  echo.chunks = []; echo.recording = true; echo.t0 = Date.now(); recBtn.classList.add("on");
  const tick = () => { const s = (Date.now() - echo.t0) / 1000; recBtn.textContent = "● 錄音中 " + fmt(s) + " · 放開就停"; if (s >= REC_MAX) recStop() };
  tick(); echo.recT = setInterval(tick, 250);
}
function recStop() {
  echo.holding = false; if (!echo.recording) return;
  echo.recording = false; clearInterval(echo.recT); recBtn.classList.remove("on"); recBtn.textContent = "按住錄音";
  const data = concat(echo.chunks), rate = echo.ctx.sampleRate; echo.chunks = [];
  if (data.length < rate * .4) { toast("太短了，按住說完整句再放開"); return }
  const buf = echo.ctx.createBuffer(1, data.length, rate); buf.getChannelData(0).set(data);
  echo.mine[echo.i] = { data, rate, buf }; delete echo.scores[echo.i];
  $("echoMineRow").hidden = false; $("echoScore").disabled = false; $("echoDur").textContent = durText(echo.i);
  renderScore(); renderSents();
}
recBtn.addEventListener("pointerdown", e => { if (e.button) return; e.preventDefault(); try { recBtn.setPointerCapture(e.pointerId) } catch { } recStart() });
recBtn.addEventListener("pointerup", recStop); recBtn.addEventListener("pointercancel", recStop);
recBtn.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); recStart() } });
recBtn.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); recStop() } });
recBtn.addEventListener("contextmenu", e => e.preventDefault());

/* scoring: Azure pronunciation assessment, or Gemini advice without a key */
class AzureError extends Error { }
async function azureAssess(wav, text, signal) {
  const params = { ReferenceText: text, GradingSystem: "HundredMark", Granularity: "Word", Dimension: "Comprehensive", EnableMiscue: "True", EnableProsodyAssessment: "True" };
  const header = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(params))));
  let res;
  try {
    res = await fetch(`https://${encodeURIComponent(cfg.azureRegion)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`, { method: "POST", signal,
      headers: { "Ocp-Apim-Subscription-Key": cfg.azureKey, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", "Pronunciation-Assessment": header, Accept: "application/json" }, body: wav });
  } catch (e) { if (e.name === "AbortError") throw new AiError("", "cancelled"); throw new AzureError("連不上 Azure，檢查網路和設定裡的地區（例如 eastasia）。") }
  if (res.status === 401 || res.status === 403) throw new AzureError("Azure key 或地區不對，請到設定檢查。");
  if (res.status === 429) throw new AzureError("Azure 免費額度用完或太頻繁了，等一下再試。");
  if (!res.ok) throw new AzureError("Azure 回了錯誤：" + res.status);
  return res.json();
}
function azureResult(d) {
  if (d.RecognitionStatus !== "Success" || !d.NBest?.length) throw new AzureError("Azure 沒聽到你說話，靠近麥克風再錄一次。");
  const n = d.NBest[0], p = n.PronunciationAssessment || n;
  return { engine: "azure", overall: p.PronScore, acc: p.AccuracyScore, flu: p.FluencyScore, comp: p.CompletenessScore, pros: p.ProsodyScore,
    words: (n.Words || []).map(w => { const q = w.PronunciationAssessment || w; return { word: w.Word, score: q.AccuracyScore, err: q.ErrorType || "None",
      breakErr: (q.Feedback?.Prosody?.Break?.ErrorTypes || []).filter(x => x !== "None"), tone: (q.Feedback?.Prosody?.Intonation?.ErrorTypes || []).filter(x => x !== "None") } }) };
}
async function geminiAdvice(i, signal) {
  const s = echo.sents[i], [a, b] = clipOf(i), r = echo.rate, orig = echo.data.subarray(Math.floor(a * r), Math.floor(b * r)), m = echo.mine[i];
  const res = await gemini("You are a precise English pronunciation coach for a Taiwanese learner. You reply with JSON only.", [
    { text: "Reference sentence: " + s.text + "\nFirst, the original speaker:" },
    { inlineData: { mimeType: "audio/wav", data: b64(wav16k(orig, r)) } },
    { text: "Now my recording, shadowing that sentence:" },
    { inlineData: { mimeType: "audio/wav", data: b64(wav16k(m.data, m.rate)) } },
    { text: `Compare my recording with the original and the reference text. Judge pronunciation only: individual sounds, word stress, linking, rhythm and intonation. Be honest and specific; don't praise what isn't there.
Reply with only JSON: {"words":[{"word":"each word of the reference sentence, in order","status":"good|unclear|wrong|missing","tip":"簡短繁體中文說明，status 不是 good 才寫"}],"tips":["最多 3 條繁體中文建議，最重要的先寫"],"summary":"一句繁體中文整體評語"}` }], { json: true, signal });
  return { engine: "gemini", words: (Array.isArray(res.words) ? res.words : []).filter(w => w && w.word).map(w => ({ word: String(w.word), status: w.status, tip: w.tip || "" })),
    tips: (Array.isArray(res.tips) ? res.tips : []).slice(0, 3).map(String), summary: res.summary || "" };
}
$("echoScore").onclick = async () => {
  const i = echo.i, m = echo.mine[i]; if (!m) return;
  const azure = !!(cfg.azureKey && cfg.azureRegion);
  if (!azure && !cfg.geminiKey) { banner("發音評分要 Azure key 或 Gemini key，先到設定填一組。", true); return }
  const btn = $("echoScore"); btn.disabled = true; btn.textContent = "評分中…"; echo.ctl = new AbortController();
  try {
    echo.scores[i] = azure ? azureResult(await azureAssess(wav16k(m.data, m.rate), echo.sents[i].text, echo.ctl.signal)) : await geminiAdvice(i, echo.ctl.signal);
    if (echo.i === i) renderScore(); renderSents();
  } catch (e) { if (e.code !== "cancelled") { toast(e.message || errText(e)); if (/設定/.test(e.message || "")) banner(e.message, true) } }
  finally { btn.disabled = false; btn.textContent = "評分發音" }
};
const ERR = { Mispronunciation: "發音不準", Omission: "漏掉了", Insertion: "多唸了", UnexpectedBreak: "不該停頓", MissingBreak: "該停沒停", Monotone: "語調太平" };
const QUALITY = { good: "", unclear: "mid", wrong: "bad", missing: "miss" };
function renderScore() {
  const r = echo.scores[echo.i], box = $("echoResult"), line = $("echoLine"), s = echo.sents[echo.i];
  $("echoEngine").textContent = cfg.azureKey && cfg.azureRegion ? "用 Azure 發音評估" : "沒填 Azure key，改用 Gemini 給建議";
  box.hidden = !r;
  if (!r) { line.textContent = s ? s.text : ""; return }
  // Words: colour plus a text list below, so colour is never the only signal.
  const words = r.engine === "azure"
    ? r.words.filter(w => w.err !== "Insertion").map(w => ({ word: w.word, q: w.err === "Omission" ? "miss" : w.err === "Mispronunciation" || w.score < 60 ? "bad" : w.score < 80 ? "mid" : "", title: Math.round(w.score) + " 分" }))
    : r.words.map(w => ({ word: w.word, q: QUALITY[w.status] || "", title: w.tip }));
  line.replaceChildren(...words.flatMap((w, k) => { const sp = document.createElement("span"); sp.className = "w"; if (w.q) sp.dataset.q = w.q; sp.textContent = w.word; if (w.title) sp.title = w.title; return k ? [" ", sp] : [sp] }));
  const tiles = $("echoTiles"), weak = $("echoWeak"), tips = $("echoTips");
  tiles.hidden = r.engine !== "azure";
  if (r.engine === "azure") {
    tiles.replaceChildren(...[["總分", r.overall], ["準確度", r.acc], ["流暢度", r.flu], ["完整度", r.comp], ["韻律", r.pros]].filter(x => x[1] != null).map(([k, v]) => {
      const d = document.createElement("div"), b = document.createElement("b"), l = document.createElement("span"); b.textContent = Math.round(v); l.textContent = k; d.append(b, l); return d }));
    const list = r.words.filter(w => w.err !== "None" || w.score < 80 || w.breakErr.length || w.tone.length);
    weak.replaceChildren(...(list.length ? list.slice(0, 8).map(w => { const p = document.createElement("p"); p.className = "c-why";
      const why = [w.err !== "None" ? ERR[w.err] || w.err : "", ...w.breakErr.map(x => ERR[x] || x), ...w.tone.map(x => ERR[x] || x)].filter(Boolean);
      p.innerHTML = ""; const b = document.createElement("b"); b.lang = "en"; b.textContent = w.word; p.append(b, ` ${Math.round(w.score)} 分` + (why.length ? " · " + why.join("、") : "")); return p })
      : [Object.assign(document.createElement("p"), { className: "c-why", textContent: "每個字都在 80 分以上。" })]));
    tips.replaceChildren(); $("echoSummary").textContent = "";
  } else {
    const list = r.words.filter(w => w.status && w.status !== "good");
    weak.replaceChildren(...list.slice(0, 8).map(w => { const p = document.createElement("p"); p.className = "c-why"; const b = document.createElement("b"); b.lang = "en"; b.textContent = w.word;
      p.append(b, " " + ({ unclear: "不太清楚", wrong: "發音不準", missing: "漏掉了" }[w.status] || w.status) + (w.tip ? " · " + w.tip : "")); return p }));
    tips.replaceChildren(...r.tips.map(t => Object.assign(document.createElement("li"), { textContent: t })));
    $("echoSummary").textContent = r.summary + " 這是 Gemini 聽出來的建議，沒有精確分數；到設定填 Azure key 可以拿到逐字分數。";
  }
}
$("echoDone").onclick = () => {
  const n = Object.keys(echo.mine).length;
  if (!n) { toast("先跟讀幾句再按完成"); return }
  const sc = Object.values(echo.scores).filter(r => r.engine === "azure").map(r => r.overall);
  addLog({ type: "echo", topic: echo.title + ` · ${n} 句`, level: "", score: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null });
  echoStopPlay(); echoMicOff(); toast("已記錄，算進本週進度");
};
function echoLeave() { echoStopPlay(); if (echo.recording) recStop(); echoMicOff() }
addEventListener("pagehide", echoLeave);

/* ---------- corrections + cards ---------- */
function renderCorr(box, items, source) {
  if (!items.length) { box.innerHTML = '<p class="muted">這次沒有挑出需要修改的地方。</p>'; return }
  box.replaceChildren(...items.map(it => { const el = document.createElement("div"); el.className = "c-item";
    const a = document.createElement("div"); a.className = "c-mine"; a.textContent = it.mine;
    const b = document.createElement("div"); b.className = "c-nat"; b.textContent = it.natural;
    const c = document.createElement("div"); c.className = "c-why"; c.textContent = it.why || "";
    const s = document.createElement("button"); s.className = "btn c-save"; s.textContent = "存成卡片";
    s.onclick = () => { saveCard(it, source); persist(); s.textContent = "已存"; s.disabled = true };
    el.append(a, b, c, s); return el }));
}
function saveCard(it, source) {
  if (st.cards.some(c => c.mine === it.mine && c.natural === it.natural)) return false;
  st.cards.push({ id: uid(), mine: String(it.mine), natural: String(it.natural), why: String(it.why || ""), source, created: today(), due: today(), box: 0 });
  return true;
}
function saveAll(items, source, box) {
  let n = 0; for (const it of items) if (saveCard(it, source)) n++;
  persist(); box.querySelectorAll(".c-save").forEach(b => { b.textContent = "已存"; b.disabled = true });
  toast(n ? `存了 ${n} 張卡片` : "這些都已經存過了");
}
const due = () => st.cards.filter(c => c.due <= today());
let flashShown = false;
function renderFlash() {
  const list = due(), f = $("flash"), btns = $("flashBtns");
  $("dueLabel").textContent = list.length ? `還有 ${list.length} 張` : "";
  if (!list.length) { f.innerHTML = st.cards.length ? '<p class="muted">今天的卡片都複習完了。</p>' : '<p class="muted">還沒有卡片。口說或寫作檢討後，按「存成卡片」，修正過的說法就會出現在這裡。</p>'; btns.replaceChildren(); return }
  const c = list[0];
  f.replaceChildren();
  const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = "你原本這樣說，自然的說法是？";
  const q = document.createElement("div"); q.className = "q"; q.textContent = c.mine;
  f.append(hint, q);
  if (flashShown) { const a = document.createElement("div"); a.className = "a"; a.textContent = c.natural; const w = document.createElement("p"); w.className = "muted"; w.textContent = c.why; f.append(a, w) }
  const mk = (t, cls, fn) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = t; b.onclick = fn; return b };
  btns.replaceChildren(...(flashShown
    ? [mk("再練一次", "red", () => grade(c, false)), mk("記得", "accent", () => grade(c, true))]
    : [mk("看答案", "primary", () => { flashShown = true; renderFlash() })]));
}
const GAPS = [1, 2, 4, 8, 16, 32, 64];
function grade(c, ok) {
  flashShown = false;
  c.box = ok ? Math.min((c.box || 0) + 1, GAPS.length) : 0;
  c.due = addDays(ok ? GAPS[c.box - 1] : 1);
  persist();
}
function renderList() {
  const box = $("cardList");
  const n = due().length; $("dueCount").textContent = n ? n : "";
  if (!st.cards.length) { box.innerHTML = '<p class="muted">還沒有卡片。</p>'; return }
  box.replaceChildren(...[...st.cards].sort((a, b) => (b.created || "").localeCompare(a.created || "")).map(c => {
    const el = document.createElement("div"); el.className = "c-item";
    const d = document.createElement("div");
    const a = document.createElement("div"); a.className = "c-mine"; a.textContent = c.mine;
    const b = document.createElement("div"); b.className = "c-nat"; b.textContent = c.natural;
    const w = document.createElement("div"); w.className = "c-why"; w.textContent = (c.source === "write" ? "寫作 · " : "口說 · ") + "下次複習 " + c.due;
    d.append(a, b, w);
    const x = document.createElement("button"); x.className = "del"; x.textContent = "刪除"; x.setAttribute("aria-label", "刪除這張卡片");
    x.onclick = () => { if (x.dataset.armed) { st.cards = st.cards.filter(k => k.id !== c.id); persist() } else { x.dataset.armed = 1; x.textContent = "確定刪除？"; setTimeout(() => { delete x.dataset.armed; x.textContent = "刪除" }, 3000) } };
    el.append(d, x); return el }));
}
$("exportAnki").onclick = () => {
  if (!st.cards.length) { toast("還沒有卡片可以匯出"); return }
  const q = s => '"' + String(s || "").replace(/"/g, '""') + '"';
  const rows = st.cards.map(c => [q(c.mine), q(c.natural + (c.why ? "<br><small>" + c.why + "</small>" : ""))].join(","));
  download("english-desk-anki.csv", "﻿" + rows.join("\n"), "text/csv");
  toast("已下載，在 Anki 選「匯入檔案」");
};

/* ---------- settings + backup ---------- */
function setProvider(p) { cfg.provider = p; $("pvGemini").setAttribute("aria-pressed", p === "gemini"); $("pvClaude").setAttribute("aria-pressed", p === "claude"); $("fClaude").hidden = p !== "claude" }
$("pvGemini").onclick = () => setProvider("gemini");
$("pvClaude").onclick = () => setProvider("claude");
const FIELDS = ["geminiKey", "geminiModel", "liveModel", "claudeKey", "claudeChat", "claudeGrade", "azureKey", "azureRegion"];
function fillSettings() { FIELDS.forEach(f => $(f).value = cfg[f] || ""); setProvider(cfg.provider) }
function saveSettings() {
  FIELDS.forEach(f => cfg[f] = $(f).value.trim());
  if (!cfg.geminiModel) cfg.geminiModel = "gemini-3.5-flash-lite";
  if (!cfg.liveModel) cfg.liveModel = LIVE_DEFAULT;
  if (!cfg.claudeChat) cfg.claudeChat = "claude-haiku-5-5";
  if (!cfg.claudeGrade) cfg.claudeGrade = "claude-sonnet-5-5";
  cfg.azureRegion = cfg.azureRegion.toLowerCase().replace(/\s+/g, "");
  try { localStorage.setItem(CFG, JSON.stringify(cfg)) } catch { toast("瀏覽器拒絕儲存設定"); return }
  fillSettings(); liveAvailability(); if (hasKey()) banner(""); if (!$("echoPlayer").hidden) renderScore();
  toast("已儲存");
}
$("saveSettings").onclick = saveSettings;
$("testAi").onclick = async () => {
  saveSettings(); $("testOut").textContent = "測試中…";
  try { const t = await ai("Reply with exactly: OK", [{ role: "user", content: "Say OK." }]); $("testOut").textContent = "連線成功（" + t.slice(0, 20) + "）" }
  catch (e) { $("testOut").textContent = errText(e) }
};
$("saveAzure").onclick = saveSettings;
// One second of silence: a working key answers 200 with "no speech", a wrong key or region answers 401 or fails to connect.
$("testAzure").onclick = async () => {
  saveSettings();
  if (!cfg.azureKey || !cfg.azureRegion) { $("azureOut").textContent = "key 和地區都要填。"; return }
  $("azureOut").textContent = "測試中…";
  try { await azureAssess(wav16k(new Float32Array(16000), 16000), "Hello.", undefined); $("azureOut").textContent = "連線成功，可以用 Azure 評分了" }
  catch (e) { $("azureOut").textContent = e.message }
};
$("exportBackup").onclick = () => {
  download(`english-desk-backup-${today()}.json`, JSON.stringify({ app: "english-desk", version: 1, exported: new Date().toISOString(), cards: st.cards, logs: st.logs }, null, 2), "application/json");
  toast("已匯出備份（不含 API key）");
};
$("importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.cards) || !Array.isArray(d.logs)) throw 0;
    const ids = new Set(st.cards.map(c => c.id)), ts = new Set(st.logs.map(l => l.ts));
    const nc = d.cards.filter(c => c && c.mine && !ids.has(c.id)), nl = d.logs.filter(l => l && !ts.has(l.ts));
    st.cards.push(...nc); st.logs.push(...nl); persist();
    $("backupInfo").textContent = `匯入了 ${nc.length} 張卡片、${nl.length} 筆紀錄`;
  } catch { toast("這不是 English Desk 的備份檔") }
};
function backupInfo() { $("backupInfo").textContent = `目前 ${st.cards.length} 張卡片、${st.logs.length} 筆紀錄` }

/* ---------- boot ---------- */
load(); fillSettings(); loadNews(); renderToday(); renderLogs(); renderList(); backupInfo(); renderRedo();
try { $("essay").value = localStorage.getItem("englishDesk.draft") || "" } catch { }
wc(); setSpeakMode("live"); route();
if (!hasKey()) banner("第一次使用：先填一組 API key。", true);
})();
