// Reproduce: open Playlist Manager, switch to Movies / Series / Live, snapshot lists.
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

  const SNAP = `(() => {
    const pmButtons = Array.from(document.querySelectorAll('.playlist-manager-actions button')).map(b => b.innerText.trim());
    const groupItems = Array.from(document.querySelectorAll('.group-item')).slice(0, 6).map(el => el.innerText.slice(0, 50));
    const iconItems = Array.from(document.querySelectorAll('.channel-list-icons .channel-icon-btn')).slice(0, 4).map(el => (el.getAttribute('aria-label')||'').slice(0,40));
    const sidePanel = (document.querySelector('.side-panel')||{}).innerText;
    return {
      openingVisible: !!document.querySelector('.opening-card'),
      sidePanelStart: sidePanel ? sidePanel.slice(0, 80) : null,
      pmButtons,
      totalGroups: document.querySelectorAll('.group-item').length,
      groupItems,
      totalChannelRows: document.querySelectorAll('.channel-item').length,
      totalIcons: document.querySelectorAll('.channel-list-icons .channel-icon-btn').length,
      iconItems,
      alerts: (window.__alerts || []).slice(-3)
    };
  })()`;

  await evalx(`(() => { window.__alerts = []; const orig = window.alert.bind(window); window.alert = (m) => { window.__alerts.push(String(m)); }; return true; })()`);

  // Reload for a clean start at the opening menu.
  await evalx(`location.reload()`);
  await sleep(6000);
  await evalx(`(() => { window.__alerts = []; const orig = window.alert.bind(window); window.alert = (m) => { window.__alerts.push(String(m)); }; return true; })()`);

  console.log("STATE_INITIAL:", JSON.stringify(await evalx(SNAP)));

  const openPm = await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find(b => (b.innerText||'').trim() === 'Playlist Manager');
    if (target) { target.click(); return { clicked: (target.innerText||'').trim() }; }
    return { clicked: null, names: btns.map(b => (b.innerText||'').trim()).slice(0, 30) };
  })()`);
  console.log("OPEN_PM:", JSON.stringify(openPm));
  await sleep(2500);
  console.log("STATE_PM:", JSON.stringify(await evalx(SNAP)));


  // If a playlist needs loading, click Reload on the first playlist card
  const reload = await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.side-panel button'));
    const target = btns.find(b => (b.innerText||'').trim() === 'Reload');
    if (target) { target.click(); return { clicked: true }; }
    return { clicked: false, sideButtons: btns.map(b => (b.innerText||'').trim()).slice(0, 20) };
  })()`);
  console.log("RELOAD:", JSON.stringify(reload));

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const st = await evalx(`(() => {
      const banner = (document.querySelector('.playlist-status-banner')||{}).innerText || '';
      const loading = !!document.querySelector('.playlist-status-banner-loading');
      return { banner: banner.slice(0, 140), loading, groups: document.querySelectorAll('.group-item').length };
    })()`);
    console.log("LOAD_WAIT:", JSON.stringify(st));
    if (!st.loading && i > 1) break;
  }
  console.log("STATE_AFTER_LOAD:", JSON.stringify(await evalx(SNAP)));

  async function clickModeAndWatch(label, waits) {
    await evalx(`(() => {
      const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
      const target = btns.find(b => (b.innerText||'').trim() === '${label}');
      if (target) target.click();
      return true;
    })()`);
    for (let i = 0; i < waits; i++) {
      await sleep(4000);
      const st = await evalx(`(() => ({
        groups: document.querySelectorAll('.group-item').length,
        rows: document.querySelectorAll('.channel-item').length,
        icons: document.querySelectorAll('.channel-list-icons .channel-icon-btn').length,
        alerts: (window.__alerts || []).slice(-2)
      }))()`);
      console.log(`${label.toUpperCase()}_WAIT:`, JSON.stringify(st));
    }
    console.log(`STATE_${label.toUpperCase()}:`, JSON.stringify(await evalx(SNAP)));
  }

  await clickModeAndWatch("Movies", 12);
  await clickModeAndWatch("Series", 10);
  await clickModeAndWatch("Live TV", 3);

  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("DRIVE_ERR", err);
  process.exit(1);
});
