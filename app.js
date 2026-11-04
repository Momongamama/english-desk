(() => {
const $ = id => document.getElementById(id);
const STORE = "englishDesk.v1", CFG = "englishDesk.cfg";
const st = { cards: [], logs: [], speakMode: "live", inline: false, topic: "", ctl: null, speakItems: [], writeItems: [], writeLevel: "", writeTopic: "" };
let cfg = { provider: "gemini", geminiKey: "", geminiModel: "gemini-3.5-flash-lite", liveModel: "gemini-3.8-live", claudeKey: "", claudeChat: "claude-haiku-5-5", claudeGrade: "claude-sonnet-5-5" };

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
async function ai(system, turns, { json = false, heavy = false, signal } = {}) {
  if (!hasKey()) throw new AiError("還沒有設定 API key。", "nokey");
  let res;
  try {
    if (cfg.provider === "claude") {
      res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": cfg.claudeKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: heavy ? cfg.claudeGrade : cfg.claudeChat, max_tokens: heavy ? 3000 : 600, system, messages: turns }) });
    } else {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, { method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] },
          contents: turns.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
          generationConfig: json ? { responseMimeType: "application/json" } : {} }) });
    }
  } catch (e) { if (e.name === "AbortError") throw new AiError("", "cancelled"); throw new AiError("連不上 AI 服務，檢查網路後再試。", "network") }
  let data = {}; try { data = await res.json() } catch { }
  if (!res.ok) {
    const m = data?.error?.message || "";
    if (res.status === 401 || res.status === 403 || /API key/i.test(m)) throw new AiError("API key 無效，請到設定檢查。", "auth");
    if (res.status === 429) throw new AiError("用量到上限或太頻繁了，等一下再試。", "rate");
    if (res.status === 404 || /model/i.test(m)) throw new AiError("找不到這個模型名稱，請到設定檢查。", "model");
    throw new AiError("AI 回了錯誤：" + (m || res.status), "upstream");
  }
  const text = cfg.provider === "claude"
    ? (data.content || []).filter(b => b.type === "text").map(b => b.text).join("")
    : (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text.trim()) throw new AiError("AI 沒有回覆內容，再試一次。", "empty");
  if (!json) return text.trim();
  return parseJson(text);
}
function parseJson(text) {
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const t of tries) { if (!t) continue; try { return JSON.parse(t) } catch { } }
  throw new AiError("AI 回的格式跑掉了，再按一次試試。", "json");
}
const errText = e => e?.message || "出了點問題，再試一次。";

/* ---------- routing ---------- */
const VIEWS = ["today", "speak", "write", "cards", "settings", "read"];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  VIEWS.forEach(x => { $("v-" + x).hidden = x !== v });
  document.querySelectorAll("nav a").forEach(a => a.dataset.v === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "cards") renderFlash();
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
  { d: "六", t: "跟讀", go: null, long: "用 Enjoy 的 Echo 模式跟讀一段，錄音和原音比對" },
];
const KIND = { speak: "speak", write: "write", cards: "cards" };
function weekDates() { const d = new Date(), off = (d.getDay() + 6) % 7; return [0, 1, 2, 3, 4, 5, 6].map(i => { const x = new Date(d); x.setDate(d.getDate() - off + i); return x.toLocaleDateString("sv-SE") }) }
function renderToday() {
  const n = new Date().getDay(), p = PLAN[n];
  $("todayLabel").textContent = "今天 · 週" + p.d;
  $("todayTask").textContent = p.long;
  const go = $("todayGo");
  if (p.go) { go.href = "#" + p.go; go.textContent = "開始" } else { go.href = "https://enjoy.bot/"; go.target = "_blank"; go.rel = "noopener"; go.textContent = "打開 Enjoy" }
  renderWeek();
}
function renderWeek() {
  const n = new Date().getDay(), dates = weekDates();
  const counts = dates.map(d => st.logs.filter(l => l.date === d).length);
  $("week").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((i, k) => { const el = document.createElement("div");
    el.className = "day" + (i === n ? " today" : ""); el.dataset.s = PLAN[i].go ? KIND[PLAN[i].go] : "echo";
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
    const lv = document.createElement("span"); lv.className = "level"; lv.textContent = l.level || "—";
    const s = document.createElement("span"); s.textContent = (l.type === "write" ? "寫作 · " : "口說 · ") + (l.topic || "");
    el.append(t, lv, s); return el }));
}
function addLog(l) { st.logs.push({ ...l, date: today(), ts: Date.now() }); if (st.logs.length > 500) st.logs.splice(0, st.logs.length - 500); persist() }

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
    b.onclick = () => { picked[kind] = t; renderTopics(kind) }; return b }));
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
    const rd = document.createElement("button"); rd.className = "btn c-save"; rd.textContent = "閱讀全文"; rd.onclick = () => window.EnglishDeskReader?.open(it); row.append(rd);
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
  const all = new Float32Array(n); let o = 0; for (const b of live.buf) { all.set(b, o); o += b.length } live.buf = [];
  const ratio = rate / 16000, out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), z = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0;
    for (let j = a; j < z; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, z - a))); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  live.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: b64(new Uint8Array(out.buffer)) } } }));
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

