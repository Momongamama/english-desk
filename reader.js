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

const EXAMS = [["toefl", "TOEFL", "T"], ["ielts", "IELTS", "I"], ["gre", "GRE", "G"]];
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
  // Older BBC pages mark blocks with data-component; the current ones don't, so also read every <p>/<h2> in the
  // article (or main) in order, and stop at "More on this story" / "Related topics" (see END and pick()).
  BBC: '[data-component="text-block"] p, [data-component="text-block"] li, [data-component="subheadline-block"] :is(h2, h3), article :is(p, h2, h3), main :is(p, h2, h3), main ul > li:not(:has(p, h2, h3, article, a))',
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
  const out = [], seen = new Set(), all = new Set(nodes);
  for (const n of nodes) {
    // A <p> inside a list item that is itself picked is read through the <li>. BBC live pages put every post in
    // an <li>, and those <li>s aren't picked, so their paragraphs must stay.
    const li = n.closest("li"); if (li && li !== n && all.has(li)) continue;
    if (n.closest?.("a, figure, figcaption, nav, footer, aside")) continue; // teaser cards, captions, menus
    const t = tidy(n.textContent || "").replace(/, external(?=[,.;]|$)/g, ""); // BBC's hidden "external link" label
    if (FOLLOW.test(t)) continue;
    if (t.length < 80 && END.test(t)) break; // "More on this story", "Related topics"… the story is over
    if (!t || seen.has(t) || (t.length < 80 && JUNK.test(t))) continue; seen.add(t);
    out.push(/^H[1-6]$/.test(n.tagName) ? { h: true, t } : { t });
  }
  while (out.length && out[out.length - 1].h) out.pop();
  return out;
}
let readabilityP;
function loadReadability() {
  return readabilityP ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js"; s.onload = ok; s.onerror = no; document.head.append(s) });
}
// BBC (and its World Service sites) ship the whole story as JSON in <script id="__NEXT_DATA__">: blocks of
// type "text" → "paragraph" (text in model.text), "subheadline", "image", "links"... The HTML can be split or
// reordered (Firefox Reader View hits the same problem), so read the JSON when it is there.
// Pick the "blocks" array holding the most paragraph words: that is the article, not related-story teasers.
const SKIP_BLOCKS = /image|caption|video|media|links|related|promo|byline|timestamp|^headline$|tag|social|embed|mpu|wsoj|advert/i;
function paragraphsOf(block, heading) {
  const out = [];
  const walk = (b, h) => {
    if (!b || typeof b !== "object" || SKIP_BLOCKS.test(b.type || "")) return;
    const isH = h || /subheadline|heading|crosshead/i.test(b.type || "");
    if (b.type === "paragraph" && typeof b.model?.text === "string") { const t = tidy(b.model.text); if (t) out.push(isH ? { h: true, t } : { t }); return }
    if (b.type === "listItem" && typeof b.model?.text === "string") { const t = tidy(b.model.text); if (t) out.push({ t }); return }
    for (const c of b.model?.blocks || []) walk(c, isH);
  };
  walk(block, heading);
  return out;
}
// BBC splits a story into several block lists (one per section, around images and subheadings), so gather
// every paragraph in document order instead of trusting one list; skip teaser areas and repeated text.
const SKIP_KEYS = /related|promo|onward|mostread|most_read|recommend|topstories|features|teaser|navigation|footer|header|seo|metadata/i;
function fromNextData(doc) {
  const raw = doc.querySelector("script#__NEXT_DATA__")?.textContent;
  if (!raw) return null;
  let data; try { data = JSON.parse(raw) } catch { return null }
  const found = [], seen = new Set();
  const visit = (v, key) => {
    if (!v || typeof v !== "object" || seen.has(v) || SKIP_KEYS.test(key || "")) return; seen.add(v);
    if (!Array.isArray(v) && v.type === "text" && v.model?.blocks) { found.push(...paragraphsOf(v)); return }
    if (!Array.isArray(v) && /subheadline|crosshead/i.test(v.type || "")) { found.push(...paragraphsOf(v, true)); return }
    if (!Array.isArray(v) && SKIP_BLOCKS.test(v.type || "")) return;
    if (Array.isArray(v)) v.forEach(x => visit(x, key)); else for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(data, "");
  const paras = pick(found.map(p => ({ tagName: p.h ? "H3" : "P", textContent: p.t, closest: () => null })));
  return words(paras) >= 25 ? paras : null;
}
// Returns the best guess plus a note of what each method found, shown under the article for troubleshooting.
async function extract(html, it) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = tidy(doc.querySelector("article h1, main h1, h1")?.textContent || doc.querySelector('meta[property="og:title"]')?.content || it.title);
  const found = { json: fromNextData(doc), rule: null, readability: null };
  if (RULES[it.source]) {
    const d = doc.cloneNode(true); d.querySelectorAll(NOISE).forEach(n => n.remove());
    const paras = pick(d.querySelectorAll(RULES[it.source]));
    if (paras.filter(p => !p.h).length >= 2 && words(paras) >= 25) found.rule = paras;
  }
  // NPR/CNN: a site rule beats Readability, which drags in transcripts and promos. BBC: its HTML is unreliable
  // (Firefox Reader View shows half a story too), so let all three methods compete there.
  const needReadability = it.source === "BBC" || !(found.json || found.rule);
  if (needReadability) {
    try {
      await loadReadability();
      const r = new window.Readability(doc.cloneNode(true), { charThreshold: 300 }).parse();
      if (r?.content) {
        const d = new DOMParser().parseFromString(r.content, "text/html"); d.querySelectorAll(NOISE).forEach(n => n.remove());
        const paras = pick(d.querySelectorAll("p, h2, h3, li"));
        if (words(paras) >= 60) found.readability = paras;
      }
    } catch { }
  }
  const note = { bytes: html.length, nextData: !!doc.querySelector("script#__NEXT_DATA__"), ps: doc.querySelectorAll("article p").length + "/" + doc.querySelectorAll("main p").length + "/" + doc.querySelectorAll("p").length, ...Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v ? words(v) : 0])) };
  const order = it.source === "BBC" ? ["json", "rule", "readability"] : ["json", "rule"];
  let best = order.map(k => found[k]).filter(Boolean).sort((x, y) => words(y) - words(x))[0];
  const rule = !!best;
  if (!best) best = found.readability;
  if (!best) return { note };
  return { title, paras: best, rule, note, via: Object.keys(found).find(k => found[k] === best) };
}
// Last resort: jina's markdown, minus obvious boilerplate.
// Everything from the first "More stories" / "Popular" / cookie block onwards is page furniture, not the story.
const FOLLOW = /^follow (bbc|us|npr|cnn)\b/i; // "Follow BBC Hereford & Worcester on BBC Sounds, Facebook…"
const END = /^(more stories from|popular on|related stories|related topics|related internet links|more on this story|more from|elsewhere (on|in) the bbc|most read|editors'? picks|read (&|and) listen|cookie settings|top stories|you may also like)/i;
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
const SOURCE_NAMES = ["jina", "corsproxy", "allorigins"];
// Like Promise.allSettled, but once one source gives a full story (site rule, 150+ words) wait only GRACE ms
// more for the others, instead of up to 20 s for a slow or hanging service. Unfinished ones come back "pending".
const GRACE = 1500, full = v => v?.rule && words(v.paras) >= 150;
function settleFast(ps) {
  return new Promise(done => {
    const got = ps.map(() => ({ status: "pending" })); let left = ps.length, timer = null;
    const finish = () => { clearTimeout(timer); done(got.map(g => ({ ...g }))) };
    ps.forEach((p, i) => p.then(value => { got[i] = { status: "fulfilled", value }; if (full(value) && !timer) timer = setTimeout(finish, GRACE) },
      reason => { got[i] = { status: "rejected", reason } })
      .finally(() => { if (--left === 0) finish() }));
  });
}
async function fetchArticle(it) {
  const cache = CACHE + it.link;
  try { const c = sessionStorage.getItem(cache); if (c) return JSON.parse(c) } catch { }
  const urls = [it.link, ...(it.source === "NPR" && textNpr(it.link) ? [textNpr(it.link)] : [])];
  const jobs = urls.flatMap(u => SOURCES.map((src, i) => ({ name: SOURCE_NAMES[i] + (u === it.link ? "" : " (text.npr.org)"), run: () => withTimeout(src(u).then(html => html ? extract(html, it) : { note: { bytes: 0 } }), 20000) })));
  const got = await settleFast(jobs.map(j => j.run()));
  const log = got.map((g, i) => {
    const v = g.status === "fulfilled" ? g.value : null, ps = v?.paras;
    return { source: jobs[i].name, error: g.status === "rejected" ? (g.reason?.status || g.reason?.message || "error") : g.status === "pending" ? "skipped (already had the full story)" : "", skipped: g.status === "pending", via: v?.via || "", ...(v?.note || {}),
      first: ps ? ps.find(p => !p.h)?.t.split(" ").slice(0, 6).join(" ") : "", last: ps ? [...ps].reverse().find(p => !p.h)?.t.split(" ").slice(-6).join(" ") : "" };
  });
  const ok = got.map(g => g.status === "fulfilled" && g.value?.paras ? g.value : null).filter(Boolean), byLen = (x, y) => words(y.paras) - words(x.paras);
  let out = ok.filter(o => o.rule).sort(byLen)[0] || ok.sort(byLen)[0] || null;
  if (out) out = { title: out.title, paras: out.paras };
  const busy = got.some(g => g.reason?.status === 429);
  if (!out) {
    try {
      const d = await jina(it.link, {}), paras = clean(d.content || "");
      log.push({ source: "jina markdown", words: words(paras) });
      if (paras.filter(p => !p.h).length >= 3) out = { title: d.title || it.title, paras };
    } catch (e) { log.push({ source: "jina markdown", error: e.status || e.message }) }
  }
  lastLog = log;
  if (!out) throw new Error(busy ? "The article service is busy. Wait a minute and try again, or paste the article." : "Couldn't get this article's text. Open the original, copy it and paste it here.");
  out.log = log;
  try { sessionStorage.setItem(cache, JSON.stringify(out)) } catch { }
  return out;
}
let lastLog = [];
// The fetch log is no longer shown on the page; it goes to the browser console for debugging.
function renderLog(log) { if (log?.length) console.info("English Desk fetch log", log) }

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
  $("readMeta").textContent = it ? it.source + " · fetched by your browser just now and kept only for this visit" : "Your pasted article";
  $("readSrc").hidden = !it; if (it) $("readSrc").href = it.link;
  const body = $("readBody"); body.replaceChildren();
  for (const p of art.paras) { const el = document.createElement(p.h ? "h3" : "p"); wordify(el, p.t); body.append(el) }
  current.words = it?.link ? artWords(it.link) : [];
  renderArtWords(); renderChick();
  renderLegend(); resetTimer();
  $("readBox").hidden = false; $("pasteBox").hidden = true; closeLook();
}

