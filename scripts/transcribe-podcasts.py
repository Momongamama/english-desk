# Makes a timed transcript for each new episode in podcasts.json and keeps it in the owner's secret gist.
# Transcripts never go into this public repo: the shows own the words, so they stay in a gist only the owner's token can list.
# Run by .github/workflows/transcripts.yml after the daily podcast list is fetched. Needs GIST_TOKEN (a token with the gist scope).
#
# Speech to text is faster-whisper (the Whisper model, run on the Actions machine, no API key). Word times from Whisper
# are grouped into sentences of up to ~20 words, the same size the Echo tab uses for shadowing.
#
# Gist layout: one file per episode, "<show id>-<hash of title>.json":
#   {"show": "...", "title": "...", "published": "...", "url": "...", "model": "...", "sentences": [[start, end, "text"], ...]}
import json, os, sys, time, tempfile, urllib.request, urllib.error

API = "https://api.github.com"
DESC = "English Desk transcripts (made by the daily job; used by the Echo tab)"
PER_SHOW = int(os.environ.get("PER_SHOW", "4"))      # newest episodes to keep per show
NEW_PER_RUN = int(os.environ.get("NEW_PER_RUN", "4"))  # at most this many new transcripts per run, so a run stays under ~40 min
MODEL = os.environ.get("WHISPER_MODEL", "small.en")
UA = "english-desk-transcripts/1.0 (+https://github.com/Momongamama/english-desk)"
TOKEN = os.environ.get("GIST_TOKEN", "").strip()


def str_hash(s):
    # Same as strHash() in app.js (31 * h + each UTF-16 unit, 32-bit), so the page can find an episode's file from its title.
    b, h = s.encode("utf-16-le"), 0
    for i in range(0, len(b), 2):
        h = (h * 31 + (b[i] | b[i + 1] << 8)) & 0xFFFFFFFF
    return base36(h)


def base36(n):
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + out
    return out


def file_name(show_id, title):
    return f"{show_id}-{str_hash(title)}.json"


def gh(path, method="GET", body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def find_gist():
    for page in range(1, 6):
        lst = gh(f"/gists?per_page=100&page={page}")
        for g in lst:
            if g.get("description") == DESC:
                return g["id"], set(g.get("files", {}).keys())
        if len(lst) < 100:
            break
    return None, set()


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def sentences(words):
    out, cur = [], []
    for w in words:
        t = w.word.strip()
        if not t:
            continue
        cur.append((w.start, w.end, t))
        if (t[-1] in ".?!" or (t[-1] in '"\')' and len(t) > 1 and t[-2] in ".?!")) or len(cur) >= 20:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    res = []
    for s in out:
        text = " ".join(x[2] for x in s).replace(" ,", ",")
        res.append([round(s[0][0], 2), round(s[-1][1], 2), text])
    return res


def transcribe(model, path):
    # Decode with the runner's ffmpeg, not PyAV: faster-whisper's PyAV call breaks whenever PyAV changes its API.
    import subprocess, numpy as np
    pcm = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         check=True, capture_output=True).stdout
    audio = np.frombuffer(pcm, dtype=np.float32)
    segs, info = model.transcribe(audio, language="en", word_timestamps=True, vad_filter=True, beam_size=1,
                                  condition_on_previous_text=False)
    words = [w for s in segs for w in (s.words or [])]
    return sentences(words)


def dry_run(pods):
    from faster_whisper import WhisperModel
    eps = [(s, e) for s in pods.get("shows", []) for e in s.get("episodes", [])[:1]]
    show, ep = min(eps, key=lambda x: x[1].get("duration") or 9999)
    t0 = time.time()
    model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    print(f"model loaded in {time.time() - t0:.0f}s; {show['name']} · {ep['title']} ({ep.get('duration')}s)")
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "ep.mp3")
        download(ep["url"], path)
        t1 = time.time()
        sents = transcribe(model, path)
    print(f"{len(sents)} sentences in {time.time() - t1:.0f}s")
    for s in sents[:25]:
        print(f"{s[0]:7.2f} {s[1]:7.2f}  {s[2]}")
    return 0


def main():
    pods = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "podcasts.json"))
    if os.environ.get("DRY_RUN"):
        return dry_run(pods)
    if not TOKEN:
        print("GIST_TOKEN is not set, so there is nowhere private to keep transcripts. Add it under the repo's Settings > Secrets > Actions.")
        return 0
    gist_id, have = find_gist()
    want = {}  # file name -> (show, episode)
    for show in pods.get("shows", []):
        for ep in show.get("episodes", [])[:PER_SHOW]:
            want[file_name(show["id"], ep["title"])] = (show, ep)
    todo = [k for k in want if k not in have][:NEW_PER_RUN]
    stale = [k for k in have if k.endswith(".json") and k not in want and k != "README.md"]
    print(f"gist {gist_id or '(new)'}: {len(have)} files, {len(todo)} to make, {len(stale)} to drop")
    if not todo and not stale:
        return 0

    model = None
    for name in todo:
        show, ep = want[name]
        if model is None:
            from faster_whisper import WhisperModel
            model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
        t0 = time.time()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ep.mp3")
            try:
                download(ep["url"], path)
                sents = transcribe(model, path)
            except Exception as e:  # one bad episode must not stop the rest
                print(f"skip {show['name']} · {ep['title']}: {e}")
                continue
        doc = {"show": show["id"], "title": ep["title"], "published": ep.get("published"), "url": ep["url"], "model": MODEL, "sentences": sents}
        files = {name: {"content": json.dumps(doc, ensure_ascii=False, separators=(",", ":"))}}
        # Save each one as soon as it is ready, so a run that times out still keeps what it finished.
        if gist_id:
            gh(f"/gists/{gist_id}", "PATCH", {"files": files})
        else:
            files["README.md"] = {"content": "Timed podcast transcripts for the Echo tab of English Desk. Made by a daily job; older episodes are removed.\n"}
            gist_id = gh("/gists", "POST", {"description": DESC, "public": False, "files": files})["id"]
        print(f"made {show['name']} · {ep['title']}: {len(sents)} sentences in {time.time() - t0:.0f}s")

    if stale and gist_id:
        gh(f"/gists/{gist_id}", "PATCH", {"files": {k: None for k in stale}})
        print(f"dropped {len(stale)} old transcripts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
