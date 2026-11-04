/* English Desk — news reader + tap-to-look-up.
   Article text is fetched on demand in the browser (r.jina.ai reader) and never stored in the repo.
   The user's dictionary and TOEFL/IELTS/GRE lists live in this browser's IndexedDB, imported from Settings. */
(() => {
const $ = id => document.getElementById(id);
const ED = () => window.EnglishDesk;
const toast = m => ED() ? ED().toast(m) : alert(m);

/* ---------- IndexedDB: dictionary entries + exam word lists ---------- */
const DB = "englishDesk.dict";
let dbp;
function db() {
  return dbp ||= new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("entries"); r.result.createObjectStore("meta") };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => { const tx = d.transaction(store, mode); const out = fn(tx.objectStore(store)); tx.oncomplete = () => ok(out instanceof IDBRequest ? out.result : out); tx.onerror = () => no(tx.error) });
}
const getMeta = k => idb("meta", "readonly", s => s.get(k));
const setMeta = (k, v) => idb("meta", "readwrite", s => { s.put(v, k) });
// Entries are HTML from the user's own dictionary; "@word" means "see word" (e.g. rallied → @rally).
async function getEntry(k) {
  for (let hop = 0; hop < 4 && k; hop++) {
    const v = await idb("entries", "readonly", s => s.get(k));
    if (typeof v !== "string" || !v.startsWith("@")) return v ? { head: k, html: v } : null;
    k = v.slice(1);
  }
  return null;
}

const EXAMS = [["toefl", "托福", "T"], ["ielts", "雅思", "I"], ["gre", "GRE", "G"]];
const lists = { toefl: new Set(), ielts: new Set(), gre: new Set() };
let dictInfo = null, builtinLists = false;
async function loadMeta() {
  try {
    dictInfo = await getMeta("dict") || null;
    for (const [k] of EXAMS) lists[k] = new Set(await getMeta("list:" + k) || []);
  } catch { }
  // No list imported: fall back to the exam tags that ship with the built-in dictionary (ECDICT).
  if (!EXAMS.some(([k]) => lists[k].size)) {
    try {
      const tags = await (await fetch("dict/_exam.json?v=2")).json();
      for (const [w, t] of Object.entries(tags)) for (const [k, , c] of EXAMS) if (t.includes(c.toLowerCase())) lists[k].add(w);
      builtinLists = true;
    } catch { }
  }
  renderDictStatus();
}

/* ---------- word forms: "rallied" → rally, "taxes" → tax ---------- */
function forms(w) {
  w = w.toLowerCase().replace(/[’']s$/, "").replace(/’/g, "'");
  const f = [w], add = x => x && x.length > 1 && !f.includes(x) && f.push(x);
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.at(-3) === w.at(-4)) add(w.slice(0, -3)) }
  if (w.endsWith("ing")) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); if (w.at(-4) === w.at(-5)) add(w.slice(0, -4)) }
  if (w.endsWith("ly")) { add(w.slice(0, -2)); if (w.endsWith("ily")) add(w.slice(0, -3) + "y") }
  if (w.endsWith("er")) { add(w.slice(0, -2)); add(w.slice(0, -1)) }
  if (w.endsWith("est")) { add(w.slice(0, -3)); add(w.slice(0, -2)) }
  return f;
}
function examsOf(w) {
  const out = [];
  for (const [k] of EXAMS) if (forms(w).some(x => lists[k].has(x))) out.push(k);
  return out;
}

/* ---------- fetching the article ----------
   r.jina.ai only fetches the page for us (it allows cross-site requests); we ask for the page's HTML and pick
   the story out ourselves: site rules for BBC / NPR / CNN, Mozilla Readability for anything else,
   and jina's own markdown as the last resort. */