/* ---------- words from this article + Save to Chicklist ---------- */
// Words added while reading an article are kept per article (key = its link), so they're still there next time it's opened.
// "Save to Chicklist" opens chicklist://note?v=1&… (format agreed with the Chicklist app; change both sides together).
const ART_WORDS = "englishDesk.articleWords", CHICK = "englishDesk.chicklist";
const readJSON = k => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {} } catch { return {} } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { toast("The browser refused to save.") } };
const artWords = link => { const v = readJSON(ART_WORDS)[link]; return Array.isArray(v) ? v : [] };
function keepArtWords() {
  const link = current?.it?.link; if (!link) return;
  const all = readJSON(ART_WORDS);
  if (current.words.length) all[link] = current.words; else delete all[link];
  writeJSON(ART_WORDS, all);
}
const inArticle = w => !!current?.words?.some(x => x.w === w);
function renderArtWords() {
  const list = current.words, box = $("artWords");
  $("artWordsBox").hidden = !list.length;
  box.replaceChildren(...list.map(x => {
    const el = document.createElement("div"); el.className = "c-item";
    const t = document.createElement("div");
    const w = document.createElement("b"); w.textContent = x.w; t.append(w);
    if (x.d) { const d = document.createElement("span"); d.lang = "zh-Hant"; d.textContent = x.d; t.append(d) }
    if (x.s) { const s = document.createElement("span"); s.className = "muted"; s.textContent = x.s; t.append(s) }
    const rm = document.createElement("button"); rm.className = "btn small"; rm.textContent = "Remove";
    rm.setAttribute("aria-label", "Remove " + x.w + " from this article");
    rm.onclick = () => { current.words = current.words.filter(y => y !== x); keepArtWords(); renderArtWords() };
    el.append(t, rm); return el }));
}
const chickSaved = link => readJSON(CHICK)[link];
function renderChick() {
  const link = current?.it?.link, ok = !!link && /^https?:/i.test(link);
  $("chickBox").hidden = !ok; if (!ok) return;
  const at = chickSaved(link);
  $("chickNote").textContent = at ? `✓ Saved to Chicklist on ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Save again to add new words.` : "Needs Chicklist on this iPhone or Mac";
}
function chicklistUrl(art, it, words) {
  const q = new URLSearchParams({
    v: "1",
    title: (art.title || it.title || it.link).slice(0, 300),
    url: it.link,
    source: it.source || "",
    words: JSON.stringify(words.slice(0, 200).map(x => ({ w: x.w, d: x.d || "", s: x.s || "" }))),
    body: art.paras.map(p => (p.h ? "## " : "") + p.t).join("\n\n").slice(0, 200000),
  });
  return "chicklist://note?" + q.toString().replace(/\+/g, "%20");
}
$("chickSave").onclick = () => {
  const it = current?.it; if (!it?.link) return;
  const all = readJSON(CHICK); all[it.link] = new Date().toISOString(); writeJSON(CHICK, all);
  renderChick(); ED()?.markChicklist?.(it.link);
  location.href = chicklistUrl(current, it, current.words);
};

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
  const label = document.createElement("span"); label.className = "muted"; label.textContent = "Show";
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
  $("readBox").hidden = true; $("pasteBox").hidden = true; $("readStatus").hidden = false; $("readStatus").textContent = "Getting the article…";
  try { const art = await fetchArticle(it); $("readStatus").hidden = true; renderArticle(art, it); renderLog(art.log) }
  catch (e) { $("readStatus").textContent = e.message; showPaste(it); renderLog(lastLog) }
}
function showPaste(it) {
  $("pasteBox").hidden = false; $("pasteLink").hidden = !it; if (it) $("pasteLink").href = it.link;
  $("pasteArticle").value = ""; $("pasteArticle").dataset.title = it?.title || "";
}
$("pasteRead").onclick = () => {
  const t = $("pasteArticle").value.trim();
  if (t.split(/\s+/).length < 20) { toast("Paste the article text first."); return }
  const paras = t.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean).map(s => ({ t: s }));
  $("readStatus").hidden = true;
  renderArticle({ title: $("pasteArticle").dataset.title || "Pasted article", paras }, null);
};
// Any article by its address, e.g. a BBC live page that isn't in today's list. Fetched fresh each time.
const CACHE = "englishDesk.read10:"; // bump when extraction changes so old results are dropped
function sourceOf(host) { return /bbc\./.test(host) ? "BBC" : /npr\.org/.test(host) ? "NPR" : /cnn\.com/.test(host) ? "CNN" : host.replace(/^www\./, "") }
$("readUrlGo").onclick = () => {
  let u; try { u = new URL($("readUrl").value.trim()) } catch { toast("Paste the full link (https://…)"); return }
  try { sessionStorage.removeItem(CACHE + u.href) } catch {}
  openReader({ source: sourceOf(u.hostname), link: u.href, title: "" });
};
$("readUrl").onkeydown = e => { if (e.key === "Enter") $("readUrlGo").click() };
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
    + (zh ? `<details class="s" open><summary>Chinese</summary><ol class="sn one">${lines(zh)}</ol></details>` : "")
    + (notes ? `<details class="s" open><summary>My notes</summary>${notes}</details>` : "")
    + (en ? `<details class="s"><summary>English</summary><ol class="sn one">${lines(en)}</ol></details>` : "") + "</div>";
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
  if (tm.run) tm.lookups++;
  showWord(span.textContent, sentenceOf(span));
}
async function showWord(word, sentence) {
  const seq = ++lookSeq, ex = examsOf(word);
  picked = { word: word.toLowerCase(), sentence: sentence ?? picked?.sentence ?? "", def: "" };
  // A word already in the word list (from another article) can still be added to this article's list.
  const setAdd = () => { const b = $("lookAdd"), inList = saved.has(picked.word), here = !current?.it?.link || inArticle(picked.word);
    b.disabled = inList && here; b.textContent = b.disabled ? "In word list" : inList ? "Add to this article" : "Add to word list" };
  $("lookWord").textContent = word;
  $("lookTags").textContent = ex.map(k => EXAMS.find(e => e[0] === k)[1]).join(" · ");
  $("lookDef").className = "def"; $("lookDef").innerHTML = '<p class="muted">Looking up…</p>';
  setAdd(); $("look").hidden = false; $("look").scrollTop = 0;
  const r = await lookUp(word);
  if (seq !== lookSeq) return;
  const box = $("lookDef"); box.replaceChildren();
  if (!r) { box.innerHTML = '<p class="muted">This word isn\'t in the dictionary.</p>'; return }
  picked.word = r.head.toLowerCase(); $("lookWord").textContent = r.head;
  box.append(safeHtml(r.html)); box.classList.toggle("mine", r.mine);
  const senses = [...box.querySelectorAll(".zh")].map(e => e.textContent.trim()).filter(Boolean);
  picked.def = (senses.length ? senses.slice(0, 4).join("；") : [...box.querySelectorAll(".df, p")].map(e => e.textContent.trim()).slice(0, 2).join(" · ")).slice(0, 240);
  if (!r.mine) { const n = document.createElement("p"); n.className = "muted"; n.textContent = "This word isn't in your dictionary, so here is the English definition from Free Dictionary."; box.append(n) }
  setAdd();
}
function closeLook() { $("look").hidden = true; lookSeq++; document.querySelectorAll(".rw.on").forEach(s => s.classList.remove("on")) }
$("readBody").onclick = $("readTitle").onclick = e => { const s = e.target.closest(".rw"); if (s) openLook(s) };
$("lookClose").onclick = closeLook;
$("lookDef").onclick = e => { const a = e.target.closest("a[data-entry]"); if (!a) return; e.preventDefault(); showWord(a.dataset.entry) };
addEventListener("keydown", e => { if (e.key === "Escape") closeLook() });
addEventListener("hashchange", () => { if (location.hash !== "#read") closeLook() });
$("lookSay").onclick = () => { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance($("lookWord").textContent); u.lang = "en-US"; speechSynthesis.speak(u) } catch { toast("This browser can't read aloud.") } };
$("lookAdd").onclick = () => {
  if (!picked || !ED()) return;
  const ok = ED().addWord({ word: picked.word, def: picked.def, sentence: picked.sentence, source: current?.it?.source || "" });
  saved.add(picked.word);
  if (current && !inArticle(picked.word)) { current.words.push({ w: picked.word, d: picked.def, s: picked.sentence }); keepArtWords(); renderArtWords() }
  document.querySelectorAll("#v-read .rw").forEach(s => { if (forms(s.textContent).includes(picked.word)) s.classList.add("saved") });
  $("lookAdd").disabled = true; $("lookAdd").textContent = "In word list";
  toast(ok === "new" ? "Added to your word list. It will show up in Cards." : ok === "more" ? "This sentence was added to the word's card as another real example." : "Added to this article. It was already in your word list.");
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
  const status = $("dictStatus"); status.textContent = "Reading…";
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
        if (batch.length === 5000) { await putBatch(batch); batch = []; status.textContent = total ? `Importing… ${Math.round(n / total * 100)}%` : `Importing… ${n}` }
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
    await setMeta("dict", dictInfo); status.textContent = ""; renderDictStatus(); toast(`Dictionary imported, ${n} entries`);
  } catch (e) {
    status.textContent = ""; renderDictStatus();
    toast(e?.message === "gz" ? "This browser can't unzip .gz files. Please update your browser." : e?.name === "QuotaExceededError" ? "The browser is out of space. Free some up and try again." : "Couldn't read this dictionary file. Use english-desk-dict.ndjson.gz.");
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
  if (!keys.length) { toast("Couldn't read this list. Use the CSV list, or text files with TOEFL, IELTS or GRE in the name."); return }
  if (builtinLists) { for (const [k] of EXAMS) lists[k] = new Set(); builtinLists = false }
  for (const k of keys) { const words = [...new Set(got[k])]; await setMeta("list:" + k, words); lists[k] = new Set(words) }
  renderDictStatus(); toast("Imported " + keys.map(k => `${EXAMS.find(e => e[0] === k)[1]} ${lists[k].size}`).join(", "));
  if (current && location.hash === "#read") renderArticle(current, current.it);
}
function renderDictStatus() {
  if (!$("dictInfo")) return;
  $("dictInfo").textContent = dictInfo ? `Imported "${dictInfo.name}", ${dictInfo.count} entries (${dictInfo.date})` : "Nothing imported yet, using the built-in dictionary.";
  $("listInfo").textContent = (builtinLists ? "Using the built-in lists: " : "Imported: ") + EXAMS.map(([k, n]) => `${n} ${lists[k].size || "—"}`).join(", ");
}
$("dictFile").onchange = e => { const f = e.target.files[0]; if (f) importDict(f); e.target.value = "" };
$("listFile").onchange = e => { const f = [...e.target.files]; if (f.length) importLists(f); e.target.value = "" };

