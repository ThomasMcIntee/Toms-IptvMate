// Node CDP client (Node >=22 has global WebSocket + fetch).
// Connects to the harness Electron, dumps app state, drives UI.
const BASE = process.env.CDP_BASE || "http://127.0.0.1:9225";
const PORT = Number(/9225/.exec(BASE)[0]) || 9225;
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
      resolve({ send, close: () => ws.close(), onMessage: (cb) => { ws.onmessage = (ev) => cb(JSON.parse(ev.data)); } });
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
    if (r.exceptionDetails) {
      return { __exception: r.exceptionDetails.text + ": " + (r.exceptionDetails.exception?.description || "") };
    }
    return r.result?.value;
  }

  // Wait for app to render + interpolate a bit
  await sleep(3000);

  const snapshot = await evalx(`(() => {
    const out = {};
    out.href = location.href;
    out.title = document.title;
    out.bodyTextStart = document.body ? document.body.innerText.slice(0, 400) : null;
    out.localStorageKeys = Object.keys(localStorage);
    out.favRaw = localStorage.getItem('iptvmate_favorites');
    out.lsChannelsLen = (localStorage.getItem('iptvmate_channels_cache')||'').length;
    out.lsHas414149 = (localStorage.getItem('iptvmate_channels_cache')||'').includes('live_414149');
    out.groupList = (document.querySelector('.group-list')||{}).innerText || null;
    out.groupItems = Array.from(document.querySelectorAll('.group-item')).map(el => el.innerText);
    out.activeGroup = (document.querySelector('.group-item.active')||{}).innerText || null;
    out.channelItems = Array.from(document.querySelectorAll('.channel-item')).slice(0,8).map(el => el.innerText);
    return out;
  })()`);

  console.log("SNAPSHOT_START");
  console.log(JSON.stringify(snapshot, null, 2));
  console.log("SNAPSHOT_END");

  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("HARNESS_ERR", err);
  process.exit(1);
});