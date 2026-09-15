// Fire TV emulation: force an Android UA (isAndroidRuntime -> Capacitor mode),
// then exercise the Playlist Manager: live-only load, lazy Movies/Series loads
// with status feedback, and Live TV restore from IndexedDB.
const BASE = process.env.CDP_BASE || "http://127.0.0.1:9225";
const FIRE_TV_UA =
  "Mozilla/5.0 (Linux; Android 11; AFTMM Build/RS8101.2334N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
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

  await cdp.send("Emulation.setUserAgentOverride", { userAgent: FIRE_TV_UA });
  await evalx(`location.reload()`);
  await sleep(7000);
  await evalx(`(() => { window.__alerts = []; const o = window.alert.bind(window); window.alert = (m) => { window.__alerts.push(String(m)); }; return true; })()`);

  const capCheck = await evalx(`(() => ({ hasCap: !!window.Capacitor, isNative: window.Capacitor?.isNativePlatform ? window.Capacitor.isNativePlatform() : null, ua: navigator.userAgent.slice(0, 60) }))()`);
  console.log("CAP_CHECK:", JSON.stringify(capCheck));

  const SNAP = `(() => {
    const groupItems = Array.from(document.querySelectorAll('.group-item')).slice(0, 5).map(el => el.innerText.slice(0, 45));
    return {
      openingVisible: !!document.querySelector('.opening-card'),
      groups: document.querySelectorAll('.group-item').length,
      groupItems,
      rows: document.querySelectorAll('.channel-item').length,
      icons: document.querySelectorAll('.channel-list-icons .channel-icon-btn').length,
      toggles: document.querySelectorAll('.channel-icon-toggle input[type="checkbox"], .channel-item input[type="checkbox"]').length,
      playerStatus: (document.querySelector('.player-status')||{}).innerText || null,
      pmBanner: (document.querySelector('.playlist-status-banner')||{}).innerText?.slice(0, 110) || null,
      alerts: (window.__alerts || []).slice(-2)
    };
  })()`;

  const openPm = await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Playlist Manager');
    if (t) { t.click(); return { clicked: true }; }
    return { clicked: false, names: btns.map(b => (b.innerText||'').trim()).slice(0, 20) };
  })()`);
  console.log("OPEN_PM:", JSON.stringify(openPm));
  await sleep(2500);
  console.log("PM_INITIAL:", JSON.stringify(await evalx(SNAP)));

  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.side-panel button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Reload');
    if (t) t.click();
    return true;
  })()`);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const st = await evalx(SNAP);
    console.log("LIVE_LOAD:", JSON.stringify({ banner: st.pmBanner, groups: st.groups, rows: st.rows }));
    if (st.pmBanner && !st.pmBanner.includes("⏳") && i > 1) break;
  }
  console.log("AFTER_LIVE_LOAD:", JSON.stringify(await evalx(SNAP)));

  // Movies — lazy scope load with status feedback.
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Movies');
    if (t) t.click();
    return true;
  })()`);
  let sawMoviesStatus = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const st = await evalx(SNAP);
    if (st.playerStatus && /movies/i.test(st.playerStatus)) sawMoviesStatus = true;
    console.log("MOVIES:", JSON.stringify({ playerStatus: st.playerStatus, groups: st.groups, icons: st.icons, toggles: st.toggles, alerts: st.alerts }));
    if (st.icons > 0 && !st.playerStatus) break;
  }
  console.log("MOVIES_STATUS_SEEN:", sawMoviesStatus);

  // Series — lazy scope load.
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Series');
    if (t) t.click();
    return true;
  })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const st = await evalx(SNAP);
    console.log("SERIES:", JSON.stringify({ playerStatus: st.playerStatus, groups: st.groups, icons: st.icons, toggles: st.toggles, alerts: st.alerts }));
    if (st.icons > 0 && !st.playerStatus) break;
  }

  // Back to Live TV — should restore from IndexedDB quickly, no re-download.
  await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.playlist-manager-actions button'));
    const t = btns.find(b => (b.innerText||'').trim() === 'Live TV');
    if (t) t.click();
    return true;
  })()`);
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const st = await evalx(SNAP);
    console.log("BACK_LIVE:", JSON.stringify({ playerStatus: st.playerStatus, groups: st.groups, rows: st.rows, alerts: st.alerts }));
    if (st.rows > 0) break;
  }

  // Switch live group to confirm group hydration works in PM TV mode.
  const groupSwitch = await evalx(`(() => {
    const btns = Array.from(document.querySelectorAll('.group-item .group-select-btn'));
    if (btns.length < 3) return { ok: false, count: btns.length };
    const target = btns[2];
    const name = target.innerText.slice(0, 40);
    target.click();
    return { ok: true, name };
  })()`);
  console.log("GROUP_SWITCH:", JSON.stringify(groupSwitch));
  await sleep(4000);
  console.log("AFTER_GROUP_SWITCH:", JSON.stringify(await evalx(SNAP)));

  await cdp.send("Emulation.clearUserAgentOverride");
  cdp.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("DRIVE_ERR", err);
  process.exit(1);
});