Transcript:
${transcript.slice(-12000)}` }], { json: true, heavy: true, signal: st.ctl.signal });
    st.speakItems = Array.isArray(r.items) ? r.items.filter(i => i && i.mine && i.natural).slice(0, 5) : [];
    $("speakLevel").textContent = r.level || "—"; $("speakSummary").textContent = r.summary || "";
    renderCorr($("speakCorr"), st.speakItems, "speak");
    $("reviewBox").hidden = false; $("reviewBox").scrollIntoView({ behavior: "smooth", block: "start" });
    addLog({ type: "speak", topic: st.topic.title, level: r.level || "" });
  } catch (e) { if (e.code !== "cancelled") { toast(errText(e)); if (e.code === "nokey" || e.code === "auth" || e.code === "model") banner(errText(e), true) } }
  finally { btn.disabled = false; btn.textContent = label; $("stopPaste").hidden = true; liveAvailability() }
}
$("saveAllSpeak").onclick = () => saveAll(st.speakItems, "speak", $("speakCorr"));

/* ---------- writing ---------- */
function wc() { const n = ($("essay").value.match(/[A-Za-z’']+/g) || []).length; $("wc").textContent = n + " 字" + (n && (n < 150 || n > 200) ? "（目標 150–200）" : "") }
$("essay").addEventListener("input", () => { wc(); try { localStorage.setItem("englishDesk.draft", $("essay").value) } catch { } });
$("grade").onclick = async () => {
  const text = $("essay").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 30) { toast("先寫至少 30 個字"); return }
  if (!hasKey()) { banner("先填好 API key 才能批改。", true); return }
  const topic = currentTopic("write"); st.writeTopic = topic.title;
  st.ctl = new AbortController(); $("grade").disabled = true; $("grade").textContent = "批改中…"; $("stopGrade").hidden = false;
  try {
    const r = await ai("You are a strict English writing examiner. You reply with JSON only.", [{ role: "user", content: `I'm a B2-high English writer aiming for C1. Assess my paragraph (topic: ${topic.title}).
${topic.summary ? newsContext(topic) + "\nI was asked to give my opinion on this story. Judge how well I respond to it, but grade my English, not my opinion.\n" : ""}Reply with only JSON of this shape:
{"level":"B2","levelWhy":"一兩句繁體中文，說明這個等級的依據（文法範圍、用字、連貫、準確度）","rewrite":"the paragraph rewritten as a C1 writer would, keeping my meaning","changes":[{"mine":"my original phrase","natural":"the better version","why":"一行繁體中文說明為什麼"}],"habit":"一句繁體中文：我反覆出現、最該改的一個習慣"}
Give 3–5 changes, the ones that matter most. Be strict, not encouraging.