/* ---------- reading timer, speed check and progress ----------
   Start → read → "I'm done": words per minute from the article's own word count. While she reads, the AI picked for
   "Reading speed" writes 3 quick questions; after them it judges the speed for her level. Each timed read is a log
   of type "read" (synced with everything else); the quiz result and verdict are patched in, with `updated`, when they arrive. */
const LEARNER = "The learner is an adult Taiwanese professional. TOEIC 915 (listening and reading around high B2), aiming for C1. They read English news (BBC, NPR, CNN) on a phone or laptop.";
const MIN_SECS = 20, CHART_MAX = 30;
const tm = { run: false, acc: 0, since: 0, tick: 0, lookups: 0, quiz: null, quizP: null, ts: 0, ctl: null };
const elapsed = () => tm.acc + (tm.run ? Date.now() - tm.since : 0);
const mmss = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") };
const wordsIn = art => art.paras.map(p => p.t).join(" ").match(WORD)?.length || 0;
const articleText = art => art.paras.map(p => (p.h ? "## " : "") + p.t).join("\n\n").slice(0, 14000);
const sp = () => ED() || {};

function drawClock() {
  $("tClock").textContent = mmss(elapsed());
  $("timerBar").classList.toggle("on", tm.run);
}
function resetTimer() {
  clearInterval(tm.tick); tm.ctl?.abort();
  Object.assign(tm, { run: false, acc: 0, since: 0, lookups: 0, quiz: null, quizP: null, ts: 0, ctl: null });
  $("tStart").textContent = "Start timer"; $("tStart").hidden = false; $("tPause").hidden = true;
  $("tNote").textContent = "Time your reading, then see your speed."; $("timerEnd").hidden = true; $("speedBox").hidden = true;
  drawClock();
}
function pauseTimer(note) {
  if (!tm.run) return;
  tm.acc = elapsed(); tm.run = false; clearInterval(tm.tick);
  $("tPause").textContent = "Resume"; $("tNote").textContent = note || "Paused."; drawClock();
}
function resumeTimer() {
  tm.since = Date.now(); tm.run = true; clearInterval(tm.tick); tm.tick = setInterval(drawClock, 1000);
  $("tStart").hidden = true; $("tPause").hidden = false; $("tPause").textContent = "Pause";
  $("tNote").textContent = "Read at your normal pace. Looking up words is fine; pause if you stop for a while.";
  $("timerEnd").hidden = false; $("tEndNote").textContent = ""; drawClock();
}
$("tStart").onclick = () => {
  if (!current) return;
  if (tm.ts || !$("speedBox").hidden) resetTimer();
  $("speedBox").hidden = true; tm.lookups = 0; resumeTimer();
  // Write the questions while she reads, so they're ready the moment she finishes.
  if (sp().speedHasKey?.()) { tm.ctl = new AbortController(); tm.quizP = makeQuiz(current, tm.ctl.signal).then(q => tm.quiz = q, () => tm.quiz = null) }
};
$("tPause").onclick = () => tm.run ? pauseTimer() : resumeTimer();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pauseTimer("Paused while you were away. Tap Resume to go on.") });
addEventListener("hashchange", () => { if (location.hash !== "#read") pauseTimer("Paused while you were on another page."); else renderProgress() });

