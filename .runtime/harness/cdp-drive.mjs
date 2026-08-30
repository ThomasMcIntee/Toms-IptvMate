// Drive the app UI via CDP: enter Live TV, snapshot group list + favorites.
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
    if (r.exceptionDetails) {
      return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  }

  // Current state (welcome menu)
  console.log("MENU:", JSON.stringify(await evalx(`document.body.innerText.slice(0,300)`)));

  // Click "Live TV"
  const clickResult = await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find(b => (b.innerText||'').trim() === 'Live TV');
    if (!target) return { clicked: false, buttons: btns.map(b=>b.innerText).slice(0,20) };
    target.click();
    return { clicked: true };
  })()`);
  console.log("CLICK:", JSON.stringify(clickResult));

  await sleep(6000);

  const snap = await evalx(`(() => {
    const groupItems = Array.from(document.querySelectorAll('.group-item')).slice(0, 12).map(el => ({
      text: el.innerText,
      active: el.classList.contains('active'),
      hidden: el.classList.contains('hidden')
    }));
    const favGroup = Array.from(document.querySelectorAll('.group-item')).find(el => /Favorites/.test(el.innerText));
    const channels = Array.from(document.querySelectorAll('.channel-item')).slice(0, 10).map(el => el.innerText);
    return {
      totalGroupItems: document.querySelectorAll('.group-item').length,
      totalChannelItems: document.querySelectorAll('.channel-item').length,
      groupItems,
      favGroupText: favGroup ? favGroup.innerText : null,
      channels,
      channelListText: (document.querySelector('.channel-list')||{}).innerText ? (document.querySelector('.channel-list').innerText.slice(0,300)) : null,
      statusText: (document.querySelector('.player-status')||{}).innerText || null,
      bodySnippet: document.body.innerText.slice(0,500)
    };
  })()`);
  console.log("SNAP_AFTER_LIVE:", JSON.stringify(snap, null, 2));

  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("DRIVE_ERR", err);
  process.exit(1);
});