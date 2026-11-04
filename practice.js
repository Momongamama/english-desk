// Every speaking and writing session in full: transcript or paragraph, AI feedback, C1 version, your rewrite, times.
// Kept in IndexedDB, which has far more room than localStorage. The short log in localStorage (englishDesk.v1) stays the index
// for Today's chart and the monthly redo. Text only: recordings are never stored.
// One record per session, keyed by `ts` (the same `ts` as its log). `updated` (ms) decides which copy wins when two devices meet.
window.EDPractice = (() => {
  const DB = "englishDesk.practice", STORE = "practice";
  const mem = new Map(); // used only when this browser has no IndexedDB (some private windows); lost on reload
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("no indexedDB"));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "ts" }) };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked"));
    }).catch(() => null);
    return dbp;
  }
  // Runs one request in its own transaction and resolves when the transaction is done.
  async function run(mode, fn) {
    const db = await open();
    if (!db) { const out = fn(null); return out && "result" in out ? out.result : undefined }
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const clean = r => JSON.parse(JSON.stringify(r));
  return {
    available: async () => !!(await open()),
    get: ts => run("readonly", s => s ? s.get(+ts) : { result: mem.get(+ts) }),
    all: async () => (await run("readonly", s => s ? s.getAll() : { result: [...mem.values()] }) || []).sort((a, b) => a.ts - b.ts),
    put: r => run("readwrite", s => { const v = clean(r); if (s) return s.put(v); mem.set(v.ts, v) }),
    putMany: rs => run("readwrite", s => { for (const r of rs) { const v = clean(r); if (s) s.put(v); else mem.set(v.ts, v) } }),
    del: ts => run("readwrite", s => { if (s) return s.delete(+ts); mem.delete(+ts) }),
    month: r => String(r.date || "").slice(0, 7),
    // Which copy to keep when the same session comes from two places.
    newer: (a, b) => (a.updated || 0) > (b.updated || 0),
  };
})();
