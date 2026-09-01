// Verify per-item visibility toggles in PM movies/series grids.
const BASE = process.env.CDP_BASE || "http://127.0.0.1:9225";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
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
  const evalx = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };

  // Switch to Movies mode in the PM
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Movies');
    if (t) t.click();
    return true;
  })()`);
  await sleep(3000);

  const moviesState = await evalx(`(() => {
    const toggles = Array.from(document.querySelectorAll('.channel-icon-toggle input[type="checkbox"]'));
    const first = toggles[0];
    const tile = first ? first.closest('.channel-icon-wrap') : null;
    const label = tile ? (tile.querySelector('.channel-icon-label')||{}).textContent : null;
    return {
      icons: document.querySelectorAll('.channel-list-icons .channel-icon-btn').length,
      toggleCount: toggles.length,
      firstChecked: first ? first.checked : null,
      firstLabel: label
    };
  })()`);
  console.log("MOVIES_TOGGLES:", JSON.stringify(moviesState));

  // Toggle the first movie's visibility off and confirm state flips
  const toggleResult = await evalx(`(() => {
    const first = document.querySelector('.channel-icon-toggle input[type="checkbox"]');
    if (!first) return { ok: false };
    const was = first.checked;
    first.click();
    const tile = first.closest('.channel-item');
    return { ok: true, was, now: !was, itemHiddenClass: tile ? tile.classList.contains('hidden') : null };
  })()`);
  console.log("TOGGLE_RESULT:", JSON.stringify(toggleResult));
  await sleep(800);
  const afterToggle = await evalx(`(() => {
    const first = document.querySelector('.channel-icon-toggle input[type="checkbox"]');
    const tile = first ? first.closest('.channel-item') : null;
    return { checkedNow: first ? first.checked : null, hiddenClass: tile ? tile.className : null };
  })()`);
  console.log("AFTER_TOGGLE:", JSON.stringify(afterToggle));
  // toggle back on
  await evalx(`(() => { const f = document.querySelector('.channel-icon-toggle input[type="checkbox"]'); if (f && !f.checked) f.click(); return true; })()`);

  // Series mode checkbox presence
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Series');
    if (t) t.click();
    return true;
  })()`);
  await sleep(3000);
  const seriesState = await evalx(`(() => ({
    icons: document.querySelectorAll('.channel-list-icons .channel-icon-btn').length,
    toggleCount: document.querySelectorAll('.channel-icon-toggle input[type="checkbox"]').length
  }))()`);
  console.log("SERIES_TOGGLES:", JSON.stringify(seriesState));

  // Live TV mode rows keep checkboxes
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Live TV');
    if (t) t.click();
    return true;
  })()`);
  await sleep(3000);
  const liveState = await evalx(`(() => ({
    rows: document.querySelectorAll('.channel-item').length,
    rowCheckboxes: document.querySelectorAll('.channel-item input[type="checkbox"]').length,
    groupCheckboxes: document.querySelectorAll('.group-item input[type="checkbox"]').length
  }))()`);
  console.log("LIVE_STATE:", JSON.stringify(liveState));

  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("DRIVE_ERR", err);
  process.exit(1);
});
