'use strict';
// Pet window controller: interaction (click / drag / right-click / hit
// testing), functional UI (bubbles, timer chip, missing-assets card), and the
// mapping from business data to a pet state. Character images are handled by
// CharacterRenderer; data and timing live in the main process Core.
(function () {
  const api = window.petApi;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
  };

  const renderer = new CharacterRenderer($('#char'));
  const bubble = $('#bubble'), chip = $('#chip'), dot = $('#dot'), missing = $('#missing');

  let layout = null;
  let pack = null;
  let mode = { locked: false, passthrough: false, quiet: false };
  let view = null;
  let ui = { card: null };          // which bubble is open, plus its data
  let collapseTimer = null, noticeTimer = null;
  let dragging = false;
  let press = null;                 // pointer press that may become a click or a drag
  let hit = false;
  let doneFlashUntil = 0;
  let localActionAt = 0;            // last command sent from this window
  let pendingFocus = null;
  let endingFlow = false;           // a bubble flow that handles the outcome itself

  // --------------------------------------------------------- business -> state

  const ACTION_CARDS = ['main', 'pick', 'shrink', 'control', 'outcome', 'next', 'add', 'review'];
  function currentState() {
    return PetStates.resolveState({
      dragging,
      doneFlash: Date.now() < doneFlashUntil,
      timerPhase: view && view.active ? view.active.phase : null,
      reminderOpen: ui.card === 'reminder' || ui.card === 'restEnd' || ui.card === 'gentle',
      resting: !!(view && view.rest),
      cardOpen: ACTION_CARDS.includes(ui.card),
    });
  }
  function updateState() { renderer.setState(currentState()); }
  renderer.onChange((info) => api.rendered({ ...info, packId: pack && pack.id, at: Date.now() }));

  // ------------------------------------------------------------- hit testing

  function isControl(el) { return !!(el && el.closest('button, input, textarea, [data-hit]')); }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (el && el.closest('[data-hit], [data-drag]')) return true;
    return renderer.hitTest(x, y);
  }

  function setHit(v) {
    if (v === hit) return;
    hit = v;
    api.setHit(v);
  }

  document.addEventListener('mousemove', (e) => { if (!dragging && !mode.passthrough) setHit(hitTest(e.clientX, e.clientY)); });
  document.addEventListener('mouseleave', () => { if (!dragging) setHit(false); });

  // ------------------------------------------------- click vs drag vs menu

  const DRAG_THRESHOLD = 4; // DIP

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || mode.passthrough) return;
    if (isControl(e.target)) return;                          // buttons/inputs handle themselves
    const onFigure = renderer.hitTest(e.clientX, e.clientY);
    const onCard = !!e.target.closest('[data-drag]');
    if (!onFigure && !onCard) return;
    press = { id: e.pointerId, sx: e.screenX, sy: e.screenY, onFigure, started: false };
    e.target.setPointerCapture(e.pointerId);
  });

  document.addEventListener('pointermove', (e) => {
    if (!press || press.id !== e.pointerId || press.started || mode.locked) return;
    if (Math.hypot(e.screenX - press.sx, e.screenY - press.sy) > DRAG_THRESHOLD) {
      press.started = true;
      dragging = true;
      document.body.classList.add('dragging');
      closeBubble(true);
      updateState();
      api.dragStart();
    }
  });

  function finishPress(e, cancelled) {
    if (!press || (e && press.id !== e.pointerId)) return;
    const p = press;
    press = null;
    if (p.started) {
      dragging = false;
      document.body.classList.remove('dragging');
      api.dragEnd();
      updateState();                    // back to whatever the business state is
    } else if (!cancelled && p.onFigure) {
      onCharacterClick();               // only a press without movement is a click
    }
    if (e) setHit(hitTest(e.clientX, e.clientY));
  }
  document.addEventListener('pointerup', (e) => finishPress(e, false));
  document.addEventListener('pointercancel', (e) => finishPress(e, true));
  document.addEventListener('lostpointercapture', (e) => { if (press && press.started) finishPress(e, true); });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isControl(e.target)) return;
    if (hitTest(e.clientX, e.clientY)) api.contextMenu();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBubble(); });

  // ----------------------------------------------------------- data helpers

  function el(a, now = Date.now()) {
    if (!a) return 0;
    let e = a.acc + (a.phase === 'running' ? now - a.lastAt : 0);
    if (a.mode === 'down') e = Math.min(e, a.budget);
    return Math.max(0, e);
  }

  async function send(type, payload) {
    localActionAt = Date.now();
    const r = await api.dispatch(type, payload);
    if (!r.ok && r.error) showNotice(r.error);
    return r;
  }

  // -------------------------------------------------------------- bubbles

  function onCharacterClick() {
    if (ui.card && ui.card !== 'notice') { closeBubble(); return; }
    openCard(view && view.active ? 'control' : 'main');
  }

  function openCard(card, data = {}) {
    clearTimeout(noticeTimer);
    ui = { card, ...data };
    dot.hidden = true;
    renderBubble();
    updateState();
    clearTimeout(collapseTimer);
    // Action cards that need an answer collapse to a dot after 30 s ("稍后处理").
    if (['timeUp', 'reminder', 'restEnd', 'outcome'].includes(card)) {
      collapseTimer = setTimeout(() => { if (ui.card === card && !document.activeElement.matches('input')) collapse(); }, 30000);
    }
  }

  function collapse() {
    bubble.hidden = true;
    dot.hidden = false;
    ui.collapsed = true;
    placeDot();
  }

  function closeBubble(silent) {
    clearTimeout(collapseTimer);
    clearTimeout(noticeTimer);
    const was = ui.card;
    ui = { card: null };
    bubble.hidden = true;
    dot.hidden = true;
    if (document.activeElement && document.activeElement.matches('input')) document.activeElement.blur();
    api.releaseFocus();
    if (was === 'reminder' && !silent) send('reminder.dismiss');
    updateState();
  }

  function showNotice(text, ms = 6000) {
    if (ui.card && ui.card !== 'notice') return; // never replace a card waiting for an answer
    ui = { card: 'notice', text };
    renderBubble();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (ui.card === 'notice') closeBubble(true); }, ms);
  }

  const btn = (act, label, cls = '', extra = '') => `<button class="${cls}" data-act="${act}" ${extra}>${label}</button>`;
  const closeX = btn('close', '×', 'x', 'aria-label="关闭"');

  function renderBubble() {
    if (!ui.card) { bubble.hidden = true; return; }
    const v = view || {};
    const a = v.active;
    let h = '';
    switch (ui.card) {
      case 'main': {
        const t = v.mainTask;
        if (!t || t.done) {
          if (v.openTasks && v.openTasks.length) {
            h = `<p class="say">想做的都收好了。今天先推进哪一件？</p><div class="list">${v.openTasks.slice(0, 5).map((x) =>
              `<button data-act="set-main" data-id="${x.id}"><span>${esc(x.title)}</span><span class="meta">${x.at ? esc(x.at) + ' · ' : ''}${x.est || 30}′</span></button>`).join('')}</div>
              <div class="row">${btn('add', '直接说一件事…', 'link')}${btn('open-main', '打开 T计划', 'link')}</div>`;
          } else {
            h = `<p class="say">T计划里还没有今天的任务。</p><div class="row">${btn('add', '直接说一件事…', 'acc')}${btn('open-main', '打开 T计划')}</div>`;
          }
        } else {
          h = `<div class="title">${esc(t.title)}</div>${t.next ? `<div class="sub">下一步：${esc(t.next)}</div>` : '<div class="sub">先做一点点就好。</div>'}
            <div class="row">${btn('start', '▶ 先做 5 分钟', 'acc', 'data-min="5"')}${btn('start', '▶ 10 分钟', '', 'data-min="10"')}${btn('start', `▶ 按计划 ${t.est || 25}′`, '', `data-min="${t.est || 25}"`)}</div>
            <div class="row">${btn('shrink', '缩小一点', 'link')}${btn('pick', '换一件', 'link')}${btn('review', '今天回看', 'link')}</div><div class="row">${btn('start-up','正计时','link')}${btn('rest','休息 5 分钟','link')}</div>`;
        }
        break;
      }
      case 'pick':
        h = `<p class="say">换哪一件？</p><div class="list">${(v.openTasks || []).map((x) =>
          `<button data-act="set-main" data-id="${x.id}"><span>${esc(x.title)}</span><span class="meta">${x.est || 30}′</span></button>`).join('')}</div>
          <div class="row">${btn('add', '直接说一件事…', 'link')}${btn('clear-main', '今天不设主任务', 'link')}</div>`;
        break;
      case 'add':
        h = `<p class="say">现在想推进什么？</p><input type="text" id="inAdd" maxlength="150" placeholder="例如：复习高数第三章">
          <label><input type="checkbox" id="inLater">先放进以后清单</label><div class="sub">开始时间（可选） <input type="time" id="inTime"></div>
          <div class="row">${btn('add-save', '保存任务', 'acc')}${btn('main', '返回', 'link')}</div>`;
        break;
      case 'shrink': {
        const t = v.mainTask;
        h = `<p class="say">这件有点大。第一步是什么？</p><input type="text" id="inStep" maxlength="200" value="${esc((t && t.next) || '')}" placeholder="缩到“打开就能做”的大小">
          <div class="chips">${['先看第一道例题', '先读 2 页', '先打开文件写个标题'].map((c) => btn('chip', esc(c), '', `data-v="${esc(c)}"`)).join('')}</div>
          <div class="row">${btn('step-start', '▶ 保存并先做 5 分钟', 'acc')}${btn('step-save', '只保存')}</div>`;
        break;
      }
      case 'control':
        if (!a) { ui.card = 'main'; return renderBubble(); }
        h = `<div class="title">${esc(a.title)}</div>${a.step ? `<div class="sub">这一步：${esc(a.step)}</div>` : ''}
          <div class="clock" data-clk></div><div class="row">${a.phase === 'running'
            ? btn('pause', '暂停') + btn('end', '结束') + (a.mode === 'down' ? btn('extend', '+5′') : '')
            : a.phase === 'paused' ? btn('resume', '继续', 'acc') + btn('end', '结束') : btn('end', '结束', 'acc')}</div>`;
        break;
      case 'timeUp':
        h = `<p class="say">这段时间记下来了。继续一会儿，还是先休息？</p>
          <div class="row">${btn('extend', '再 5 分钟')}${btn('count-up', '正计时继续')}</div>
          <div class="row">${btn('end-done', '✓ 完成了', 'acc')}${btn('end-continue', '还要继续')}${btn('end-rest', '先休息')}</div>`;
        break;
      case 'outcome':
        h = `<p class="say">记下 ${ui.minutes} 分钟。这一步怎么样？</p>
          <div class="row">${btn('outcome-done', '✓ 完成了', 'acc')}${btn('outcome-continue', '还要继续')}</div>
          <input type="text" id="inNote" maxlength="200" placeholder="说一句（可不写），例如：卡在第二题">`;
        break;
      case 'next':
        h = `<p class="say">下次从哪里接着？</p><input type="text" id="inNext" maxlength="200" value="${esc(ui.suggest || '')}" placeholder="例如：从第 17 题开始">
          <div class="row">${btn('next-save', '保存', 'acc')}${btn('next-skip', '先不写', 'link')}</div>`;
        break;
      case 'reminder': {
        const r = v.reminder;
        const at = r ? clock(r.elapsed) : '';
        const text = !r ? '' : r.reason === 'sleep' ? `刚才电脑睡着了，计时停在 ${at}。接着来吗？`
          : r.reason === 'lock' ? `锁屏时已暂停，计时停在 ${at}。接着来吗？`
          : r.reason === 'crash' ? `上次计时意外中断，停在 ${at}。继续，还是结束并记录？`
          : `上次退出时计时停在 ${at}。继续，还是结束并记录？`;
        if (!r || !a) { closeBubble(true); return; }
        h = `<p class="say">${text}</p><div class="row">${btn('resume', '继续', 'acc')}${btn('end', '结束并记录')}${btn('later', '稍后', 'link')}</div>`;
        break;
      }
      case 'restEnd':
        h = `<p class="say">休息好了？书签还在原处。</p><div class="row">${v.mainTask && !v.mainTask.done ? btn('start', '继续这一页', 'acc', 'data-min="10"') : ''}${btn('close', '今天先到这')}</div>`;
        break;
      case 'notice':
        h = `<p class="say">${esc(ui.text)}</p>`;
        break;
      case 'gentle':
        h = `<p class="say">${esc(ui.text)}</p><div class="row">${ui.review?btn('review','看一眼','acc'):btn('main','选一件事','acc')}${btn('close','稍后','link')}</div>`;
        break;
      case 'review':
        h = `<p class="say">今天记录 ${v.today?.count||0} 段，共 ${v.today?.minutes||0} 分钟。</p><p class="sub">没有计时记录，不代表没有学习。</p>`+(v.reviewTasks||[]).map(t=>`<div class="review-row"><b>${esc(t.title)}</b><div class="sub">${t.done?(t.recordCount?'✓ 完成':'✓ 已勾选完成（没有计时）'):t.recordCount?'已有计时记录':'今天没有计时记录'}${t.recordCount?' · '+t.minutes+' 分钟':''}</div>${t.next?'<div class="sub">下次：'+esc(t.next)+'</div>':''}${!t.done?`<div class="row">${btn('schedule','明天再做','link',`data-id="${esc(t.id)}" data-day="tomorrow"`)}${btn('schedule','放回清单','link',`data-id="${esc(t.id)}" data-day="later"`)}${btn('schedule','今天还做','link',`data-id="${esc(t.id)}" data-day="today"`)}</div>`:''}</div>`).join('')+`<div class="row">${btn('open-main','打开完整记录','link','data-page="review"')}</div>`;
        break;
      default:
        bubble.hidden = true;
        return;
    }
    bubble.innerHTML = (ui.card === 'notice' ? '' : closeX) + h;
    bubble.hidden = false;
    placeBubble();
    tick();
    const input = bubble.querySelector('input');
    if (input && ['add', 'shrink', 'next'].includes(ui.card)) requestFocus(input);
  }

  // ------------------------------------------------------- bubble actions

  bubble.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const v = view || {};
    const a = v.active;
    const t = v.mainTask;
    const val = (id) => { const i = $(id); return i ? i.value.trim() : ''; };
    switch (act) {
      case 'close': closeBubble(); break;
      case 'later': collapse(); break;
      case 'main': openCard('main'); break;
      case 'pick': openCard('pick'); break;
      case 'add': openCard('add'); break;
      case 'shrink': openCard('shrink'); break;
      case 'review': openCard('review'); break;
      case 'rest': await send('rest.start',{minutes:5});closeBubble(true);break;
      case 'start-up': if(t)await startRound(t,'up');break;
      case 'schedule': {const d=new Date();if(b.dataset.day==='tomorrow')d.setDate(d.getDate()+1);const date=b.dataset.day==='later'?null:`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;await send('task.schedule',{taskId:b.dataset.id,date});openCard('review');break;}
      case 'open-main': api.action('open-main', b.dataset.page); closeBubble(true); break;
      case 'set-main': await send('task.setMain', { taskId: b.dataset.id }); openCard('main'); break;
      case 'clear-main': await send('task.setMain', { taskId: null }); openCard('main'); break;
      case 'add-save': {
        const title = val('#inAdd');
        if (!title) return;
        const later=$('#inLater')?.checked;
        const r = await send('task.add', { title, setMain: !later, ...(later?{date:null}:{}), at:$('#inTime')?.value });
        if (r.ok) openCard('main');
        break;
      }
      case 'chip': { const i = $('#inStep'); if (i) { i.value = b.dataset.v; } break; }
      case 'step-save':
      case 'step-start': {
        if (!t) return;
        await send('task.setNext', { taskId: t.id, next: val('#inStep') });
        if (act === 'step-start') { await startRound(t, 5); } else openCard('main');
        break;
      }
      case 'start': if (t) await startRound(t, Number(b.dataset.min) || 10); break;
      case 'pause': if (a) await send('timer.pause', { activeId: a.id }); break;
      case 'resume': if (a) { await send('timer.resume', { activeId: a.id }); closeBubble(true); } break;
      case 'extend': if (a) { await send('timer.extend', { activeId: a.id, minutes: 5 }); closeBubble(true); } break;
      case 'count-up': if (a) { await send('timer.countUp', { activeId: a.id }); closeBubble(true); } break;
      case 'end': if (a) { await send('timer.end', { activeId: a.id }); } break;
      case 'end-done':
      case 'end-continue':
      case 'end-rest': {
        if (!a) return;
        endingFlow = true;
        let r;
        try { r = await send('timer.end', { activeId: a.id }); } finally { endingFlow = false; }
        if (!r.ok || !r.recorded) return;
        if (act === 'end-done') await finishOutcome(r.sessionId, 'done');
        else if (act === 'end-continue') openCard('next', { sessionId: r.sessionId, suggest: a.step || '' });
        else { await send('rest.start', { minutes: 5 }); showNotice('休息一下，我帮你看着时间。'); }
        break;
      }
      case 'outcome-done': await finishOutcome(ui.sessionId, 'done', val('#inNote')); break;
      case 'outcome-continue': openCard('next', { sessionId: ui.sessionId, note: val('#inNote'), suggest: val('#inNote') || ui.step || '' }); break;
      case 'next-save':
      case 'next-skip': {
        const payload = { sessionId: ui.sessionId, outcome: 'continue', next: act === 'next-save' ? val('#inNext') : undefined };
        if (ui.note) payload.note = ui.note;
        await send('session.outcome', payload);
        closeBubble(true);
        showNotice('先留在这里，下次接着这一页。');
        break;
      }
      default: break;
    }
  });

  bubble.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input')) return;
    const primary = bubble.querySelector('button.acc');
    if (primary) primary.click();
  });

  missing.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) api.action(b.dataset.act);
  });
  chip.addEventListener('click', () => {
    if (view && view.active) openCard(view.active.phase === 'due' ? 'timeUp' : 'control');
  });
  dot.addEventListener('click', () => { const c = ui.card; ui.collapsed = false; openCard(c, ui); });

  async function startRound(t, minutes) {
    const r = await send('timer.start', { taskId: t.id, minutes });
    if (r.ok) closeBubble(true);
  }

  async function finishOutcome(sessionId, outcome, note) {
    const payload = { sessionId, outcome };
    if (note) payload.note = note;
    await send('session.outcome', payload);
    closeBubble(true);
  }

  // ---------------------------------------------------------- focus handling

  function requestFocus(input) {
    pendingFocus = input;
    input.addEventListener('pointerdown', () => { pendingFocus = input; api.wantFocus(); }, { once: true });
    api.wantFocus();
  }
  api.onFocusGranted(() => { if (pendingFocus && document.contains(pendingFocus)) { pendingFocus.focus(); pendingFocus.select(); } pendingFocus = null; });
  bubble.addEventListener('focusout', () => {
    setTimeout(() => { if (!bubble.contains(document.activeElement)) api.releaseFocus(); }, 0);
  });

  // ----------------------------------------------------------------- layout

  const MIN_SIDE_BUBBLE = 180; // narrower than this beside the figure -> place above instead

  function placeBubble() {
    if (!layout || bubble.hidden) return;
    const f = layout.fig, W = layout.winW, s = bubble.style;
    const roomLeft = f.x + f.w * 0.1 - 6;
    const roomRight = W - (f.x + f.w * 0.9) - 6;
    const side = layout.side === 'left'
      ? (roomLeft >= MIN_SIDE_BUBBLE ? 'left' : roomRight >= MIN_SIDE_BUBBLE ? 'right' : 'above')
      : (roomRight >= MIN_SIDE_BUBBLE ? 'right' : roomLeft >= MIN_SIDE_BUBBLE ? 'left' : 'above');
    if (side === 'above') {
      // Above the figure, centred on the feet anchor, inside the window.
      const width = Math.min(250, W - 12);
      s.bottom = (layout.winH - f.y + 8) + 'px'; s.top = 'auto';
      s.maxHeight = Math.max(60, f.y - 14) + 'px';
      s.maxWidth = width + 'px';
      s.left = Math.max(6, Math.min(W - width - 6, layout.foot.x - width / 2)) + 'px'; s.right = 'auto';
      return;
    }
    const bottomY = f.y + f.h * 0.42;                  // bubble bottom sits beside the upper body
    s.maxHeight = Math.max(80, bottomY - 6) + 'px';
    s.bottom = (layout.winH - bottomY) + 'px';
    s.top = 'auto';
    if (side === 'left') {
      s.right = (W - (f.x + f.w * 0.1)) + 'px'; s.left = 'auto';
      s.maxWidth = Math.min(250, roomLeft) + 'px';
    } else {
      s.left = (f.x + f.w * 0.9) + 'px'; s.right = 'auto';
      s.maxWidth = Math.min(250, roomRight) + 'px';
    }
  }

  function placeDot() {
    if (!layout) return;
    const f = layout.fig;
    dot.style.left = (layout.side === 'left' ? f.x + f.w * 0.2 : f.x + f.w * 0.8 - 16) + 'px';
    dot.style.top = (f.y + f.h * 0.22) + 'px';
  }

  function placeChip() {
    if (!layout || chip.hidden) return;
    const f = layout.fig, W = layout.winW, cw = chip.offsetWidth + 4, s = chip.style;
    const fitsLeft = f.x - cw >= 2, fitsRight = f.x + f.w + cw <= W - 2;
    const side = layout.side === 'left' ? (fitsLeft ? 'left' : fitsRight ? 'right' : 'above')
      : (fitsRight ? 'right' : fitsLeft ? 'left' : 'above');
    s.right = 'auto';
    if (side === 'above') {
      s.top = Math.max(2, f.y - chip.offsetHeight - 6) + 'px';
      s.left = Math.max(2, Math.min(W - cw, layout.foot.x - cw / 2)) + 'px';
    } else {
      s.top = (f.y + f.h * 0.72) + 'px';
      s.left = (side === 'left' ? f.x - cw : f.x + f.w + 4) + 'px';
    }
  }

  function placeMissing() {
    if (!layout) return;
    const r = layout.img;
    Object.assign(missing.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }

  // ------------------------------------------------------------- ticking

  function tick() {
    const a = view && view.active;
    const rest = view && view.rest;
    if (a) {
      const e = el(a);
      const txt = a.phase === 'due' ? '时间到' : a.mode === 'down' ? clock(a.budget - e) : '↑ ' + clock(e);
      chip.hidden = false;
      chip.className = a.phase;
      chip.innerHTML = `<i></i><span>${a.phase === 'paused' ? '已暂停 ' + clock(e) : txt}</span>`;
      const c = bubble.querySelector('[data-clk]');
      if (c) c.textContent = a.phase === 'paused' ? '已暂停 · ' + clock(e) : txt;
    } else if (rest) {
      chip.hidden = false;
      chip.className = 'rest';
      chip.innerHTML = `<i></i><span>休息 ${clock(rest.endsAt - Date.now())}</span>`;
    } else chip.hidden = true;
    placeChip();
    if (doneFlashUntil && Date.now() >= doneFlashUntil) { doneFlashUntil = 0; updateState(); }
  }
  setInterval(tick, 250);

  // ------------------------------------------------------- main -> renderer

  api.onLayout((l) => {
    layout = l;
    renderer.setRect(l.img);
    placeMissing(); placeBubble(); placeChip(); placeDot();
  });

  api.onPack(async (p) => {
    pack = p;
    missing.hidden = !!p.loaded;
    if (!p.loaded) {
      const reason = p.errors && p.errors.length ? p.errors[0] : '请把资源包放进角色资源文件夹，或从托盘「角色资源包」中选择。';
      $('#missingReason').textContent = reason;
    }
    await renderer.setPack(p);
    updateState();
  });

  api.onMode((m) => {
    mode = m;
    document.body.classList.toggle('reduced-motion',!!m.reducedMotion);
    if (m.passthrough) { setHit(false); if (ui.card && ui.card !== 'notice') closeBubble(true); }
  });

  api.onView((v) => {
    const hadActive = view && view.active;
    view = v;
    // Close cards that no longer match the data (e.g. round ended in the main window).
    if (ui.card === 'control' && !v.active) closeBubble(true);
    if (ui.card === 'timeUp' && (!v.active || v.active.phase !== 'due')) closeBubble(true);
    if (ui.card === 'reminder' && !v.reminder) closeBubble(true);
    if (ui.card && !bubble.hidden && ['main', 'pick', 'control'].includes(ui.card)) renderBubble();
    if (!hadActive && v.active && ui.card === 'main') closeBubble(true);
    tick();
    updateState();
  });

  api.onEvent((ev) => {
    const local = Date.now() - localActionAt < 3000;
    const quiet = mode.quiet;
    switch (ev.type) {
      case 'timeUp': if (!quiet && !mode.passthrough) openCard('timeUp'); break;
      case 'ended': if (local && !endingFlow) openCard('outcome', { sessionId: ev.sessionId, minutes: ev.minutes, step: ev.step || '' }); break;
      case 'done':
        doneFlashUntil = Date.now() + 2500;
        updateState();
        if (local) showNotice('这一小步，拿下了。', 3000);
        break;
      case 'autoPaused': if (!quiet && !mode.passthrough) openCard('reminder'); break;
      case 'restEnded': if (!quiet && !mode.passthrough) openCard('restEnd'); break;
      case 'autoFinalized': if (!quiet) showNotice('这一轮已经自动记下（结果待定），之后可以在回看里补充。'); break;
      case 'notice': showNotice(ev.text, 8000); break;
      case 'gentleReminder': if(!quiet&&!mode.passthrough&&!ui.card)openCard('gentle',{text:ev.text,review:ev.review});break;
      case 'review': openCard('review');break;
      default: break;
    }
  });

  api.onAppear(() => { setHit(false); });

  // Diagnostics hooks used by the automated self-test.
  window.__petProbe = (x, y) => ({ hit: hitTest(x, y), figure: renderer.hitTest(x, y) });
  window.__petInfo = () => ({ state: currentState(), assetState: renderer.shown, layout, packLoaded: !!(pack && pack.loaded), card: ui.card });
  window.__petClickCharacter = () => onCharacterClick();
})();
