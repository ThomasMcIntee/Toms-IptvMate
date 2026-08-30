// Scan app IndexedDB for group membership of favorited channels, and click Favorites tab.
const BASE = process.env.CDP_BASE || "http://127.0.0.1:9225";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/json/list`);
      const list = await res.json();
      const page = (list || []).find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP page target");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      resolve({ send, close: () => ws.close() });
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    };
  });
}

async function main() {
  const target = await getPageTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  async function evalx(expression) {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) return { __exception: r.exceptionDetails.text, __desc: r.exceptionDetails.exception?.description };
    return r.result?.value;
  }

  // 1) Which groups contain each favorite channel id? Scan IndexedDB group records.
  const scan = await evalx(`(async () => {
    const favIds = ['live_414149','live_414150','live_498318','live_498313','live_498303'];
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('iptvmate_cache');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const out = { dbName: db.name, stores: Array.from(db.objectStoreNames), found: {}, groupCount: 0 };
    try {
      const tx = db.transaction('channels', 'readonly');
      const store = tx.objectStore('channels');
      const keys = await new Promise((res, rej) => {
        const req = store.getAllKeys();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });
      out.groupCount = keys.length;
      out.sampleKeys = keys.slice(0, 5);
      for (const id of favIds) {
        const groups = [];
        for (const key of keys) {
          if (typeof key !== 'string' || !key.startsWith('live-group:')) continue;
          const value = await new Promise((res, rej) => {
            const req = store.get(key);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          if (!Array.isArray(value)) continue;
          const hit = value.find(c => c && String(c.id) === id);
          if (hit) groups.push({ group: key.slice('live-group:'.length), url: hit.url || null, name: hit.name || null });
        }
        out.found[id] = groups;
      }
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    db.close();
    return out;
  })()`);
  console.log("IDB_SCAN:", JSON.stringify(scan, null, 2));

  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("ERR", err);
  process.exit(1);
});