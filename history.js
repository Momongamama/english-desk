// History: every speaking and writing session, in full, and the same topic side by side.
//   #history               the list, by month, with a level-by-month table
//   #history/<ts>          one session
//   #history/compare/<ts>  that session next to the time before it on the same topic
// Sessions come from practice.js (IndexedDB). Older sessions that only exist in the short log are shown with what they have.
window.EDHistory = (() => {
const $ = id => document.getElementById(id);
const ED = window.EnglishDesk;
let filter = "all", query = "", cache = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const md = d => String(d || "").slice(5).replace("-", "/");
const mins = s => s >= 60 ? Math.round(s / 60) + " min" : "";
const clock = t => t ? new Date(t).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }) : "";
const weekday = d => new Date(d + "T12:00").toLocaleDateString("en", { weekday: "short" });
const kindTag = type => el("span", "kind " + type, type === "write" ? "Write" : "Speak");
const levelTag = l => el("span", "level", l || "—");
const wordsIn = t => (String(t || "").match(/[A-Za-z’']+/g) || []).length;

// Every speak/write session: full records, plus short logs that have no full record (older entries).
async function sessions() {
  const recs = await EDPractice.all().catch(() => []), map = new Map();
  for (const l of ED.logs()) if (l.type === "speak" || l.type === "write") map.set(l.ts, { ...l, older: true });
  for (const r of recs) if (r.type === "speak" || r.type === "write") map.set(r.ts, { ...(map.get(r.ts) || {}), ...r, older: false });
  return [...map.values()].sort((a, b) => b.ts - a.ts);
}
const sameTopic = (all, s) => all.filter(x => x.type === s.type && x.topic === s.topic).sort((a, b) => a.ts - b.ts);

/* ---------- list ---------- */
// The most common level in a month; a tie goes to the latest session.
function monthLevel(list) {
  const n = {}; let best = "", top = 0;
  for (const s of [...list].sort((a, b) => a.ts - b.ts)) { const l = String(s.level || "").trim().slice(0, 2).toUpperCase(); if (!l) continue; n[l] = (n[l] || 0) + 1; if (n[l] >= top) { top = n[l]; best = l } }
  return best;
}
function renderLevels(all) {
  const months = [3, 2, 1, 0].map(k => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return d.toLocaleDateString("sv-SE").slice(0, 7) });
  const box = $("histLevels"); box.replaceChildren(el("span"));
  for (const m of months) box.append(el("span", "h", new Date(m + "-15").toLocaleDateString("en", { month: "short" })));
  for (const type of ["speak", "write"]) {
    box.append(kindTag(type));
    for (const m of months) { const l = monthLevel(all.filter(s => s.type === type && String(s.date).startsWith(m))); box.append(l ? levelTag(l) : el("span", "none", "—")) }
  }
}
function meta(s, all) {
  const bits = [];
  if (s.type === "speak") bits.push(s.mode === "live" ? "Live" : s.mode === "paste" ? "Pasted" : "");
  else if (s.words || s.text) bits.push((s.words || wordsIn(s.text)) + " words");
  if (mins(s.secs)) bits.push(mins(s.secs));
  if (s.redoOf) { const o = all.find(x => x.ts === s.redoOf); bits.push("Redo of " + (o ? md(o.date) : "last month")) }
  const by = all.find(x => x.redoOf === s.ts); if (by) bits.push("Redone " + md(by.date));
  if (s.older) bits.push(s.type === "write" && s.text ? "Older entry, text and level only" : "Older entry, level only");
  return bits.filter(Boolean).join(" · ");
}
function matches(s) {
  if (filter !== "all" && s.type !== filter) return false;
  if (!query) return true;
  const hay = [s.topic, s.text, s.transcript, s.attempt, s.summary, ...(s.items || []).map(i => i.mine + " " + i.natural), ...(s.changes || []).map(i => i.mine + " " + i.natural)].join("\n").toLowerCase();
  return hay.includes(query);
}
async function renderList() {
  const all = cache = await sessions();
  renderLevels(all);
  for (const b of $("histFilter").querySelectorAll(".chip")) {
    const f = b.dataset.f, n = f === "all" ? all.length : all.filter(s => s.type === f).length;
    b.textContent = { all: "All", speak: "Speak", write: "Write" }[f] + " " + n; b.setAttribute("aria-pressed", f === filter);
  }
  const shown = all.filter(matches), box = $("histItems");
  if (!shown.length) { box.replaceChildren(el("p", "muted", all.length ? "Nothing matches." : "No sessions yet. Every speaking chat and every paragraph you get feedback on will be kept here in full.")) }
  else {
    const out = []; let month = "";
    for (const s of shown) {
      const m = String(s.date).slice(0, 7);
      if (m !== month) { month = m; out.push(el("div", "hist-month", new Date(m + "-15").toLocaleDateString("en", { month: "long", year: "numeric" }).toUpperCase())) }
      const a = el("a", "hist-item"); a.href = "#history/" + s.ts;
      const mid = el("div"), t = el("b", "", s.topic || "(No topic)"); t.lang = "en";
      const line = el("span", "meta"); line.append(kindTag(s.type)); const mt = meta(s, all); if (mt) line.append(el("span", "", mt));
      mid.append(t, line); a.append(el("time", "", md(s.date)), mid, levelTag(s.level)); out.push(a);
    }
    box.replaceChildren(...out);
  }
  const full = all.filter(s => !s.older), size = new Blob([JSON.stringify(full)]).size;
  $("histFoot").textContent = `Text only, no audio. ${all.length} session${all.length === 1 ? "" : "s"} · ${size > 1e6 ? (size / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(size / 1e3)) + " KB"}`
    + (ED.hasSync() ? " · synced to your gist." : " · on this device only. Turn on sync in Settings to keep a copy on GitHub.");
}

/* ---------- one session ---------- */
function back(href, label) { const r = el("div", "row"), a = el("a", "btn small", label); a.href = href; r.append(a); return r }
function head(s, extra) {
  const card = el("div", "sheet");
  const eb = [s.type === "write" ? "Write" : "Speak", weekday(s.date) + " " + md(s.date), clock(s.start || s.ts)];
  if (s.type === "speak" && s.mode) eb.push(s.mode === "live" ? "Live" : "Pasted");
  if (s.type === "write" && (s.words || s.text)) eb.push((s.words || wordsIn(s.text)) + " words");
  if (mins(s.secs)) eb.push(mins(s.secs));
  const v = el("div", "verdict spread"), h = el("h2", "", s.topic || "(No topic)"); h.lang = "en"; v.append(h, levelTag(s.level));
  card.append(el("span", "eyebrow", eb.filter(Boolean).join(" · ")), v);
  if (s.ctx && s.ctx.source) { const p = el("p", "muted", "From " + s.ctx.source + (s.ctx.section ? " " + s.ctx.section : "") + " "); if (s.ctx.link) { const a = el("a", "", "Open the story"); a.href = s.ctx.link; a.target = "_blank"; a.rel = "noopener"; p.append(a) } card.append(p) }
  const why = s.type === "write" ? s.why : s.summary; if (why) card.append(el("p", "", why));
  if (s.older) card.append(el("p", "muted", "This session is from before History was added, so only " + (s.type === "write" && s.text ? "your paragraph and the level were" : "the level and summary were") + " kept."));
  if (extra) card.append(...extra);
  return card;
}
function fixes(title, items, source) {
  const card = el("div", "sheet"), box = el("div", "corr");
  card.append(el("h2", "", title), box);
  ED.renderCorr(box, items.map(i => ({ ...i, why: i.why || "" })), source);
  if (items.length) { const r = el("div", "row"), b = el("button", "btn accent", "Save all as cards"); b.onclick = () => ED.saveAll(items, source, box); r.append(b); card.append(r) }
  return card;
}
function transcriptCard(s) {
  const card = el("div", "sheet"), top = el("div", "row"); top.style.justifyContent = "space-between";
  top.append(el("h2", "", "Transcript"), el("span", "muted", (s.words || wordsIn(s.transcript)) + " words")); card.append(top);
  const lines = String(s.transcript).split("\n").filter(l => l.trim());
  const live = lines.every(l => /^(ME|PARTNER): /.test(l));
  const body = el("div", live ? "chat" : "transcript"); body.lang = "en";
  const draw = n => {
    if (live) body.replaceChildren(...lines.slice(0, n).map(l => { const me = l.startsWith("ME: "); return el("div", "msg " + (me ? "me" : "ai"), l.replace(/^(ME|PARTNER): /, "")) }));
    else body.textContent = lines.slice(0, n).join("\n");
  };
  const FEW = live ? 4 : 8; draw(FEW); card.append(body);
  if (lines.length > FEW) { const m = el("button", "link", "Show the whole transcript ▾"); m.onclick = () => { draw(lines.length); m.remove() }; card.append(m) }
  return card;
}
function writing(s) {
  const views = [["Mine", s.text], ["C1 version", s.rewrite], ["My rewrite", s.attempt]].filter(v => v[1]);
  if (!views.length) return [];
  const chips = el("div", "row"), body = el("div", "essay-text"), note = el("p", "muted"); body.lang = "en";
  const pick = k => { const [name, text] = views[k];
    chips.querySelectorAll(".chip").forEach((c, i) => c.setAttribute("aria-pressed", i === k));
    body.className = name === "C1 version" ? "rewrite" : "essay-text"; body.textContent = text;
    note.textContent = name === "My rewrite" ? "Written with the C1 version hidden" + (mins(s.attemptSecs) ? ", in " + mins(s.attemptSecs) : "") + "." : ""; note.hidden = !note.textContent };
  views.forEach(([name], k) => { const c = el("button", "chip", name); c.onclick = () => pick(k); chips.append(c) });
  pick(0);
  return views.length > 1 ? [chips, body, note] : [body];
}
function actions(s, all) {
  const r = el("div", "row"), others = sameTopic(all, s);
  if (s.topic) { const b = el("button", "btn", "Redo this topic"); b.onclick = () => ED.startRedo(s); r.append(b) }
  if (others.length > 1) { const a = el("a", "btn", `Compare (${others.length} times)`); a.href = "#history/compare/" + s.ts; r.append(a) }
  const d = el("button", "btn small red", "Delete");
  d.onclick = () => {
    if (!d.dataset.armed) { d.dataset.armed = 1; d.textContent = "Delete for sure?"; setTimeout(() => { delete d.dataset.armed; d.textContent = "Delete" }, 3000); return }
    ED.deleteSession(s.ts); ED.toast("Deleted"); location.hash = "history";
  };
  r.append(d); return r;
}
async function renderOne(ts) {
  const all = cache = await sessions(), s = all.find(x => x.ts === ts), box = $("histDetail");
  if (!s) { box.replaceChildren(back("#history", "← History"), el("p", "muted", "This session isn't here any more. It may have been deleted on another device.")); return }
  const parts = [back("#history", "← History")];
  if (s.type === "speak") {
    parts.push(head(s, s.compare ? [el("div", "habit", "Compared with last time: " + s.compare)] : null));
    if (s.items && s.items.length) parts.push(fixes(s.items.length === 5 ? "5 things to fix" : "Things to fix", s.items, "speak"));
    if (s.transcript) parts.push(transcriptCard(s));
  } else {
    parts.push(head(s, writing(s)));
    const extra = [];
    if (s.changes && s.changes.length) parts.push(fixes("Changes", s.changes, "write"));
    if (s.habit) extra.push(el("div", "habit", "Habit to fix: " + s.habit));
    if (s.compare) extra.push(el("div", "habit", "Compared with last time: " + s.compare));
    if (extra.length) { const c = el("div", "sheet"); c.append(...extra); parts.push(c) }
  }
  parts.push(actions(s, all));
  box.replaceChildren(...parts);
}

/* ---------- same topic, side by side ---------- */
const norm = t => String(t || "").toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
async function renderCompare(ts) {
  const all = cache = await sessions(), s = all.find(x => x.ts === ts), box = $("histDetail");
  if (!s) { location.hash = "history"; return }
  const list = sameTopic(all, s); let i = list.indexOf(s); if (i === 0) i = 1;
  const a = list[i - 1], b = list[i];
  const parts = [back("#history/" + ts, "← Back")];
  if (!a || !b) { parts.push(el("p", "muted", "You've only done this topic once so far.")); box.replaceChildren(...parts); return }
  const card = el("div", "sheet"), t = el("h2", "", s.topic); t.lang = "en";
  card.append(el("span", "eyebrow", `Same topic · ${list.length} times`), t);
  const days = Math.round((b.ts - a.ts) / 864e5), diff = ED.cefrDiff(a.level, b.level);
  const lv = el("div", "row"); lv.append(levelTag(a.level), el("span", "", "→"), levelTag(b.level), el("span", "muted", [diff, days >= 14 ? `in ${Math.round(days / 7)} weeks` : `in ${days} day${days === 1 ? "" : "s"}`].filter(Boolean).join(" ")));
  card.append(lv);
  if (list.length > 2) {
    const nav = el("div", "row");
    const step = (label, k) => { const c = el("button", "chip", label); c.disabled = !list[k]; c.onclick = () => { location.hash = "history/compare/" + list[k].ts }; return c };
    const mid = el("button", "chip", md(a.date) + " vs " + md(b.date)); mid.setAttribute("aria-pressed", "true");
    nav.append(step("Older", i - 1 >= 1 ? i - 1 : -1), mid, step("Newer", i + 1 < list.length ? i + 1 : -1)); card.append(nav);
  }
  const col = (x, last) => {
    const c = el("div", "cmp-col"), h = el("div", "verdict"); h.append(el("h3", "", md(x.date)), levelTag(x.level)); c.append(h);
    if (x.type === "write") { const p = el("p", "cmp-text", x.text || "(The text of this older entry wasn't saved.)"); p.lang = "en"; c.append(p) }
    else {
      if (x.summary) c.append(el("p", "muted", x.summary));
      if (x.items && x.items.length) { const l = el("div", "cmp-list"); for (const it of x.items) { const p = el("p", last ? "" : "c-mine", last ? it.natural : it.mine); p.lang = "en"; l.append(p) } c.append(l) }
    }
    return c;
  };
  const grid = el("div", "cmp"); grid.append(col(a, false), col(b, true)); card.append(grid);
  if (b.compare && b.redoOf === a.ts) card.append(el("div", "habit", "AI: " + b.compare));
  parts.push(card);
  // Mistakes that came back: the same correction (or the same slip) in both sessions.
  const fx = x => x.type === "write" ? x.changes || [] : x.items || [];
  const back2 = fx(b).filter(n => fx(a).some(o => (norm(o.natural) && norm(o.natural) === norm(n.natural)) || (norm(o.mine) && norm(o.mine) === norm(n.mine))));
  if (back2.length) {
    const c = el("div", "sheet"), corr = el("div", "corr"); c.append(el("h2", "", "Mistakes that came back"), corr);
    ED.renderCorr(corr, back2.map(n => ({ ...n, why: `Seen ${md(a.date)} and ${md(b.date)}.` })), b.type); parts.push(c);
  }
  box.replaceChildren(...parts);
}

/* ---------- routing ---------- */
function render() {
  const h = location.hash.slice(1).split("/");
  if (h[0] !== "history") return;
  const one = h[1] === "compare" ? +h[2] : +h[1];
  $("histList").hidden = !!one; $("histDetail").hidden = !one;
  (h[1] === "compare" ? renderCompare(one) : one ? renderOne(one) : renderList()).catch(() => { });
  if (one) scrollTo(0, 0);
}
addEventListener("hashchange", render);
$("histFilter").onclick = e => { const b = e.target.closest(".chip"); if (!b) return; filter = b.dataset.f; renderList() };
let qT; $("histSearch").oninput = () => { clearTimeout(qT); qT = setTimeout(() => { query = $("histSearch").value.trim().toLowerCase(); renderList() }, 200) };
ED.onSave(() => { if (!$("v-history").hidden && !$("histList").hidden) renderList() });
render();
return { refresh: () => { if (!$("v-history").hidden) render() } };
})();
