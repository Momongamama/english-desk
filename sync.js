// Sync across devices through a secret GitHub Gist.
// The user pastes a token that can only touch gists. Opening the site pulls and merges; every save pushes a few seconds later.
// What goes up: cards, practice logs, deletions and non-secret settings, plus every full practice session (History) in one file per month,
// so no single file keeps growing. API keys, the token itself and the private dictionary never leave the browser.
(() => {
const $ = id => document.getElementById(id);
const ED = window.EnglishDesk;
const KEY = "englishDesk.sync", FILE = "english-desk-sync.json", API = "https://api.github.com";
const PUSH_DELAY = 4000, PULL_GAP = 60000;
let s = {}; try { s = JSON.parse(localStorage.getItem(KEY) || "{}") || {} } catch { }
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { } };
let busy = false, again = false, pushT, lastPull = 0, err = "";

class SyncError extends Error { constructor(m, auth) { super(m); this.auth = auth } }
async function gh(path, opt = {}) {
  let r;
  try {
    r = await fetch(API + path, { ...opt, cache: "no-store",
      headers: { Authorization: "Bearer " + s.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
  } catch { throw new SyncError("Can't reach GitHub. Check your connection.") }
  if (r.status === 401) throw new SyncError("GitHub didn't accept the token. It may have expired. Paste a new one.", true);
  if (r.status === 403 || r.status === 404) {
    const m = (await r.json().catch(() => ({}))).message || "";
    if (/rate limit/i.test(m)) throw new SyncError("GitHub asked us to slow down. Sync will try again later.");
    if (r.status === 404 && path.startsWith("/gists/")) return null; // the gist was deleted
    throw new SyncError("This token can't use gists. Make one with the \"gist\" scope.", true);
  }
  if (!r.ok) throw new SyncError("GitHub error " + r.status + ". Sync will try again later.");
  return r.status === 204 ? null : r.json();
}

// Same data always gives the same text, so we can tell whether the gist already has everything.
function canon(d) {
  const sortObj = o => Object.fromEntries(Object.keys(o || {}).sort().map(k => [k, o[k]]));
  return JSON.stringify({ app: "english-desk", version: 2,
    cards: [...(d.cards || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(sortObj),
    logs: [...(d.logs || [])].sort((a, b) => a.ts - b.ts).map(sortObj),
    deleted: sortObj(d.deleted), settings: sortObj(d.settings) });
}
const gistFile = g => g && g.files && g.files[FILE];
const PRACTICE = /^english-desk-practice-(\d{4}-\d{2})\.json$/, practiceFile = m => `english-desk-practice-${m}.json`;
async function fileText(f) {
  if (!f.truncated) return f.content;
  const r = await fetch(f.raw_url, { cache: "no-store" }); if (!r.ok) throw new SyncError("Couldn't download the sync file from GitHub."); return r.text();
}
// Returns { data: the main file, practice: { "2026-11": its text } }, or null when there's no gist yet.
async function readGist() {
  if (!s.gist) return null;
  const g = await gh("/gists/" + s.gist), f = gistFile(g);
  if (!f) { s.gist = ""; keep(); return null }
  const text = await fileText(f), practice = {};
  for (const [name, pf] of Object.entries(g.files)) { const m = name.match(PRACTICE); if (m) practice[m[1]] = await fileText(pf) }
  let data = null; try { const d = JSON.parse(text); data = d && Array.isArray(d.cards) ? d : null } catch { }
  return { data, practice };
}
// One month of full sessions, same text for the same data.
function canonMonth(month, recs) {
  const sortObj = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
  return JSON.stringify({ app: "english-desk", kind: "practice", month, sessions: [...recs].sort((a, b) => a.ts - b.ts).map(sortObj) });
}
// Use the same gist on every device: look for our file before making a new one.
async function findGist() {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = list.find(g => gistFile(g));
    if (hit) return hit.id;
    if (list.length < 100) return "";
  }
  return "";
}

async function sync(why) {
  if (!s.token) return;
  if (busy) { again = true; return }
  busy = true; clearTimeout(pushT); render("Syncing…");
  try {
    if (!s.gist) s.gist = await findGist();
    const got = await readGist(), remote = got && got.data;
    const merged = ED.syncApply(remote);  // merges into this browser and saves it
    const text = canon(merged), files = {};
    if (!remote || canon(remote) !== text) files[FILE] = { content: text };
    // Full sessions: merge every month from the gist, then upload the months that differ.
    const incoming = [];
    for (const t of Object.values(got ? got.practice : {})) { try { const d = JSON.parse(t); if (Array.isArray(d.sessions)) incoming.push(...d.sessions) } catch { } }
    const months = {};
    for (const r of await ED.practiceMerge(incoming)) (months[EDPractice.month(r)] ||= []).push(r);
    for (const m of new Set([...Object.keys(months), ...Object.keys(got ? got.practice : {})])) {
      const t = canonMonth(m, months[m] || []);
      if (!got || got.practice[m] !== t) files[practiceFile(m)] = { content: t };
    }
    if (Object.keys(files).length) {
      if (!s.gist && !files[FILE]) files[FILE] = { content: text }; // a new gist needs the main file
      if (s.gist) await gh("/gists/" + s.gist, { method: "PATCH", body: JSON.stringify({ files }) });
      else s.gist = (await gh("/gists", { method: "POST", body: JSON.stringify({ description: "English Desk sync (cards and practice log)", public: false, files }) })).id;
    }
    s.last = Date.now(); lastPull = s.last; err = ""; keep();
  } catch (e) {
    err = e.message || "Sync failed.";
    if (why === "connect") throw e;
  } finally {
    busy = false; render();
    if (again) { again = false; schedule(500) }
  }
}
function schedule(ms = PUSH_DELAY) { if (!s.token) return; clearTimeout(pushT); pushT = setTimeout(() => sync("push"), ms); render() }

/* ---------- settings card ---------- */
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : new Date(t).toLocaleDateString();
}
function render(msg) {
  const on = !!s.token, tag = $("stSync");
  tag.textContent = !on ? "Off" : err ? "Problem" : "✓ On"; tag.className = "tag" + (!on ? " no" : err ? "" : " ok");
  $("syncOn").hidden = !on; $("syncOff").hidden = on;
  $("syncStatus").textContent = msg || (err ? err : s.last ? "Last synced " + ago(s.last) + (pushT && !busy ? " · changes waiting" : "") : "");
}
$("syncConnect").onclick = async () => {
  const t = $("syncToken").value.trim(), out = $("syncOut");
  if (!t) { out.textContent = "Paste a token first."; return }
  const prev = s; s = { token: t }; out.textContent = "Connecting…"; $("syncConnect").disabled = true;
  try {
    await sync("connect");
    keep(); $("syncToken").value = ""; out.textContent = ""; ED.toast("Sync is on");
  } catch (e) { s = prev; err = ""; out.textContent = e.message }
  finally { $("syncConnect").disabled = false; render() }
};
$("syncNow").onclick = () => sync("manual");
$("syncStop").onclick = () => {
  if (!$("syncStop").dataset.armed) { $("syncStop").dataset.armed = 1; $("syncStop").textContent = "Turn off for sure?"; setTimeout(() => { delete $("syncStop").dataset.armed; $("syncStop").textContent = "Turn off" }, 3000); return }
  clearTimeout(pushT); s = {}; err = ""; try { localStorage.removeItem(KEY) } catch { } render(); ED.toast("Sync is off on this device. Your data here and in the gist are kept.");
};

/* ---------- triggers ---------- */
ED.onSave(() => schedule());
document.addEventListener("visibilitychange", () => {
  if (!s.token) return;
  if (document.visibilityState === "hidden") { if (pushT) sync("leave") }
  else if (Date.now() - lastPull > PULL_GAP) sync("open");
});
addEventListener("online", () => s.token && sync("online"));
setInterval(() => { if (s.last && !busy) render() }, 60000);
render();
if (s.token) sync("open");
})();
