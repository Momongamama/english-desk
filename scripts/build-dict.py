"""Build the site's built-in dictionary shards in dict/.

Sources (both allowed in a public repo):
  - ECDICT (MIT, https://github.com/skywind3000/ECDICT): phonetic, short Chinese gloss, WordNet-style English gloss, exam tags, inflections.
  - The owner's own study notes ("我的筆記") taken from their personal MDX. Only that section is kept;
    every other section of the MDX comes from licensed dictionaries and must never be committed.

Usage: python3 scripts/build-dict.py ecdict.csv [mdx-export.txt] [exam-words.csv]
  exam-words.csv: the owner's list, header word,TOEFL,IELTS,GRE with a mark in each exam column.
  When given, dict/_exam.json uses it instead of ECDICT's exam tags (phrases are skipped).
Output: dict/<first two letters>.json, each {word: [phonetic, zh, en, tags, notes_html] | "@lemma"}
"""
import csv, json, os, re, sys, collections
import opencc

cc = opencc.OpenCC("s2twp")
WORD = re.compile(r"^[a-z]+(?:[-'][a-z]+)*$")
TAGS = {"toefl": "t", "ielts": "i", "gre": "g"}

def gloss(text, n):
    lines = [l.strip() for l in (text or "").replace("\\n", "\n").split("\n") if l.strip()]
    keep = [l for l in lines if not l.startswith("[网络]") and not l.startswith("[網路]")] or lines
    return "\n".join(keep[:n])

notes = {}
if len(sys.argv) > 2:
    raw = open(sys.argv[2], encoding="utf-8").read()
    for rec in raw.split("\n</>\n"):
        head, _, body = rec.strip().partition("\n")
        m = re.search(r'<details class="s"[^>]*><summary>我的筆記</summary>(.*?)</details>', body, re.S)
        if m and WORD.match(head.strip().lower()):
            # English-only 詞源 lines are quoted from Merriam-Webster, so they are dropped; the owner's Chinese ones stay.
            html = re.sub(r"<dt>詞源</dt><dd[^>]*>([^<]*)</dd>", lambda e: e.group(0) if re.search(r"[\u4e00-\u9fff]", e.group(1)) else "", m.group(1).strip())
            if "<dd" in html: notes.setdefault(head.strip().lower(), html)

entries, forms = {}, {}
csv.field_size_limit(10**8)
with open(sys.argv[1], encoding="utf-8") as f:
    for r in csv.DictReader(f):
        w = r["word"].strip()
        if not WORD.match(w): continue  # lower-case single words only (skips names and phrases)
        useful = int(r["frq"] or 0) > 0 or int(r["bnc"] or 0) > 0 or r["tag"] or r["collins"] or r["oxford"] or w in notes
        if not useful: continue
        zh = cc.convert(gloss(r["translation"], 4))
        if not zh and w not in notes: continue
        tags = "".join(v for k, v in TAGS.items() if k in (r["tag"] or "").split())
        entries[w] = [r["phonetic"] or "", zh, gloss(r["definition"], 2), tags, notes.get(w, "")]
        for part in (r["exchange"] or "").split("/"):
            k, _, v = part.partition(":")
            if k in ("p", "d", "i", "3", "r", "t", "s") and WORD.match(v or ""): forms.setdefault(v, w)

for f, lemma in forms.items():
    if f not in entries and lemma in entries: entries[f] = "@" + lemma

shards = collections.defaultdict(dict)
for w, v in entries.items(): shards[w[:2] if len(w) > 1 else w + "_"][w] = v
os.makedirs("dict", exist_ok=True)
for name in os.listdir("dict"):
    if name.endswith(".json"): os.remove(os.path.join("dict", name))
for k, d in shards.items():
    json.dump(d, open(f"dict/{k}.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
exam = {w: v[3] for w, v in entries.items() if isinstance(v, list) and v[3]}
if len(sys.argv) > 3:
    exam = {}
    with open(sys.argv[3], encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            w = (r.get("word") or "").strip().lower()
            if not WORD.match(w): continue
            t = "".join(c for col, c in (("TOEFL", "t"), ("IELTS", "i"), ("GRE", "g")) if (r.get(col) or "").strip())
            if t: exam[w] = t
json.dump(exam, open("dict/_exam.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(entries), "entries,", sum(1 for v in entries.values() if isinstance(v, list) and v[4]), "with notes,", len(shards), "shards,", len(exam), "exam words")
