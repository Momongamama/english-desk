// Fetches BBC + CNN RSS (falls back to NPR when CNN is down or stale) and writes news.json.
// Run by .github/workflows/news.yml. No dependencies: Node 20+ has fetch.
import { writeFileSync } from "node:fs";

const SECTIONS = ["business", "tech", "world"];
const FEEDS = {
  BBC: { business: "https://feeds.bbci.co.uk/news/business/rss.xml", tech: "https://feeds.bbci.co.uk/news/technology/rss.xml", world: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  CNN: { business: "http://rss.cnn.com/rss/money_latest.rss", tech: "http://rss.cnn.com/rss/edition_technology.rss", world: "http://rss.cnn.com/rss/edition_world.rss" },
  NPR: { business: "https://feeds.npr.org/1006/rss.xml", tech: "https://feeds.npr.org/1019/rss.xml", world: "https://feeds.npr.org/1004/rss.xml" },
};
const PER_FEED = 6;            // items kept per source per section
const STALE_DAYS = 3;          // a feed whose newest item is older than this counts as dead
const OUT = process.argv[2] || "news.json";

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function clean(s = "") {
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decode = t => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
  // Decode first so escaped HTML (&lt;p&gt;) is also stripped, then decode once more for leftovers.
  return decode(decode(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? clean(m[1]) : "" };
export function oneLine(s, max = 200) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}
export function parseRss(xml) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([it]) => {
    let link = tag(it, "link") || tag(it, "guid");
    link = link.replace(/\?(at_medium|utm_)[^#]*$/, "");
    const date = new Date(tag(it, "pubDate") || tag(it, "dc:date"));
    return { title: tag(it, "title"), summary: oneLine(tag(it, "description")), link, published: isNaN(date) ? null : date.toISOString() };
  }).filter(i => i.title && /^https?:\/\//.test(i.link));
}

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "english-desk-news/1.0 (+https://github.com/Momongamama/english-desk)" }, signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
const fresh = items => items.some(i => i.published && Date.now() - Date.parse(i.published) < STALE_DAYS * 864e5);

async function source(name) {
  const out = [];
  for (const section of SECTIONS) {
    try {
      const items = parseRss(await get(FEEDS[name][section]));
      if (!fresh(items)) { console.warn(`${name} ${section}: no item in the last ${STALE_DAYS} days`); continue }
      items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
      out.push(...items.slice(0, PER_FEED).map(i => ({ ...i, source: name, section })));
    } catch (e) { console.warn(`${name} ${section}: ${e.message}`) }
  }
  return out;
}

async function main() {
  const bbc = await source("BBC");
  let second = await source("CNN");
  // CNN counts as working only if it still delivers at least two of the three sections.
  if (new Set(second.map(i => i.section)).size < 2) { console.warn("CNN unusable, using NPR"); second = await source("NPR") }
  const seen = new Set();
  const items = [...bbc, ...second].filter(i => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true });
  if (items.length < 6) throw new Error(`only ${items.length} items fetched; keeping the old news.json`);
  const sources = [...new Set(items.map(i => i.source))];
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), sources, items }, null, 1) + "\n");
  console.log(`wrote ${items.length} items from ${sources.join(" + ")} to ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1) });