const RULES = {
  BBC: '[data-component="text-block"] p, [data-component="text-block"] li, [data-component="subheadline-block"] :is(h2, h3)',
  NPR: '#storytext > p, #storytext > :is(h2, h3), #storytext > ul > li, .paragraphs-container > p, .paragraphs-container > :is(h2, h3)',
  CNN: '.article__content :is(p.paragraph, h2, h3), .article__content .list li',
};
const NOISE = 'script, style, noscript, template, svg, iframe, figure, figcaption, aside, nav, form, button, [aria-hidden="true"], '
  + '[data-component="image-block"], [data-component="links-block"], [data-component="tag-list"], [data-component="byline-block"], [data-component="media-block"], [data-component="video-block"], '
  + '.caption, .credit, .image-caption, .related, .newsletter, .social-share';
const JUNK = /^(image source|image caption|getty images|share|save|related|more on this story|listen|watch|follow|sign up|advertisement|copyright|read more|this article|top stories|you may also)(?=[\s:]|$)/i;
const tidy = t => t.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
const words = paras => paras.reduce((n, p) => n + (p.h ? 0 : p.t.split(/\s+/).length), 0);
function pick(nodes) {
  const out = [], seen = new Set();
  for (const n of nodes) {
    if (n.closest("li") && n.tagName !== "LI") continue; // a <p> inside a list item is read through the <li>
    const t = tidy(n.textContent || ""); if (!t || seen.has(t) || (t.length < 80 && JUNK.test(t))) continue; seen.add(t);
    out.push(/^H[1-6]$/.test(n.tagName) ? { h: true, t } : { t });
  }
  while (out.length && out[out.length - 1].h) out.pop();
  return out;
}
let readabilityP;
function loadReadability() {
  return readabilityP ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js"; s.onload = ok; s.onerror = no; document.head.append(s) });
}
async function extract(html, it) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = tidy(doc.querySelector("article h1, main h1, h1")?.textContent || doc.querySelector('meta[property="og:title"]')?.content || it.title);
  if (RULES[it.source]) {
    const d = doc.cloneNode(true); d.querySelectorAll(NOISE).forEach(n => n.remove());
    const paras = pick(d.querySelectorAll(RULES[it.source]));
    // A site rule that finds the story wins even when it is short: Readability would pull in transcripts and promos.
    if (paras.filter(p => !p.h).length >= 2 && words(paras) >= 25) return { title, paras, rule: true };
  }
  try {
    await loadReadability();
    const r = new window.Readability(doc.cloneNode(true), { charThreshold: 300 }).parse();
    if (r?.content) {
      const d = new DOMParser().parseFromString(r.content, "text/html"); d.querySelectorAll(NOISE).forEach(n => n.remove());
      const paras = pick(d.querySelectorAll("p, h2, h3, li"));
      if (words(paras) >= 60) return { title: r.title ? tidy(r.title) : title, paras };
    }
  } catch { }
  return null;
}
// Last resort: jina's markdown, minus obvious boilerplate.
// Everything from the first "More stories" / "Popular" / cookie block onwards is page furniture, not the story.
const END = /^(more stories from|popular on|related stories|more from|editors'? picks|read (&|and) listen|cookie settings|top stories|you may also like)/i;
function clean(md) {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1").replace(/(\*{1,3})([^*\n]+)\1/g, "$2")
    .split(/\n\s*\n/).map(b => b.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)
    .map(b => { const h = b.match(/^#{1,6}\s+(.*)/); return h ? { h: true, t: h[1].trim() } : { t: b.replace(/^[-*>]\s+/, "") } })
    .filter((p, i, all) => !all.slice(0, i + 1).some(q => END.test(q.t)))
    .filter(p => p.t && !(p.t.length < 80 && JUNK.test(p.t)) && !/\[x\]| \* .* \* /.test(p.t) && !/^https?:\/\//.test(p.t) && !/^[=\-_|\s]+$/.test(p.t)
      && (p.h || p.t.split(/\s+/).length >= 6 || /[.!?"”')]$/.test(p.t)));
}
async function jina(url, headers) {
  const res = await fetch("https://r.jina.ai/" + url, { headers: { Accept: "application/json", "X-Retain-Images": "none", ...headers } });
  if (!res.ok) { const e = new Error("http"); e.status = res.status; throw e }
  return (await res.json()).data || {};
}
// Raw page HTML from a few public pass-through services; each one sometimes returns a cut or different page,
// so ask them all at once and keep whichever yields the longest story.
// NPR's text-only site serves just the story: npr.org/2026/11/03/nx-s1-6005523/slug → text.npr.org/nx-s1-6005523
const textNpr = url => { const m = url.match(/npr\.org\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+)\//i); return m ? "https://text.npr.org/" + m[1] : null };
const SOURCES = [
  async url => { const d = await jina(url, { "X-Return-Format": "html" }); return [d.html, d.content].find(x => typeof x === "string" && x.includes("<")) || "" },
  async url => { const r = await fetch("https://corsproxy.io/?url=" + encodeURIComponent(url)); if (!r.ok) throw Object.assign(new Error("http"), { status: r.status }); return r.text() },
  async url => { const r = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url)); if (!r.ok) throw Object.assign(new Error("http"), { status: r.status }); return r.text() },
];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
async function fetchArticle(it) {
  const cache = "englishDesk.read5:" + it.link;
  try { const c = sessionStorage.getItem(cache); if (c) return JSON.parse(c) } catch { }
  const urls = [it.link, ...(it.source === "NPR" && textNpr(it.link) ? [textNpr(it.link)] : [])];
  const got = await Promise.allSettled(urls.flatMap(u => SOURCES.map(src => withTimeout(src(u).then(html => html && extract(html, it)), 20000))));
  const ok = got.map(g => g.status === "fulfilled" ? g.value : null).filter(Boolean), byLen = (x, y) => words(y.paras) - words(x.paras);
  let out = ok.filter(o => o.rule).sort(byLen)[0] || ok.sort(byLen)[0] || null;
  if (out) out = { title: out.title, paras: out.paras };
  const busy = got.some(g => g.reason?.status === 429);
  if (!out) {
    try {
      const d = await jina(it.link, {}), paras = clean(d.content || "");
      if (paras.filter(p => !p.h).length >= 3) out = { title: d.title || it.title, paras };
    } catch { }
  }
  if (!out) throw new Error(busy ? "抓文章的服務暫時太忙，等 1 分鐘再試，或直接貼上文章。" : "抓不到這篇文章的內文，可以打開原文複製後貼上。");
  try { sessionStorage.setItem(cache, JSON.stringify(out)) } catch { }
  return out;
}

/* ---------- rendering: every word is a tappable span ---------- */
const WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
let saved = new Set();
function wordify(el, text) {
  let i = 0;
  for (const m of text.matchAll(WORD)) {
    if (m.index > i) el.append(text.slice(i, m.index));
    const s = document.createElement("span"); s.className = "rw"; s.textContent = m[0];
    const ex = m[0].length > 2 ? examsOf(m[0]) : [];
    if (ex.length) s.dataset.exams = ex.join(" ");
    if (saved.has(m[0].toLowerCase())) s.classList.add("saved");
    el.append(s); i = m.index + m[0].length;
  }
  if (i < text.length) el.append(text.slice(i));
}
let current = null;
function renderArticle(art, it) {
  current = { ...art, it };
  saved = new Set((ED()?.words() || []).map(w => w.toLowerCase()));
  $("readTitle").replaceChildren(); wordify($("readTitle"), art.title);
  $("readMeta").textContent = it ? it.source + " · 內文由瀏覽器當場抓取，只存在這次瀏覽" : "你貼上的文章";
  $("readSrc").hidden = !it; if (it) $("readSrc").href = it.link;
  const body = $("readBody"); body.replaceChildren();
  for (const p of art.paras) { const el = document.createElement(p.h ? "h3" : "p"); wordify(el, p.t); body.append(el) }
  renderLegend();
  $("readBox").hidden = false; $("pasteBox").hidden = true; closeLook();
}

// Which exam lists to underline: the reader picks any combination (or none); remembered per browser.
let shown = new Set(EXAMS.map(([k]) => k));
try { const v = JSON.parse(localStorage.getItem("englishDesk.examShow")); if (Array.isArray(v)) shown = new Set(v) } catch { }
function applyExams() {
  for (const s of document.querySelectorAll("#v-read .rw[data-exams]")) {
    const on = s.dataset.exams.split(" ").filter(k => shown.has(k));
    if (on.length) s.dataset.ex = on[on.length - 1]; else delete s.dataset.ex;
  }
}
function renderLegend() {
  const body = $("readBody"), box = $("readLegend");
  const n = {}; for (const [k] of EXAMS) n[k] = new Set([...body.querySelectorAll(".rw[data-exams]")].filter(s => s.dataset.exams.split(" ").includes(k)).map(s => s.textContent.toLowerCase())).size;
  box.hidden = !EXAMS.some(([k]) => lists[k].size);
  const label = document.createElement("span"); label.className = "muted"; label.textContent = "標示";
  box.replaceChildren(label, ...EXAMS.filter(([k]) => lists[k].size).map(([k, name]) => {
    const b = document.createElement("button"); b.className = "chip"; b.setAttribute("aria-pressed", shown.has(k));
    const sample = document.createElement("span"); sample.className = "rw"; sample.dataset.ex = k; sample.textContent = name;
    b.append(sample, ` ${n[k]}`);
    b.onclick = () => { shown.has(k) ? shown.delete(k) : shown.add(k); try { localStorage.setItem("englishDesk.examShow", JSON.stringify([...shown])) } catch { } b.setAttribute("aria-pressed", shown.has(k)); applyExams() };
    return b }));
  applyExams();
}
async function openReader(it) {
  location.hash = "read";
  $("readBox").hidden = true; $("pasteBox").hidden = true; $("readStatus").hidden = false; $("readStatus").textContent = "抓文章中…";
  try { const art = await fetchArticle(it); $("readStatus").hidden = true; renderArticle(art, it) }
  catch (e) { $("readStatus").textContent = e.message; showPaste(it) }
}
function showPaste(it) {
  $("pasteBox").hidden = false; $("pasteLink").hidden = !it; if (it) $("pasteLink").href = it.link;
  $("pasteArticle").value = ""; $("pasteArticle").dataset.title = it?.title || "";
}
$("pasteRead").onclick = () => {
  const t = $("pasteArticle").value.trim();
  if (t.split(/\s+/).length < 20) { toast("先貼上文章內容"); return }
  const paras = t.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean).map(s => ({ t: s }));
  $("readStatus").hidden = true;
  renderArticle({ title: $("pasteArticle").dataset.title || "貼上的文章", paras }, null);
};
$("readPasteOwn").onclick = () => { $("readStatus").hidden = true; $("readBox").hidden = true; showPaste(null) };

/* ---------- look-up sheet ---------- */
const ALLOW = new Set(["B", "STRONG", "I", "EM", "U", "BR", "P", "DIV", "SPAN", "UL", "OL", "LI", "SUP", "SUB", "SMALL", "TABLE", "TBODY", "TR", "TD", "DETAILS", "SUMMARY", "DL", "DT", "DD", "MARK", "A"]);
function safeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"), out = document.createDocumentFragment();
  const walk = (src, dst) => { for (const n of src.childNodes) {
    if (n.nodeType === 3) dst.append(n.textContent);
    else if (n.nodeType === 1 && ALLOW.has(n.tagName)) {
      const e = document.createElement(n.tagName);
      const cls = (n.getAttribute("class") || "").replace(/[^a-z0-9 _-]/gi, ""); if (cls) e.className = cls;
      if (n.tagName === "DETAILS" && n.hasAttribute("open")) e.open = true;
      if (n.tagName === "A") { const to = (n.getAttribute("href") || "").match(/^entry:\/\/(.+)/); if (to) { e.href = "#read"; e.dataset.entry = decodeURIComponent(to[1]) } }
      walk(n, e); dst.append(e);
    }
    else if (n.nodeType === 1 && !/^(SCRIPT|STYLE|LINK|IMG|AUDIO|VIDEO|OBJECT|IFRAME)$/.test(n.tagName)) walk(n, dst);
  } };
  walk(doc.body, out); return out;
}
/* Built-in dictionary: dict/<first two letters>.json, {word: [phonetic, zh, en, exam tags, owner's notes html] | "@lemma"}.
   Made by scripts/build-dict.py from ECDICT (MIT) plus the owner's own "我的筆記". */
const shards = {};
const shardOf = w => shards[w.slice(0, 2).padEnd(2, "_")] ||= fetch(`dict/${encodeURIComponent(w.slice(0, 2).padEnd(2, "_"))}.json?v=1`).then(r => r.ok ? r.json() : {}).catch(() => { delete shards[w.slice(0, 2).padEnd(2, "_")]; return {} });
async function builtin(w) {
  for (let hop = 0; hop < 3; hop++) {
    const v = (await shardOf(w))[w];
    if (typeof v === "string" && v.startsWith("@")) { w = v.slice(1); continue }
    return Array.isArray(v) ? { head: w, v } : null;
  }
  return null;
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function builtinHtml([ph, zh, en, , notes]) {
  const lines = t => t.split("\n").filter(Boolean).map(l => { const m = l.match(/^([a-z]+\.)\s*(.*)$/); return `<li>${m ? `<span class="pt">${esc(m[1])}</span>` : ""}<span class="${zh === t ? "zh" : "df"}">${esc(m ? m[2] : l)}</span></li>` }).join("");
  return `<div class="rd">${ph ? `<div class="pr"><span>/${esc(ph)}/</span></div>` : ""}`
    + (zh ? `<details class="s" open><summary>中文義</summary><ol class="sn one">${lines(zh)}</ol></details>` : "")
    + (notes ? `<details class="s" open><summary>我的筆記</summary>${notes}</details>` : "")
    + (en ? `<details class="s"><summary>英英釋義</summary><ol class="sn one">${lines(en)}</ol></details>` : "") + "</div>";
}
async function lookUp(word) {
  for (const f of forms(word)) { try { const e = await getEntry(f); if (e) return { ...e, mine: true } } catch { } }
  for (const f of forms(word)) { const e = await builtin(f); if (e) return { head: e.head, html: builtinHtml(e.v), mine: true, builtin: true } }
  try {
    const res = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(forms(word)[0]));
    if (res.ok) {
      const j = await res.json(), e = j[0];
      const lines = e.meanings.slice(0, 3).map(m => `<p><i>${m.partOfSpeech}</i> ${m.definitions.slice(0, 2).map(d => d.definition.replace(/</g, "&lt;")).join(" · ")}</p>`);
      return { head: e.word, html: lines.join(""), mine: false };
    }
  } catch { }
  return null;
}
function sentenceOf(span) {
  const p = span.parentElement.textContent, at = [...span.parentElement.childNodes].slice(0, [...span.parentElement.childNodes].indexOf(span)).reduce((n, x) => n + x.textContent.length, 0);
  const start = Math.max(0, ...[". ", "? ", "! "].map(s => p.lastIndexOf(s, at) + 2).filter(x => x > 1));
  const ends = [". ", "? ", "! "].map(s => p.indexOf(s, at)).filter(x => x >= 0);
  return p.slice(start, ends.length ? Math.min(...ends) + 1 : p.length).trim();
}
let lookSeq = 0, picked = null;
function openLook(span) {
  document.querySelectorAll(".rw.on").forEach(s => s.classList.remove("on")); span.classList.add("on");
  showWord(span.textContent, sentenceOf(span));
}
async function showWord(word, sentence) {
  const seq = ++lookSeq, ex = examsOf(word);
  picked = { word: word.toLowerCase(), sentence: sentence ?? picked?.sentence ?? "", def: "" };
  const setAdd = () => { $("lookAdd").disabled = saved.has(picked.word); $("lookAdd").textContent = $("lookAdd").disabled ? "已在單字本" : "加入單字本" };
  $("lookWord").textContent = word;
  $("lookTags").textContent = ex.map(k => EXAMS.find(e => e[0] === k)[1]).join("・");
  $("lookDef").className = "def"; $("lookDef").innerHTML = '<p class="muted">查詢中…</p>';
  setAdd(); $("look").hidden = false; $("look").scrollTop = 0;
  const r = await lookUp(word);
  if (seq !== lookSeq) return;
  const box = $("lookDef"); box.replaceChildren();
  if (!r) { box.innerHTML = '<p class="muted">字典裡找不到這個字。</p>'; return }
  picked.word = r.head.toLowerCase(); $("lookWord").textContent = r.head;
  box.append(safeHtml(r.html)); box.classList.toggle("mine", r.mine);
  const senses = [...box.querySelectorAll(".zh")].map(e => e.textContent.trim()).filter(Boolean);
  picked.def = (senses.length ? senses.slice(0, 4).join("；") : [...box.querySelectorAll(".df, p")].map(e => e.textContent.trim()).slice(0, 2).join(" · ")).slice(0, 240);
  if (!r.mine) { const n = document.createElement("p"); n.className = "muted"; n.textContent = "字典裡沒有這個字，先用 Free Dictionary 的英英解釋。"; box.append(n) }
  setAdd();
}
function closeLook() { $("look").hidden = true; lookSeq++; document.querySelectorAll(".rw.on").forEach(s => s.classList.remove("on")) }
$("readBody").onclick = $("readTitle").onclick = e => { const s = e.target.closest(".rw"); if (s) openLook(s) };
$("lookClose").onclick = closeLook;
$("lookDef").onclick = e => { const a = e.target.closest("a[data-entry]"); if (!a) return; e.preventDefault(); showWord(a.dataset.entry) };
addEventListener("keydown", e => { if (e.key === "Escape") closeLook() });
addEventListener("hashchange", () => { if (location.hash !== "#read") closeLook() });
$("lookSay").onclick = () => { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance($("lookWord").textContent); u.lang = "en-US"; speechSynthesis.speak(u) } catch { toast("這個瀏覽器不能朗讀") } };
$("lookAdd").onclick = () => {
  if (!picked || !ED()) return;
  const ok = ED().addWord({ word: picked.word, def: picked.def, sentence: picked.sentence, source: current?.it?.source || "" });
  saved.add(picked.word);
  document.querySelectorAll("#v-read .rw").forEach(s => { if (forms(s.textContent).includes(picked.word)) s.classList.add("saved") });
  $("lookAdd").disabled = true; $("lookAdd").textContent = "已在單字本";
  toast(ok ? "加入單字本了，會出現在卡片裡" : "這個字已經在單字本");
};

/* ---------- settings: import dictionary + word lists ---------- */
// Dictionary: english-desk-dict.ndjson.gz (made from the user's MDX; first line is a header, then one [word, html] per line),
// or a small JSON / "word<Tab>definition" file. Read as a stream so a 130 MB dictionary fits on an iPhone.
async function* lines(file) {
  let stream = file.stream();
  if (/\.gz$/i.test(file.name)) {
    if (!("DecompressionStream" in window)) throw new Error("gz");
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  const rd = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += value; const parts = buf.split("\n"); buf = parts.pop();
    yield* parts;
  }
  if (buf) yield buf;
}
async function putBatch(batch) { await idb("entries", "readwrite", s => { for (const [w, d] of batch) s.put(d, w) }) }
async function importDict(file) {
  const status = $("dictStatus"); status.textContent = "讀取中…";
  try {
    let title = file.name, n = 0, batch = [];
    const nd = /\.ndjson(\.gz)?$/i.test(file.name);
    await idb("entries", "readwrite", s => { s.clear() });
    if (nd) {
      let total = 0;
      for await (const line of lines(file)) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (!Array.isArray(j)) { if (j.app === "english-desk-dict") { title = j.title || title; total = j.count || 0 } continue }
        batch.push(j); n++;
        if (batch.length === 5000) { await putBatch(batch); batch = []; status.textContent = total ? `匯入中… ${Math.round(n / total * 100)}%` : `匯入中… ${n}` }
      }
    } else {
      const text = await file.text();
      if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text)) {
        const j = JSON.parse(text);
        const pairs = Array.isArray(j) ? j.map(e => [e.word || e.headword || e[0], e.def || e.definition || e.html || e[1]]) : Object.entries(j);
        for (const [w, d] of pairs) if (w && d) batch.push([String(w).toLowerCase().trim(), String(d)]);
      } else {
        for (const line of text.split(/\r?\n/)) { const m = line.match(/^([^\t,]+)[\t,](.+)$/); if (m) batch.push([m[1].replace(/^"|"$/g, "").toLowerCase().trim(), m[2].replace(/^"|"$/g, "")]) }
      }
      n = batch.length;
    }
    if (batch.length) await putBatch(batch);
    if (!n) throw new Error("empty");
    dictInfo = { name: title, count: n, date: new Date().toLocaleDateString("sv-SE") };
    await setMeta("dict", dictInfo); status.textContent = ""; renderDictStatus(); toast(`字典匯入完成，${n} 筆`);
  } catch (e) {
    status.textContent = ""; renderDictStatus();
    toast(e?.message === "gz" ? "這個瀏覽器不能解壓縮 .gz，請更新瀏覽器" : e?.name === "QuotaExceededError" ? "瀏覽器空間不夠，清一點空間再試" : "讀不懂這個字典檔，請用 english-desk-dict.ndjson.gz");
  }
}
// Exam lists: the combined CSV (word,TOEFL,IELTS,GRE with ✓) or one .txt per exam named TOEFL/IELTS/GRE.
// Phrases ("a calculated crime") are skipped; only single words are underlined.
const one = w => (w = (w || "").trim().toLowerCase().replace(/^﻿/, "")) && /^[a-z]+(?:[-'][a-z]+)*$/.test(w) ? w : "";
async function importLists(files) {
  const got = {};
  for (const f of files) {
    const rows = (await f.text()).replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    const head = rows[0].toLowerCase().split(/[,\t]/).map(x => x.trim());
    if (head[0] === "word" && EXAMS.some(([k]) => head.includes(k))) {
      for (const [k] of EXAMS) { const col = head.indexOf(k); if (col < 0) continue; got[k] = rows.slice(1).map(l => l.split(/[,\t]/)).filter(c => (c[col] || "").trim()).map(c => one(c[0])).filter(Boolean) }
    } else {
      const k = EXAMS.find(([k]) => f.name.toLowerCase().includes(k))?.[0];
      if (k) got[k] = rows.map(l => one(l.split(/[,\t]/)[0])).filter(Boolean);
    }
  }
  const keys = Object.keys(got).filter(k => got[k].length);
  if (!keys.length) { toast("讀不懂這個清單，請用總表 CSV，或檔名含 TOEFL／IELTS／GRE 的文字檔"); return }
  if (builtinLists) { for (const [k] of EXAMS) lists[k] = new Set(); builtinLists = false }
  for (const k of keys) { const words = [...new Set(got[k])]; await setMeta("list:" + k, words); lists[k] = new Set(words) }
  renderDictStatus(); toast("匯入了 " + keys.map(k => `${EXAMS.find(e => e[0] === k)[1]} ${lists[k].size}`).join("、"));
  if (current && location.hash === "#read") renderArticle(current, current.it);
}
function renderDictStatus() {
  if (!$("dictInfo")) return;
  $("dictInfo").textContent = dictInfo ? `已匯入「${dictInfo.name}」，${dictInfo.count} 筆（${dictInfo.date}）` : "還沒匯入，目前用內建字典。";
  $("listInfo").textContent = (builtinLists ? "目前用內建清單：" : "已匯入：") + EXAMS.map(([k, n]) => `${n} ${lists[k].size || "—"}`).join("、");
}
$("dictFile").onchange = e => { const f = e.target.files[0]; if (f) importDict(f); e.target.value = "" };
$("listFile").onchange = e => { const f = [...e.target.files]; if (f.length) importLists(f); e.target.value = "" };

window.EnglishDeskReader = { open: openReader };
loadMeta();
})();
