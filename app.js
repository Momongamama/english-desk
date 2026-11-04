(() => {
const $ = id => document.getElementById(id);
const STORE = "englishDesk.v1", CFG = "englishDesk.cfg";
const st = { cards: [], logs: [], turns: [], inline: true, topic: "", ctl: null, speakItems: [], writeItems: [], writeLevel: "", writeTopic: "" };
let cfg = { provider: "gemini", geminiKey: "", geminiModel: "gemini-3.5-flash-lite", claudeKey: "", claudeChat: "claude-haiku-5-5", claudeGrade: "claude-sonnet-5-5" };

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
const VIEWS = ["today", "speak", "write", "cards", "settings"];
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

/* ---------- speaking ---------- */
const TOPICS = ["What I did this week", "A book I'm reading", "A project I'm working on", "Something I want to buy", "A place I'd like to visit"];
function chipRow(container, list, onPick) {
  container.replaceChildren(...list.map((t, i) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = t; b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
    b.onclick = () => { container.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); onPick(t) }; return b }));
  onPick(list[0]);
}
let pickedTopic = TOPICS[0];
chipRow($("topics"), TOPICS, t => pickedTopic = t);
function setMode(inline) { st.inline = inline; $("modeInline").setAttribute("aria-pressed", inline); $("modeAfter").setAttribute("aria-pressed", !inline) }
$("modeInline").onclick = () => setMode(true);
$("modeAfter").onclick = () => setMode(false);

function rules() {
  return `You are my English conversation partner. I'm a Taiwanese learner at about CEFR B2, aiming for C1. Talk like a friendly, curious friend. Keep each reply to 1–3 short sentences and end with one follow-up question, so I do most of the talking. Reply in plain English text, no markdown, no emoji. Today's topic: ${st.topic}.
` + (st.inline
    ? `If my latest message has a mistake a native speaker would notice, begin your reply with ONE line that starts with "✎ " and gives the most important part of my sentence rewritten naturally, then a blank line, then your normal reply. If nothing is worth fixing, skip that line.`
    : `Do not correct my English at all; just keep the conversation flowing.`);
}
const canSpeak = "speechSynthesis" in window;
function speak(text) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = 0.95; speechSynthesis.speak(u) } catch { } }
function addMsg(role, text) {
  const el = document.createElement("div"); el.className = "msg " + (role === "user" ? "me" : "ai");
  fillMsg(el, role, text); $("log").append(el); $("log").scrollTop = $("log").scrollHeight; return el;
}
function fillMsg(el, role, text) {
  el.replaceChildren();
  let body = text;
  if (role !== "user" && text.startsWith("✎")) { const nl = text.indexOf("\n"); const note = document.createElement("span"); note.className = "note"; note.textContent = (nl < 0 ? text : text.slice(0, nl)).replace(/^✎\s*/, "✎ "); el.append(note); body = nl < 0 ? "" : text.slice(nl).trim() }
  el.append(document.createTextNode(body));
  if (role !== "user" && canSpeak && body) { const b = document.createElement("button"); b.className = "speak"; b.textContent = "▶ 朗讀"; b.onclick = () => speak(body); el.append(b) }
}
async function ask() {
  const bubble = addMsg("assistant", ""); bubble.classList.add("thinking"); bubble.textContent = "…";
  st.ctl = new AbortController(); $("send").disabled = true; $("stopChat").hidden = false;
  const turns = st.turns.length ? st.turns.slice(-30) : [{ role: "user", content: "Start now: greet me briefly and ask your first question about the topic." }];
  if (turns[0].role !== "user") turns.unshift({ role: "user", content: "(continuing our conversation)" });
  try {
    const text = await ai(rules(), turns, { signal: st.ctl.signal });
    bubble.classList.remove("thinking"); fillMsg(bubble, "assistant", text); $("log").scrollTop = $("log").scrollHeight;
    st.turns.push({ role: "assistant", content: text });
  } catch (e) {
    bubble.remove();
    if (e.code !== "cancelled") { toast(errText(e)); if (e.code === "nokey" || e.code === "auth" || e.code === "model") banner(errText(e), true) }
  } finally { $("send").disabled = false; $("stopChat").hidden = true; $("chatIn").focus() }
}
$("startChat").onclick = () => {
  if (!hasKey()) { banner("先填好 API key 才能開始。", true); return }
  st.topic = $("topicCustom").value.trim() || pickedTopic; st.turns = [];
  $("log").replaceChildren(); $("chatBox").hidden = false; $("reviewBox").hidden = true;
  $("chatHint").textContent = "題目：" + st.topic; ask();
};
function send() {
  const v = $("chatIn").value.trim(); if (!v || $("send").disabled) return;
  const last = st.turns.at(-1);
  if (last && last.role === "user") last.content += "\n" + v; else st.turns.push({ role: "user", content: v });
  addMsg("user", v); $("chatIn").value = ""; ask();
}
$("send").onclick = send;
$("chatIn").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } });
$("stopChat").onclick = () => st.ctl?.abort();

