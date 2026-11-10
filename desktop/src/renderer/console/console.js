'use strict';
// Temporary T计划 main window for the desktop build. It talks to the same Core
// as the pet, so everything here proves the shared task / timer / record path.
(function () {
  const T = window.tplan;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`; };
  const hm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const PAGES = ['today', 'review', 'pack', 'pet', 'diag', 'gallery'];
  const OUTCOME = { done: '✓ 完成', continue: '◐ 还要继续', null: '待定' };

  let page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  let st = null;
  let logLines = [];

  function el(a, now = Date.now()) {
    if (!a) return 0;
    let e = a.acc + (a.phase === 'running' ? now - a.lastAt : 0);
    if (a.mode === 'down') e = Math.min(e, a.budget);
    return Math.max(0, e);
  }

  async function refresh() { st = await T.get(); logLines = st.log; render(); }
  T.onUpdate((s) => { st = { ...s, log: logLines }; render(); });
  T.onLog((e) => { logLines.push(e); if (logLines.length > 300) logLines.shift(); if (page === 'diag') render(); });
  T.onGoto((p) => go(p));

  function go(p) { page = PAGES.includes(p) ? p : 'today'; history.replaceState(null, '', '#' + page); render(); }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });

  // ------------------------------------------------------------------ views

  function vToday() {
    const v = st.view, a = v.active;
    const timer = a ? `
      <div class="muted">${a.mode === 'up' ? '正计时' : '倒计时 ' + Math.round(a.budget / 60000) + ' 分钟'} · 开始于 ${hm(a.startedAt)}${a.autoPaused ? ' · 自动暂停（' + esc(a.autoPaused) + '）' : ''}</div>
      <div class="title">${esc(a.title)}</div>${a.step ? `<div class="muted">这一步：${esc(a.step)}</div>` : ''}
      <div class="clock" data-clk></div>
      <div class="row">${a.phase === 'running' ? `<button data-c="timer.pause">暂停</button>` : a.phase === 'paused' ? `<button class="acc" data-c="timer.resume">继续</button>` : ''}
      ${a.mode === 'down' ? '<button data-c="timer.extend">+5 分钟</button>' : ''}<button data-c="timer.end">结束并记录</button></div>`
      : `<p class="muted">没有进行中的计时。可以在这里或桌宠上开始，两边是同一个计时器。</p>`;
    const tasks = st.tasks;
    return `<div class="grid">
      <section class="card"><h2>计时</h2>${timer}</section>
      <section class="card"><h2>今天</h2>
        <p>主任务：${v.mainTask ? `<b>${esc(v.mainTask.title)}</b>${v.mainTask.next ? `<br><span class="muted">下一步：${esc(v.mainTask.next)}</span>` : ''}` : '<span class="muted">未选择</span>'}</p>
        <p class="muted">今天记录了 ${v.today.count} 段，共 ${v.today.minutes} 分钟。</p>
        <div class="row"><input type="text" id="newTask" maxlength="150" placeholder="添加任务，回车保存"><button data-a="add">添加</button></div>
        <div class="row"><button data-a="import">导入 T计划 导出的 JSON…</button><button data-a="export-data">导出记录备份</button></div>
      </section></div>
      <section class="card"><h2>未完成的任务</h2>${tasks.length ? `<table><tr><th>任务</th><th>日期</th><th>下一步</th><th></th></tr>${tasks.map((t) => `
        <tr><td>${esc(t.title)}${v.mainTask && v.mainTask.id === t.id ? ' <span class="tag">主任务</span>' : ''}</td><td class="muted">${t.date ? esc(t.date) : '以后想做'}</td>
        <td class="muted">${esc(t.next || '')}</td><td class="nw">
        <button class="sm" data-a="main" data-id="${t.id}">设为主任务</button> <button class="sm" data-a="start" data-id="${t.id}" ${a ? 'disabled' : ''}>▶ 10′</button>
        <button class="sm" data-a="done" data-id="${t.id}">✓</button></td></tr>`).join('')}</table>` : '<p class="muted">还没有任务。</p>'}</section>`;
  }

  function vReview() {
    const ss = st.sessions;
    return `<section class="card"><h2>最近的记录</h2>
      <p class="muted">每一轮计时只对应一条记录；结束计时即保存，完成状态可以稍后修改。</p>
      ${ss.length ? `<table><tr><th>日期</th><th>时间</th><th>内容</th><th>分钟</th><th>结果</th><th>备注</th><th></th></tr>${ss.map((s) => `
        <tr><td>${esc(s.date)}</td><td class="muted">${s.start ? hm(s.start) : ''}–${s.end ? hm(s.end) : ''}</td><td>${esc(s.title)}${s.step ? `<br><span class="muted">这一步：${esc(s.step)}</span>` : ''}</td>
        <td>${s.minutes}</td><td>${OUTCOME[s.outcome ?? 'null'] || '待定'}</td><td class="muted">${esc(s.note || '')}</td>
        <td class="nw"><button class="sm" data-a="oc" data-id="${s.id}" data-v="done">完成</button> <button class="sm" data-a="oc" data-id="${s.id}" data-v="continue">还要继续</button></td></tr>`).join('')}</table>` : '<p class="muted">还没有记录。</p>'}</section>`;
  }

  function vGallery() {
    const labels={idle:'平静待机',focus:'专注陪读',thinking:'认真思考',reminder:'温柔提醒',timeUp:'时间到了',done:'完成一步',rest:'安静休息',dragging:'拖拽反应',blink:'眨眼'};
    return `<section class="card"><h2>暖阳学者</h2><p class="muted">橙色长发、书卷与花饰。表情随学习状态自然变化。</p><div class="gallery-grid">${Object.entries(st.gallery||{}).map(([k,a])=>`<div class="gallery-card"><img src="${esc(a.url)}" alt="${esc(labels[k]||k)}"><span>${esc(labels[k]||k)}</span></div>`).join('')}</div></section>`;
  }

  function vPack() {
    const p = st.pack;
    const status = {
      ok: '<span class="ok">已加载</span>',
      missing: '<span class="warn">未加载（没有找到资源包）</span>',
      error: '<span class="bad">加载失败</span>',
      'error-kept-previous': `<span class="bad">重新加载失败，继续使用 ${esc(p.keptPack || '之前的资源包')}</span>`,
    }[p.status] || esc(p.status);
    const info = p.info;
    const r = st.lastRendered;
    return `<section class="card"><h2>角色资源包</h2>
      <p>状态：${status}</p>
      ${info ? `<p><b>${esc(info.name)}</b> <span class="muted">${esc(info.version)} · id ${esc(info.id)}</span></p>
        <p>有素材的状态：${info.states.map((s) => `<span class="tag">${s}</span>`).join('')}<br><span class="muted">其他状态显示 idle。</span></p>
        <p class="muted">画布 ${info.geom.canvasW}×${info.geom.canvasH} · 锚点 x=${info.geom.anchorX} · 脚底 footY=${info.geom.footY} · 人物顶部 ${info.geom.figureTop} · 当前显示高度 ${st.height} DIP</p>` : ''}
      ${p.dir ? `<p class="muted">文件夹：<code>${esc(p.dir)}</code></p>` : ''}
      ${p.errors && p.errors.length ? `<p class="bad">错误：</p><ul class="msgs">${p.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${p.warnings && p.warnings.length ? `<p class="warn">提示：</p><ul class="msgs">${p.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${r ? `<p class="muted">桌宠当前状态：<b>${esc(r.state)}</b>，显示的素材：<b>${esc(r.assetState || '无')}</b>${r.assetState && r.assetState !== r.state ? '（回退到 idle）' : ''}</p>` : ''}
      <div class="row"><button class="acc" data-act="choose-pack">从文件夹加载…</button><button data-act="reload-pack">重新加载当前资源包</button><button data-act="open-characters-dir">打开角色资源文件夹</button></div>
      <p class="muted">角色资源文件夹：<code>${esc(st.charactersDir)}</code></p>
      ${st.packsAvailable.length ? `<p class="muted">文件夹中的资源包：${st.packsAvailable.map((x) => esc(x.name + (x.version ? ' ' + x.version : ''))).join('、')}（可在托盘菜单中切换）</p>` : ''}
      <p class="muted">更换资源包或重新加载不会影响任务、计时和记录。</p></section>`;
  }

  function vPet() {
    const pr = st.prefs;
    return `<section class="card"><h2>桌宠窗口</h2>
      <p>桌宠：${st.petVisible ? '<span class="ok">显示中</span>' : '<span class="warn">已隐藏（计时与保存仍在运行）</span>'}</p>
      <div class="row"><button data-act="show-pet">显示</button><button data-act="hide-pet">隐藏</button><button data-act="find-pet">一键找回</button><button data-act="restore-interaction">恢复桌宠交互</button></div>
      <div class="row">
        <label class="chk"><input type="checkbox" data-top ${pr.alwaysOnTop ? 'checked' : ''}>始终置顶</label>
        <label class="chk"><input type="checkbox" data-mode="quiet" ${pr.quiet ? 'checked' : ''}>安静模式</label>
        <label class="chk"><input type="checkbox" data-mode="reducedMotion" ${pr.reducedMotion ? 'checked' : ''}>减少动作</label>
        <label class="chk"><input type="checkbox" data-mode="locked" ${pr.locked ? 'checked' : ''}>锁定位置</label>
        <label class="chk"><input type="checkbox" data-mode="passthrough" ${pr.passthrough ? 'checked' : ''}>全部鼠标穿透</label>
      </div>
      <div class="row">显示高度：${[200, 260, 320, 400].map((h) => `<button class="sm ${st.height === h ? 'acc' : ''}" data-h="${h}">${h}</button>`).join('')}<button class="sm" data-h="">资源包默认</button></div>
      <p class="muted">窗口位置：${st.petBounds ? `${st.petBounds.x}, ${st.petBounds.y} · ${st.petBounds.width}×${st.petBounds.height}` : '—'}</p>
      <p class="muted">开机自动启动：${st.loginItem ? '已开启' : '未开启'}（在托盘菜单中切换）</p>
      <div class="row"><label class="chk"><input type="checkbox" data-review ${st.settings.eveningReview ? 'checked' : ''}>晚间提醒我看一眼记录</label><input type="time" data-review-time value="${esc(st.settings.reviewTime || '21:00')}"></div>
      <p class="muted">计划与回看提醒合计每天最多 4 次，间隔至少 30 分钟；专注和安静模式下不主动提醒。</p>
      <div class="row"><button data-act="test-notification">测试 Windows 通知</button></div></section>`;
  }

  function vDiag() {
    return `<section class="card"><h2>诊断</h2>
      <p class="muted">${esc(st.versions.os)} · Electron ${esc(st.versions.electron)} · Chrome ${esc(st.versions.chrome)} · 硬件加速 ${st.hardwareAcceleration ? '开' : '关'}</p>
      <table><tr><th>显示器</th><th>范围</th><th>工作区</th><th>缩放</th></tr>${st.displays.map((d) => `<tr><td>${d.id}${d.primary ? '（主）' : ''}</td>
        <td>${d.bounds.x},${d.bounds.y} ${d.bounds.width}×${d.bounds.height}</td><td>${d.workArea.x},${d.workArea.y} ${d.workArea.width}×${d.workArea.height}</td><td>${d.scaleFactor * 100}%</td></tr>`).join('')}</table>
      <div class="row"><button data-a="export">复制诊断信息</button><button data-act="open-data-dir">打开数据文件夹</button></div>
      <p class="muted">数据文件夹：<code>${esc(st.dataDir)}</code></p>
      <pre>${logLines.slice(-150).reverse().map((e) => esc(`${e.t.slice(11, 19)} [${e.type}] ${e.msg}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`)).join('\n')}</pre></section>`;
  }

  function render() {
    if (!st) return;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === page));
    if(document.activeElement?.matches('input,textarea,select'))return;
    const focused = document.activeElement && document.activeElement.id;
    const keep = focused === 'newTask' ? $('#newTask').value : null;
    $('#main').innerHTML = { today: vToday, review: vReview, pack: vPack, pet: vPet, diag: vDiag, gallery: vGallery }[page]();
    if (keep !== null) { const i = $('#newTask'); i.value = keep; i.focus(); }
    tick();
  }

  function tick() {
    const c = document.querySelector('[data-clk]');
    const a = st && st.view.active;
    if (!c || !a) return;
    const e = el(a);
    c.textContent = a.phase === 'due' ? '时间到' : a.phase === 'paused' ? '已暂停 ' + clock(e) : a.mode === 'down' ? clock(a.budget - e) : clock(e);
  }
  setInterval(tick, 250);

  // --------------------------------------------------------------- actions

  async function dispatch(type, payload) {
    const r = await T.dispatch(type, payload);
    if (!r.ok) alert(r.error || '操作失败');
    return r;
  }

  $('#main').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = st.view.active;
    if (b.dataset.act) { T.action(b.dataset.act); return; }
    if (b.dataset.h !== undefined) { T.action('set-height', b.dataset.h ? Number(b.dataset.h) : null); return; }
    if (b.dataset.c && a) { await dispatch(b.dataset.c, { activeId: a.id, minutes: 5 }); return; }
    switch (b.dataset.a) {
      case 'add': await addTask(); break;
      case 'main': await dispatch('task.setMain', { taskId: b.dataset.id }); break;
      case 'start': await dispatch('timer.start', { taskId: b.dataset.id, minutes: 10 }); break;
      case 'done': await dispatch('task.setDone', { taskId: b.dataset.id, done: true }); break;
      case 'oc': await dispatch('session.outcome', { sessionId: b.dataset.id, outcome: b.dataset.v }); break;
      case 'import': { const r = await T.importData(); if (r.ok) alert(`已导入 ${r.tasks} 个任务、${r.sessions} 条记录。`); else if (!r.canceled) alert(r.error); break; }
      case 'export-data': {const r=await T.exportData();if(r.ok)alert('记录已导出。');else if(!r.canceled)alert(r.error);break;}
      case 'export': await T.exportDiagnostics(); alert('诊断信息已复制到剪贴板。'); break;
      default: break;
    }
  });
  $('#main').addEventListener('change', (e) => {
    const i = e.target;
    if (i.dataset.mode) T.action('set-mode', { key: i.dataset.mode, value: i.checked });
    if (i.hasAttribute('data-top')) T.action('set-top', i.checked);
    if (i.hasAttribute('data-review')) dispatch('settings.update', { eveningReview: i.checked });
    if (i.hasAttribute('data-review-time')) dispatch('settings.update', { reviewTime: i.value });
  });
  $('#main').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'newTask') addTask(); });

  async function addTask() {
    const i = $('#newTask');
    const title = i && i.value.trim();
    if (!title) return;
    const r = await dispatch('task.add', { title });
    if (r.ok) { i.value = ''; i.blur(); await refresh(); }
  }

  refresh();
})();