$("tDone").onclick = async () => {
  const ms = elapsed(); pauseTimer();
  if (ms < MIN_SECS * 1000) { $("tEndNote").textContent = `That was under ${MIN_SECS} seconds, so it won't count. Resume, or start again.`; return }
  const words = wordsIn(current), mins = ms / 60000, wpm = Math.round(words / mins);
  const log = { type: "read", topic: current.title || "Article", link: current.it?.link || "", source: current.it?.source || "pasted",
    words, secs: Math.round(ms / 1000), wpm, lookups: tm.lookups };
  tm.ts = sp().addLog?.(log) || 0;
  $("tPause").hidden = true; $("tStart").hidden = false; $("tStart").textContent = "Time it again";
  $("tNote").textContent = "Saved to your reading progress."; $("timerEnd").hidden = true;
  showResult(log); renderProgress();
  $("speedBox").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!sp().speedHasKey?.()) { $("speedAi").replaceChildren(para("Add a Gemini or Claude key in Settings to get a quick comprehension check and AI feedback on your speed.", "muted")); return }
  $("speedAi").replaceChildren(para("Getting your questions…", "muted"));
  if (!tm.quiz && tm.quizP) await tm.quizP;
  if (!tm.quiz) { try { tm.ctl = new AbortController(); tm.quiz = await makeQuiz(current, tm.ctl.signal) } catch { tm.quiz = null } }
  if (tm.quiz?.length) showQuiz(log); else { $("speedAi").replaceChildren(); judge(log, null) }
};
$("speedVoid").onclick = () => {
  if (!tm.ts) return;
  sp().patchLog?.(tm.ts, { void: true }); tm.ctl?.abort(); tm.ts = 0;
  $("speedBox").hidden = true; $("tNote").textContent = "Removed from your progress."; renderProgress();
};