$("review").onclick = async () => {
  const mine = st.turns.filter(t => t.role === "user");
  if (mine.length < 2) { toast("至少說兩句話再檢討"); return }
  const btn = $("review"); btn.disabled = true; btn.textContent = "整理中…";
  const transcript = st.turns.map(t => (t.role === "user" ? "ME: " : "PARTNER: ") + t.content.replace(/^✎.*\n?/, "")).join("\n");
  try {
    const r = await ai("You are a strict but kind English speaking coach. You reply with JSON only.", [{ role: "user", content: `Here's a transcript of me speaking English (ME lines are mine). I'm around B2.
Don't fix every small slip. Pick up to 5 places where a native speaker would have said it differently.
Reply with only JSON of this shape:
{"level":"B2","summary":"一句繁體中文的整體評語","items":[{"mine":"my original phrase","natural":"the natural version","why":"一行繁體中文說明"}]}
"level" is your CEFR estimate of my speaking from this sample (A2, B1, B2, C1 or C2).

Transcript:
${transcript.slice(-12000)}` }], { json: true, heavy: true });
    st.speakItems = Array.isArray(r.items) ? r.items.filter(i => i && i.mine && i.natural) : [];
    $("speakLevel").textContent = r.level || "—"; $("speakSummary").textContent = r.summary || "";
    renderCorr($("speakCorr"), st.speakItems, "speak");
    $("reviewBox").hidden = false; $("reviewBox").scrollIntoView({ behavior: "smooth", block: "start" });
    addLog({ type: "speak", topic: st.topic, level: r.level || "" });
  } catch (e) { toast(errText(e)) }
  finally { btn.disabled = false; btn.textContent = "結束並檢討" }
};
$("saveAllSpeak").onclick = () => saveAll(st.speakItems, "speak", $("speakCorr"));

/* ---------- writing ---------- */
const WTOPICS = ["介紹最近讀的一本書", "描述一個正在做的專案", "說明一個你常用的工具", "婉拒一個邀請的 email", "你理想中的週末"];
chipRow($("wtopics"), WTOPICS, t => st.writeTopic = t);
function wc() { const n = ($("essay").value.match(/[A-Za-z’']+/g) || []).length; $("wc").textContent = n + " 字" + (n && (n < 150 || n > 200) ? "（目標 150–200）" : "") }
$("essay").addEventListener("input", () => { wc(); try { localStorage.setItem("englishDesk.draft", $("essay").value) } catch { } });
$("grade").onclick = async () => {
  const text = $("essay").value.trim();
  if ((text.match(/[A-Za-z]+/g) || []).length < 30) { toast("先寫至少 30 個字"); return }
  if (!hasKey()) { banner("先填好 API key 才能批改。", true); return }
  st.ctl = new AbortController(); $("grade").disabled = true; $("grade").textContent = "批改中…"; $("stopGrade").hidden = false;
  try {
    const r = await ai("You are a strict English writing examiner. You reply with JSON only.", [{ role: "user", content: `I'm a B2-high English writer aiming for C1. Assess my paragraph (topic: ${st.writeTopic}).
Reply with only JSON of this shape:
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
function setProvider(p) { cfg.provider = p; $("pvGemini").setAttribute("aria-pressed", p === "gemini"); $("pvClaude").setAttribute("aria-pressed", p === "claude"); $("fGemini").hidden = p !== "gemini"; $("fClaude").hidden = p !== "claude" }
$("pvGemini").onclick = () => setProvider("gemini");
$("pvClaude").onclick = () => setProvider("claude");
const FIELDS = ["geminiKey", "geminiModel", "claudeKey", "claudeChat", "claudeGrade"];
function fillSettings() { FIELDS.forEach(f => $(f).value = cfg[f] || ""); setProvider(cfg.provider) }
function saveSettings() {
  FIELDS.forEach(f => cfg[f] = $(f).value.trim());
  if (!cfg.geminiModel) cfg.geminiModel = "gemini-3.5-flash-lite";
  if (!cfg.claudeChat) cfg.claudeChat = "claude-haiku-5-5";
  if (!cfg.claudeGrade) cfg.claudeGrade = "claude-sonnet-5-5";
  try { localStorage.setItem(CFG, JSON.stringify(cfg)) } catch { toast("瀏覽器拒絕儲存設定"); return }
  fillSettings(); if (hasKey()) banner("");
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

/* ---------- boot ---------- */
load(); fillSettings(); renderToday(); renderLogs(); renderList(); backupInfo();
try { $("essay").value = localStorage.getItem("englishDesk.draft") || "" } catch { }
wc(); route();
if (!hasKey()) banner("第一次使用：先填一組 API key。", true);
})();
