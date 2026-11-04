// Lists the latest episodes of the shadowing podcasts and writes podcasts.json (titles, dates, mp3 links only; no audio is stored).
// Also checks whether a browser on another site may read each mp3 (CORS), so the page knows whether it can load it directly
// or should ask you to download it first. Run by .github/workflows/news.yml. Node 20+, no dependencies.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { clean, oneLine } from "./fetch-news.mjs";

const SHOWS = [
  { id: "business-daily", name: "Business Daily", by: "BBC World Service", accent: "英國", feed: "https://podcasts.files.bbci.co.uk/p002vsxs.rss" },
  { id: "the-indicator", name: "The Indicator", by: "NPR Planet Money", accent: "美國", feed: "https://feeds.npr.org/510325/podcast.xml" },
];
const PER_SHOW = 6;
const OUT = process.argv[2] || "podcasts.json";
const ORIGIN = "https://momongamama.github.io";
const UA = { "user-agent": "english-desk-podcasts/1.0 (+https://github.com/Momongamama/english-desk)" };

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? clean(m[1]) : "" };
function seconds(d) {
  if (!d) return null; if (/^\d+$/.test(d)) return +d;
  const p = d.split(":").map(Number); return p.some(isNaN) ? null : p.reduce((s, x) => s * 60 + x, 0);
}
export function parseFeed(xml) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([it]) => {
    const enc = it.match(/<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["'][^>]*>/i);
    const date = new Date(tag(it, "pubDate"));
    return { title: tag(it, "title"), summary: oneLine(tag(it, "itunes:summary") || tag(it, "description"), 160),
      url: enc ? enc[1].replace(/&amp;/g, "&") : "", published: isNaN(date) ? null : date.toISOString(), duration: seconds(tag(it, "itunes:duration")) };
  }).filter(i => i.title && /^https:\/\//.test(i.url));
}

// Follow redirects by hand: a browser needs Access-Control-Allow-Origin on every hop, not just the last one.
async function corsOk(url) {
  try {
    for (let hop = 0; hop < 8; hop++) {
      const res = await fetch(url, { headers: { ...UA, origin: ORIGIN, range: "bytes=0-1" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      const acao = res.headers.get("access-control-allow-origin");
      if (acao !== "*" && acao !== ORIGIN) return false;
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location"), url).href; continue }
      return res.ok;
    }
  } catch (e) { console.warn(`cors check ${url}: ${e.message}`) }
  return false;
}

async function show(s) {
  const res = await fetch(s.feed, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${s.feed}`);
  const items = parseFeed(await res.text()).sort((a, b) => (b.published || "").localeCompare(a.published || "")).slice(0, PER_SHOW);
  if (!items.length) throw new Error(`no episodes in ${s.feed}`);
  // Episodes of one show share a host, so checking the newest is enough.
  const cors = await corsOk(items[0].url);
  console.log(`${s.name}: ${items.length} episodes, newest ${items[0].published?.slice(0, 10)}, browser can read mp3: ${cors}`);
  return { id: s.id, name: s.name, by: s.by, accent: s.accent, cors, episodes: items };
}

async function main() {
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { shows: [] };
  const shows = [];
  for (const s of SHOWS) {
    try { shows.push(await show(s)) }
    catch (e) { console.warn(`${s.name}: ${e.message}; keeping the previous list`); const prev = old.shows?.find(x => x.id === s.id); if (prev) shows.push(prev) }
  }
  if (!shows.length) throw new Error("no show fetched; keeping the old podcasts.json");
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), shows }, null, 1) + "\n");
  console.log(`wrote ${shows.length} shows to ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1) });