function para(text, cls) { const p = document.createElement("p"); if (cls) p.className = cls; p.textContent = text; return p }
function scoreBox(n, label) { const d = document.createElement("div"); const b = document.createElement("b"); b.textContent = n; const s = document.createElement("span"); s.textContent = label; d.append(b, s); return d }
function showResult(l) {
  $("speedBox").hidden = false; $("quizBox").hidden = true; $("speedAi").replaceChildren();
  $("speedScores").replaceChildren(scoreBox(l.wpm, "words per minute"), scoreBox(l.words, "words"), scoreBox(mmss(l.secs * 1000), "time"),
    ...(l.lookups ? [scoreBox(l.lookups, l.lookups === 1 ? "word looked up" : "words looked up")] : []));
}

/* ---------- comprehension check ---------- */
async function makeQuiz(art, signal) {
  const sys = `You write a quick comprehension check for an English learner who has just read a news article once at normal speed. ${LEARNER}
Write exactly 3 multiple-choice questions, answerable from memory after one reading: the main point, one key detail that matters to the story, and one about cause, consequence or the writer's angle. Don't ask about exact numbers, dates or names unless they are central. Each has 4 short options, only one clearly right, wrong options plausible. Mix the position of the right answer.
Reply with JSON only: {"questions":[{"q":"…","options":["…","…","…","…"],"answer":0}]}  ("answer" is the 0-based index of the right option).`;
  const r = await sp().speedAi(sys, [{ role: "user", content: `Title: ${art.title}\n\n${articleText(art)}` }], { json: true, signal });
  const qs = (r?.questions || []).filter(q => q && q.q && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
  return qs.slice(0, 3);
}
function showQuiz(log) {
  const box = $("quizBox"), picks = [];
  box.hidden = false; $("speedAi").replaceChildren();
  const intro = para("Quick check from memory. Don't scroll back up.", "muted");
  const sets = tm.quiz.map((q, i) => {
    const fs = document.createElement("fieldset"); const lg = document.createElement("legend"); lg.textContent = `${i + 1}. ${q.q}`; fs.append(lg);
    q.options.forEach((o, k) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = o; b.setAttribute("aria-pressed", "false");
      b.onclick = () => { if (box.dataset.done) return; picks[i] = k; fs.querySelectorAll(".chip").forEach((c, j) => c.setAttribute("aria-pressed", j === k)) };
      fs.append(b) });
    return fs });
  const row = document.createElement("div"); row.className = "row";
  const check = document.createElement("button"); check.className = "btn accent"; check.textContent = "Check my answers";
  const skip = document.createElement("button"); skip.className = "btn"; skip.textContent = "Skip the quiz";
  row.append(check, skip); delete box.dataset.done;
  box.replaceChildren(intro, ...sets, row);
  check.onclick = () => {
    if (tm.quiz.some((_, i) => picks[i] == null)) { toast("Answer all 3 first, or skip the quiz."); return }
    box.dataset.done = 1; row.remove();
    let right = 0;
    tm.quiz.forEach((q, i) => { if (picks[i] === q.answer) right++;
      sets[i].querySelectorAll(".chip").forEach((c, k) => { if (k === q.answer) c.dataset.r = "right"; else if (k === picks[i]) c.dataset.r = "wrong"; c.disabled = k !== q.answer && k !== picks[i] }) });
    intro.textContent = `You got ${right} of ${tm.quiz.length}. The right answers are marked green.`;
    judge(log, { right, of: tm.quiz.length });
  };
  skip.onclick = () => { box.hidden = true; judge(log, null) };
}

