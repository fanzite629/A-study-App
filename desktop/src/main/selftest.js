'use strict';
// Automated end-to-end smoke test, run with `--selftest=<outDir>`.
// It drives the real app (real windows, real pack loading, real hit masks) and
// writes report.json plus screenshots, then exits with code 0 (pass) or 1.
// It cannot test OS-level behaviour such as real mouse click-through, tray
// clicks, or Windows DPI handling; those stay on the manual Windows checklist.

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(d) {
  const { app, core, getPet, getLayout, outDir, log } = d;
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); log('selftest', `${pass ? 'PASS' : 'FAIL'} ${name}`, detail); };
  const js = (code) => getPet().webContents.executeJavaScript(code);
  const info = () => js('window.__petInfo()');
  const probe = (x, y) => js(`window.__petProbe(${x}, ${y})`);
  const dom = () => js(`({
    imgs: [...document.querySelectorAll('#char img')].map((i) => ({ src: i.src.split('/').pop(), visible: getComputedStyle(i).display !== 'none', w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, nw: i.naturalWidth, nh: i.naturalHeight })),
    chip: !document.querySelector('#chip').hidden,
    bubble: !document.querySelector('#bubble').hidden,
    bubbleText: document.querySelector('#bubble').innerText.slice(0, 80),
  })`);
  const shot = async (name) => {
    getPet().webContents.invalidate();
    await sleep(400);
    const img = await getPet().webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
  };
  async function waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); }
  }

  if (d.getPackStatus().status !== 'ok') return runMissing({ ...d, check, js, info, probe, shot, dom, waitFor, results });

  try {
    await waitFor(async () => getPet() && !getPet().webContents.isLoading() && (await info()).assetState === 'idle', 8000);
    let i = await info();
    check('pack loads and idle image is displayed', i.packLoaded && i.assetState === 'idle', i);
    await shot('01-idle.png');

    const L = getLayout();
    const fig = L.fig;
    const center = await probe(Math.round(fig.x + fig.w / 2), Math.round(fig.y + fig.h * 0.3));
    check('opaque pixel on the figure is hit', center.figure, center);
    const corner = await probe(2, 2);
    check('transparent window corner passes through', !corner.hit, corner);
    const besideFeet = await probe(Math.round(L.img.x + 2), Math.round(L.foot.y - 4));
    check('transparent canvas area next to the feet passes through', !besideFeet.hit, besideFeet);

    const { taskId } = core.dispatch({ type: 'task.add', payload: { title: '自测任务：先看第一道例题', setMain: true } });
    const start = core.dispatch({ type: 'timer.start', payload: { taskId, minutes: 10 } });
    check('timer starts from the shared core', start.ok, start);
    i = await waitFor(async () => { const x = await info(); return x.state === 'focus' ? x : null; });
    check('running timer -> state focus, focus asset shown', i && i.assetState === 'focus', i);
    let D = await dom();
    const vis = D.imgs.filter((x) => x.visible);
    check('DOM: exactly one character image visible, and it is focus.png', vis.length === 1 && vis[0].src === 'focus.png', D);
    check('DOM: image keeps its aspect ratio', vis.length === 1 && Math.abs(vis[0].w / vis[0].h - vis[0].nw / vis[0].nh) < 0.01, vis);
    check('DOM: timer chip is shown while timing', D.chip, D);
    await shot('02-focus.png');

    const dup = core.dispatch({ type: 'timer.start', payload: { taskId, minutes: 10 } });
    check('a second timer is refused', !dup.ok, dup);

    // Broken pack: must fail clearly, keep the current pack, and not touch the timer.
    const activeBefore = core.S.active && core.S.active.id;
    const ok = d.applyPack(path.join(d.ROOT, 'dev-fixtures', 'broken-pack'), { remember: false, reason: 'selftest-broken' });
    i = await info();
    check('broken pack is rejected and the previous pack stays', !ok && i.packLoaded && i.assetState === 'focus', { ok, i, status: d.getPackStatus() });
    check('pack failure does not interrupt the timer', core.S.active && core.S.active.id === activeBefore && core.S.active.phase === 'running');

    // Reload the good pack while timing.
    const reloaded = d.applyPack(path.join(d.ROOT, 'dev-fixtures', 'test-pack'), { remember: false, reason: 'selftest-reload' });
    i = await waitFor(async () => { const x = await info(); return x.assetState === 'focus' ? x : null; });
    check('reloading the pack keeps the timer and state', reloaded && i && core.S.active && core.S.active.id === activeBefore, i);

    // Resize keeps the feet in place and keeps hit testing in sync.
    const footBefore = d.getFoot();
    d.setHeight(320);
    await sleep(300);
    const footAfter = d.getFoot();
    const L2 = getLayout();
    check('resize keeps the foot anchor in place', Math.abs(footBefore.x - footAfter.x) <= 1 && Math.abs(footBefore.y - footAfter.y) <= 1, { footBefore, footAfter });
    const c2 = await probe(Math.round(L2.fig.x + L2.fig.w / 2), Math.round(L2.fig.y + L2.fig.h * 0.3));
    check('hit testing follows the new size', c2.figure && Math.abs(L2.fig.h - 320) < 1, { c2, figH: L2.fig.h });
    await shot('03-resized-320.png');
    d.setHeight(null);

    // End the round: one record, state back to idle.
    core.dispatch({ type: 'timer.end', payload: { activeId: activeBefore } });
    i = await waitFor(async () => { const x = await info(); return x.state !== 'focus' ? x : null; });
    check('ending the timer leaves focus', i && i.state !== 'focus', i);

    // A state with no asset falls back to idle while the business state is real.
    core.dispatch({ type: 'rest.start', payload: { minutes: 1 } });
    i = await waitFor(async () => { const x = await info(); return x.state === 'rest' ? x : null; });
    check('rest without an asset shows idle', i && i.assetState === 'idle', i);
    core.dispatch({ type: 'rest.end' });

    await js('window.__petClickCharacter()');
    i = await waitFor(async () => { const x = await info(); return x.card === 'main' ? x : null; });
    check('clicking the character opens the task card (thinking -> idle asset)', i && i.state === 'thinking' && i.assetState === 'idle', i);
    D = await dom();
    check('DOM: bubble is shown with the task card', D.bubble && D.bubbleText.includes('自测任务'), D);
    await shot('04-card.png');
  } catch (e) {
    check('self-test crashed', false, String(e && e.stack || e));
  }

  const failed = results.filter((r) => !r.pass).length;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
  d.markQuitting();
  app.exit(failed ? 1 : 0);
}