My paragraph:
${text.slice(0, 6000)}` }], { json: true, heavy: true, signal: st.ctl.signal });
    st.writeItems = Array.isArray(r.changes) ? r.changes.filter(i => i && i.mine && i.natural) : [];
    st.writeLevel = r.level || "";
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
  addLog({ type: "write", topic: st.writeTopic, level: st.writeLevel });
  try { localStorage.removeItem("englishDesk.draft") } catch { }
  $("essay").value = ""; wc(); $("redoBox").hidden = true; toast("已記錄");
};

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
  const word = c.kind === "word";
  const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = word ? "這個字是什麼意思？" : "你原本這樣說，自然的說法是？";
  const q = document.createElement("div"); q.className = word ? "q word" : "q"; q.lang = "en"; q.textContent = c.mine;
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
    if (c.kind === "word") { a.className = "c-word"; b.className = "c-why" }
    const w = document.createElement("div"); w.className = "c-why"; w.textContent = ({ write: "寫作 · ", read: "單字本 · " }[c.source] || "口說 · ") + "下次複習 " + c.due;
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
function setProvider(p) { cfg.provider = p; $("pvGemini").setAttribute("aria-pressed", p === "gemini"); $("pvClaude").setAttribute("aria-pressed", p === "claude"); $("fGemini").hidden = p !== "gemini"; $("fClaude").hidden = p !== "claude" }
$("pvGemini").onclick = () => setProvider("gemini");
$("pvClaude").onclick = () => setProvider("claude");
const FIELDS = ["geminiKey", "geminiModel", "liveModel", "claudeKey", "claudeChat", "claudeGrade"];
function fillSettings() { FIELDS.forEach(f => $(f).value = cfg[f] || ""); setProvider(cfg.provider) }
function saveSettings() {
  FIELDS.forEach(f => cfg[f] = $(f).value.trim());
  if (!cfg.geminiModel) cfg.geminiModel = "gemini-3.5-flash-lite";
  if (!cfg.liveModel) cfg.liveModel = LIVE_DEFAULT;
  if (!cfg.claudeChat) cfg.claudeChat = "claude-haiku-5-5";
  if (!cfg.claudeGrade) cfg.claudeGrade = "claude-sonnet-5-5";
  try { localStorage.setItem(CFG, JSON.stringify(cfg)) } catch { toast("瀏覽器拒絕儲存設定"); return }
  fillSettings(); liveAvailability(); if (hasKey()) banner("");
  toast("已儲存");
}
$("saveSettings").onclick = saveSettings;
$("testAi").onclick = async () => {
  saveSettings(); $("testOut").textContent = "測試中…";
  try { const t = await ai("Reply with exactly: OK", [{ role: "user", content: "Say OK." }]); $("testOut").textContent = "連線成功（" + t.slice(0, 20) + "）" }
  catch (e) { $("testOut").textContent = errText(e) }
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

/* ---------- word book (used by reader.js) ---------- */
// A saved word is a card with kind "word": front = the word, back = definition, note = the sentence it came from.
window.EnglishDesk = {
  toast,
  words: () => st.cards.filter(c => c.kind === "word").map(c => c.mine),
  addWord({ word, def, sentence, source }) {
    if (st.cards.some(c => c.kind === "word" && c.mine.toLowerCase() === word)) return false;
    st.cards.push({ id: uid(), kind: "word", mine: word, natural: def || "（沒有解釋，複習時自己想想）", why: sentence ? sentence + (source ? " — " + source : "") : "", source: "read", created: today(), due: today(), box: 0 });
    persist(); return true;
  },
};

/* ---------- boot ---------- */
load(); fillSettings(); loadNews(); renderToday(); renderLogs(); renderList(); backupInfo();
try { $("essay").value = localStorage.getItem("englishDesk.draft") || "" } catch { }
wc(); setSpeakMode("live"); route();
if (!hasKey()) banner("第一次使用：先填一組 API key。", true);
})();