/* ---------- the AI's verdict ---------- */
const VERDICT = { speed: "Work on speed", ok: "Good pace", accuracy: "Slow down a little" };
async function judge(log, quiz) {
  const out = $("speedAi"), ts = tm.ts;
  if (quiz) sp().patchLog?.(ts, { quiz: quiz.right, quizOf: quiz.of });
  out.replaceChildren(para(`Asking ${sp().speedAiName?.() || "the AI"} about your speed…`, "muted"));
  const past = history().filter(l => l.ts !== ts).slice(-10).map(l => `${l.date}: ${l.wpm} wpm, ${l.words} words` + (l.quizOf ? `, quiz ${l.quiz}/${l.quizOf}` : "") + (l.lookups ? `, ${l.lookups} lookups` : "")).join("\n") || "(none yet: this is the first timed read)";
  const sys = `You are a reading coach. ${LEARNER}
Judge whether this reading speed needs work, for this learner and this text. Reference points for silent reading of non-fiction: adult native speakers average about 240 words per minute (Brysbaert 2019, range roughly 175–300); a comfortable C1 reader of news is usually around 200–250; under about 150 usually means slow word recognition or vocabulary gaps; well over 300 with weak comprehension means skimming. Adjust for how hard the text is (vocabulary, sentence length, topic) and for words looked up while the timer ran. Comprehension matters more than speed: if the quiz was weak, say so even if the speed is fine. Use the history to say whether the speed is improving, flat or dropping (only if there are at least 3 earlier reads; otherwise say it's too early to tell).
Write in plain, friendly English, short sentences, no emoji, speak to the learner as "you".
Reply with JSON only: {"verdict":"speed"|"ok"|"accuracy","headline":"one sentence","feedback":"2-3 sentences on this read: speed for this text, comprehension, trend","tips":["1-2 concrete things to do next time"]}
verdict: "speed" = reading is slower than it should be for this text, practise reading faster; "ok" = pace and comprehension fit the C1 goal; "accuracy" = too fast for good understanding, slow down.`;
  const user = `This read: ${log.words} words in ${mmss(log.secs * 1000)} = ${log.wpm} wpm. Words looked up while timing: ${log.lookups}. Quiz: ${quiz ? `${quiz.right}/${quiz.of}` : "skipped"}.
Earlier timed reads (oldest first):\n${past}\n\nThe article:\nTitle: ${current.title}\n\n${articleText(current).slice(0, 8000)}`;
  try {
    tm.ctl = new AbortController();
    const r = await sp().speedAi(sys, [{ role: "user", content: user }], { json: true, signal: tm.ctl.signal });
    if (tm.ts !== ts) return;
    const v = VERDICT[r.verdict] ? r.verdict : "ok";
    sp().patchLog?.(ts, { verdict: v });
    const head = document.createElement("div"); head.className = "verdict";
    const tag = document.createElement("span"); tag.className = "tag" + (v === "ok" ? " ok" : ""); tag.textContent = VERDICT[v];
    const h = document.createElement("b"); h.textContent = r.headline || ""; head.append(tag, h);
    const tips = document.createElement("ul"); tips.className = "tips";
    for (const t of (Array.isArray(r.tips) ? r.tips : []).slice(0, 3)) { const li = document.createElement("li"); li.textContent = t; tips.append(li) }
    out.replaceChildren(head, para("✎ " + (r.feedback || "")), ...(tips.children.length ? [tips] : []));
  } catch (e) {
    if (e?.code === "cancelled" || tm.ts !== ts) return;
    out.replaceChildren(para((e?.message || "Something went wrong.") + " Your speed is saved either way.", "muted"));
  } finally { renderProgress() }
}