/** No character pack available: the app must say so clearly and still work. */
async function runMissing(d) {
  const { app, core, getLayout, outDir, check, js, info, probe, shot, waitFor, results } = d;
  try {
    await waitFor(async () => d.getPet() && !d.getPet().webContents.isLoading() && (await info()).layout, 8000);
    const card = await js(`(() => { const m = document.querySelector('#missing'); return { shown: !m.hidden, text: m.innerText }; })()`);
    check('missing pack: notice card is shown with a reason', card.shown && card.text.includes('未加载角色素材'), card);
    const imgs = await js(`document.querySelectorAll('#char img').length`);
    check('missing pack: no character image is drawn as a substitute', imgs === 0, { imgs });
    const L = getLayout();
    const onCard = await probe(Math.round(L.img.x + L.img.w / 2), Math.round(L.img.y + 10));
    check('missing pack: the card can be grabbed (hit)', onCard.hit, onCard);
    const off = await probe(2, 2);
    check('missing pack: empty window area passes through', !off.hit, off);
    const { taskId } = core.dispatch({ type: 'task.add', payload: { title: '无素材时也能计时', setMain: true } });
    const r = core.dispatch({ type: 'timer.start', payload: { taskId, minutes: 5 } });
    const i = await waitFor(async () => { const x = await info(); return x.state === 'focus' ? x : null; });
    check('missing pack: timer and states still work', r.ok && i && i.state === 'focus' && i.assetState === null, i);
    await shot('missing-pack.png');
  } catch (e) {
    check('self-test crashed', false, String(e && e.stack || e));
  }
  const failed = results.filter((x) => !x.pass).length;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'missing-pack', failed, results }, null, 2));
  d.markQuitting();
  app.exit(failed ? 1 : 0);
}

module.exports = { run };