/* ---------- progress over time ---------- */
const history = () => (sp().logs?.("read") || []).filter(l => !l.void && l.wpm > 0).sort((a, b) => a.ts - b.ts);
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
function renderProgress() {
  const h = history(), box = $("speedProgress");
  box.hidden = !h.length; if (!h.length) return;
  const w = h.map(l => l.wpm), last5 = w.slice(-5), first5 = w.slice(0, 5);
  const quizzed = h.filter(l => l.quizOf).slice(-5);
  const stats = [scoreBox(w.at(-1), "latest wpm"), scoreBox(avg(last5), `average, last ${last5.length}`), scoreBox(h.length, h.length === 1 ? "timed read" : "timed reads")];
  if (h.length >= 6) { const d = avg(last5) - avg(first5); stats.splice(2, 0, scoreBox((d > 0 ? "+" : "") + d, "wpm vs your first 5")) }
  if (quizzed.length) stats.push(scoreBox(Math.round(100 * quizzed.reduce((a, l) => a + l.quiz, 0) / quizzed.reduce((a, l) => a + l.quizOf, 0)) + "%", "quiz, recent"));
  $("speedStats").replaceChildren(...stats);
  $("speedChart").replaceChildren(chart(h.slice(-CHART_MAX)));
  $("speedChartNote").textContent = h.length < 3 ? "Time a few more articles to see a trend." : "Each dot is one timed read. A hollow dot means the quiz went badly (under 2 of 3), so that speed may be too fast to count.";
}
function chart(h) {
  const NS = "http://www.w3.org/2000/svg", W = 360, H = 170, L = 34, R = 12, T = 12, B = 28;
  const el = (n, a, t) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; return e };
  const vals = h.map(l => l.wpm), step = 50;
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 20) / step) * step), hi = Math.ceil((Math.max(...vals) + 20) / step) * step;
  const x = i => h.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (h.length - 1), y = v => T + (hi - v) * (H - T - B) / (hi - lo || 1);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Reading speed for your last ${h.length} timed reads, from ${vals[0]} to ${vals.at(-1)} words per minute` });
  for (let v = lo; v <= hi; v += step) { svg.append(el("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }), el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v)) }
  if (h.length > 1) svg.append(el("polyline", { class: "ln", points: h.map((l, i) => `${x(i)},${y(l.wpm)}`).join(" ") }));
  h.forEach((l, i) => { const c = el("circle", { class: "dot" + (l.quizOf && l.quiz / l.quizOf < .6 ? " low" : ""), cx: x(i), cy: y(l.wpm), r: 5 });
    c.append(el("title", {}, `${l.date} · ${l.wpm} wpm${l.quizOf ? ` · quiz ${l.quiz}/${l.quizOf}` : ""} · ${l.topic || ""}`)); svg.append(c) });
  const fmt = d => new Date(d + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  svg.append(el("text", { x: x(0), y: H - 6, "text-anchor": h.length === 1 ? "middle" : "start" }, fmt(h[0].date)));
  if (h.length > 1) svg.append(el("text", { x: x(h.length - 1), y: H - 6, "text-anchor": "end" }, fmt(h.at(-1).date)));
  return svg;
}
sp().onChange?.(() => { if (location.hash === "#read") renderProgress() });
renderProgress();

// `text` is for History: the story's paragraphs to keep with a speaking or writing session on that headline.
window.EnglishDeskReader = { open: openReader,
  text: async it => { const a = await fetchArticle(it); return { title: a.title, paras: a.paras.map(p => p.h ? { h: true, t: p.t } : { t: p.t }) } } };
loadMeta();
})();
