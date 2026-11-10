'use strict';
// Core: the single owner of T计划 data, the single active timer, and record
// saving. Runs in the Electron main process; windows only send commands and
// render snapshots. No Electron imports, so it is unit-tested with a fake clock.
//
// The data shape is compatible with the existing T计划 HTML (`tplan.v3`):
// tasks, main, sessions, notes, trees, active, settings. Desktop-only runtime
// fields live under `desktop` so they never collide with the web app's fields.

const { EventEmitter } = require('node:events');
const plan = require('./plan');

// Data schema. 1 = the original pet build (tasks / sessions only).
// 2 = adds goals, week plans, reviews, and goalId / week / origin on tasks.
const SCHEMA = 2;

const MIN = 60000;
const DUE_AUTO_FINALIZE_MS = 15 * MIN;  // unanswered time-up closes the round

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const dateOfMs = (ms) => ymd(new Date(ms));
const uid = (p, now) => p + '_' + now.toString(36) + Math.random().toString(36).slice(2, 7);

function emptyState() {
  return {
    app: 'tplan', v: 1, schema: SCHEMA, sample: false,
    tasks: [], main: {}, sessions: [], notes: [], trees: [],
    goals: [], weeks: {}, reviews: [],
    active: null, archive: null, settings: { cap: 180 },
    desktop: { rev: 0, rest: null, reminder: null, lastEnded: null, nudges: {day:'',count:0,seen:[]} },
  };
}

/** Same defaults as the web app's normalize(), plus the desktop block. */
function normalize(o) {
  const e = emptyState();
  o = o && typeof o === 'object' ? o : {};
  for (const k of Object.keys(e)) if (o[k] === undefined) o[k] = e[k];
  for (const k of ['tasks', 'sessions', 'notes', 'trees', 'goals', 'reviews']) if (!Array.isArray(o[k])) o[k] = [];
  if (!o.weeks || typeof o.weeks !== 'object' || Array.isArray(o.weeks)) o.weeks = {};
  if (!o.settings || typeof o.settings !== 'object') o.settings = { cap: 180 };
  if (!o.main || typeof o.main !== 'object') o.main = {};
  if (!o.desktop || typeof o.desktop !== 'object') o.desktop = e.desktop;
  for (const k of Object.keys(e.desktop)) if (o.desktop[k] === undefined) o.desktop[k] = e.desktop[k];
  delete o.ui;
  return o;
}

/**
 * Bring normalized data up to the current schema. Only adds fields and drops
 * links that point at nothing; it never removes tasks or sessions.
 */
function migrate(o) {
  const goalIds = new Set(o.goals.map((g) => g.id));
  for (const t of o.tasks) {
    if (t.goalId === undefined || (t.goalId && !goalIds.has(t.goalId))) t.goalId = null;
    if (t.week === undefined) t.week = null;
    if (t.origin === undefined) t.origin = 'user';
  }
  for (const g of o.goals) if (g.parentId && !goalIds.has(g.parentId)) g.parentId = null;
  for (const w of Object.values(o.weeks)) w.goalIds = (w.goalIds || []).filter((id) => goalIds.has(id));
  o.schema = SCHEMA;
  return o;
}

/** Elapsed ms of a round (identical formula to the web app's el()). */
function elapsed(a, now) {
  if (!a) return 0;
  let e = a.acc + (a.phase === 'running' ? now - a.lastAt : 0);
  if (a.mode === 'down') e = Math.min(e, a.budget);
  return Math.max(0, e);
}

class Core extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => number} [deps.now]
   * @param {(fn: Function, ms: number) => any} [deps.setTimer]
   * @param {(h: any) => void} [deps.clearTimer]
   * @param {() => object|null} deps.read          load persisted state
   * @param {(state: object) => void} deps.write   persist state (atomic)
   * @param {(raw: object, fromSchema: number) => void} [deps.backup]
   *        called with the untouched data before a schema upgrade rewrites it
   */
  constructor(deps) {
    super();
    this.now = deps.now || Date.now;
    this.setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer || ((h) => clearTimeout(h));
    this.read = deps.read;
    this.write = deps.write;
    this.backup = deps.backup || null;
    this.timers = { due: null, finalize: null, rest: null };
    this.pendingEvents = [];
    this.S = emptyState();
  }

  // ---------------------------------------------------------------- lifecycle

  load() {
    const raw = this.read(); // corrupted data must not silently become an empty database
    const from = raw && typeof raw === 'object' ? Number(raw.schema) || 1 : SCHEMA;
    if (from > SCHEMA) throw new Error('学习数据来自更新版本的 T计划，请升级程序后再打开。');
    if (raw && from < SCHEMA && this.backup) this.backup(raw, from);
    this.S = migrate(normalize(raw));
    this.recoverOnStart();
    this.persist();
  }

  /** Apply the restart / crash rules to a persisted active round. */
  recoverOnStart() {
    const a = this.S.active, now = this.now();
    if (a && a.phase === 'running') {
      const last = Math.max(a.beat || 0, a.lastAt || 0);
      // Every new process excludes downtime, including a quick restart.
      if (a.mode === 'down' && elapsed(a, last) >= a.budget) this.markDue(last);
      else this.pauseRound('crash', last);
    }
    this.armTimers();
  }

  /** Called by the main process every ~10 s while the app runs. */
  heartbeat() {
    const a = this.S.active;
    if (a && a.phase === 'running') { a.beat = this.now(); this.persist(); }
  }

  /** Sleep / quit / session end: stop counting now, remember why. */
  autoPause(reason) {
    const a = this.S.active;
    if (!a || a.phase !== 'running') return false;
    this.pauseRound(reason, this.now());
    this.commit();
    return true;
  }

  // ----------------------------------------------------------------- commands

  /**
   * Single entry point for every change from every window. Commands are
   * processed one at a time (the main process is single-threaded), and timer
   * commands must name the round they act on, so a stale or duplicated command
   * becomes a harmless no-op instead of a second record.
   */
  dispatch(cmd) {
    const type = cmd && cmd.type;
    const p = (cmd && cmd.payload) || {};
    const h = this.handlers[type];
    if (!h) return { ok: false, error: `未知命令：${type}` };
    try {
      const r = h.call(this, p) || {};
      if (r.ok === false) return r;
      this.commit();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Would this command succeed? Runs it against the live state and then puts
   * the state back, so nothing is saved and no event is emitted. Used to
   * validate an agent proposal before showing it to the user.
   */
  check(cmd) {
    const h = this.handlers[cmd && cmd.type];
    if (!h) return { ok: false, error: `未知命令：${cmd && cmd.type}` };
    const saved = JSON.stringify(this.S);
    const events = this.pendingEvents.length;
    try {
      const r = h.call(this, (cmd && cmd.payload) || {}) || {};
      return r.ok === false ? r : { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      this.S = JSON.parse(saved);
      this.pendingEvents.length = events;
    }
  }

  get handlers() {
    return {
      'task.add': this.cmdTaskAdd,
      'task.setMain': this.cmdTaskSetMain,
      'task.setNext': this.cmdTaskSetNext,
      'task.setDone': this.cmdTaskSetDone,
      'task.schedule': this.cmdTaskSchedule,
      'settings.update': this.cmdSettingsUpdate,
      'timer.start': this.cmdTimerStart,
      'timer.pause': this.cmdTimerPause,
      'timer.resume': this.cmdTimerResume,
      'timer.extend': this.cmdTimerExtend,
      'timer.countUp': this.cmdTimerCountUp,
      'timer.end': this.cmdTimerEnd,
      'session.outcome': this.cmdSessionOutcome,
      'rest.start': this.cmdRestStart,
      'rest.end': this.cmdRestEnd,
      'reminder.dismiss': this.cmdReminderDismiss,
      'data.import': this.cmdImport,
      ...plan.handlers,
    };
  }

  task(id) { return this.S.tasks.find((t) => t.id === id) || null; }

  /** Read-only questions about the data (facts, week view, goal tree). */
  query(name, args) {
    const q = plan.queries[name];
    if (!q) return { ok: false, error: `未知查询：${name}` };
    try {
      return { ok: true, data: JSON.parse(JSON.stringify(q(this.S, args || {}))) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  cmdTaskAdd(p) {
    const title = String(p.title || '').trim().slice(0, 150);
    if (!title) return { ok: false, error: '任务标题不能为空' };
    const now = this.now();
    if (p.goalId && !plan.goalById(this.S, p.goalId)) return { ok: false, error: '找不到这个目标' };
    if (p.date && !plan.isDate(p.date)) return { ok: false, error: '日期格式不正确' };
    if (p.week && !plan.isDate(p.week)) return { ok: false, error: '周的日期格式不正确' };
    const t = {
      id: uid('t', now), title, cat: p.cat || 'other', date: p.date === null ? null : (p.date || dateOfMs(now)),
      at: /^([01]\d|2[0-3]):[0-5]\d$/.test(p.at || '') ? p.at : null, est: Number(p.est) > 0 ? Math.min(600,Math.round(p.est)) : 30, done: false, doneAt: null, pin: false,
      createdAt: now, tree: null, check: false, legacy: null, next: null, nextAt: null,
      goalId: p.goalId || null, week: p.week ? plan.weekStartOf(p.week) : null, origin: p.origin === 'agent' ? 'agent' : 'user',
    };
    this.S.tasks.push(t);
    if (p.setMain) this.S.main[dateOfMs(now)] = t.id;
    return { taskId: t.id };
  }

  cmdTaskSetMain(p) {
    const day = dateOfMs(this.now());
    if (p.taskId == null) { delete this.S.main[day]; return {}; }
    if (!this.task(p.taskId)) return { ok: false, error: '找不到这个任务' };
    this.S.main[day] = p.taskId;
    return {};
  }

  cmdTaskSchedule(p) {
    const t = this.task(p.taskId);
    if (!t) return {ok:false,error:'找不到这个任务'};
    if (p.date !== null && !plan.isDate(p.date)) return {ok:false,error:'日期格式不正确'};
    t.date = p.date;
    if (p.at !== undefined) t.at = /^([01]\d|2[0-3]):[0-5]\d$/.test(p.at || '') ? p.at : null;
    return {};
  }

  cmdSettingsUpdate(p) {
    if (typeof p.eveningReview === 'boolean') this.S.settings.eveningReview = p.eveningReview;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(p.reviewTime || '')) this.S.settings.reviewTime = p.reviewTime;
    return {};
  }

  checkReminders(quiet) {
    if (quiet || this.S.active || this.S.desktop.rest) return;
    const now = this.now(), day = dateOfMs(now), d = new Date(now), hm = pad(d.getHours())+':'+pad(d.getMinutes());
    if (this.S.desktop.nudges.day !== day) this.S.desktop.nudges = {day,count:0,seen:[]};
    const n = this.S.desktop.nudges;
    if (n.count >= 4 || (n.lastAt && now-n.lastAt < 30*MIN)) return;
    const task = this.S.tasks.find(t => !t.done && t.date === day && t.at && t.at <= hm && !n.seen.includes(t.id));
    const review = this.S.settings.eveningReview && hm >= (this.S.settings.reviewTime || '21:00') && !n.seen.includes('review');
    if (!task && !review) return;
    n.count++; n.lastAt=now; n.seen.push(task ? task.id : 'review');
    this.emitLater({type:'gentleReminder',taskId:task?.id,review:!task,text:task?`「${task.title}」到约定时间了。准备好再开始。`:'今天的记录已整理好，想看一眼吗？'});
    this.commit();
  }

  cmdTaskSetNext(p) {
    const t = this.task(p.taskId);
    if (!t) return { ok: false, error: '找不到这个任务' };
    const next = String(p.next || '').trim().slice(0, 200);
    t.next = next || null;
    t.nextAt = next ? this.now() : null;
    return {};
  }

  cmdTaskSetDone(p) {
    const t = this.task(p.taskId);
    if (!t) return { ok: false, error: '找不到这个任务' };
    t.done = !!p.done;
    t.doneAt = t.done ? this.now() : null;
    if (t.done) this.emitLater({ type: 'done', taskId: t.id });
    return {};
  }

  cmdTimerStart(p) {
    if (this.S.active) return { ok: false, error: '先结束当前这一轮', activeId: this.S.active.id };
    const t = p.taskId ? this.task(p.taskId) : null;
    if (p.taskId && !t) return { ok: false, error: '找不到这个任务' };
    const title = String(p.title || (t && t.title) || '').trim().slice(0, 150);
    if (!title) return { ok: false, error: '这一轮要做什么？' };
    const up = p.minutes === 'up';
    const mins = up ? 0 : Math.max(1, Math.min(600, Math.round(Number(p.minutes) || 25)));
    const now = this.now();
    this.S.desktop.rest = null;
    this.S.desktop.reminder = null;
    this.S.active = {
      id: uid('s', now), title, taskId: t ? t.id : null, cat: (t && t.cat) || 'other', course: null,
      mode: up ? 'up' : 'down', budget: mins * MIN, startedAt: now, lastAt: now, acc: 0,
      phase: 'running', pauses: 0, endedAt: null,
      // desktop additions
      step: p.step ? String(p.step).slice(0, 200) : (t && t.next) || null,
      src: p.src === 'main' ? 'timer' : 'pet', beat: now, dueAt: null, dueNotified: false,
      sessionWritten: false, autoPaused: null,
    };
    return { activeId: this.S.active.id };
  }

  /** Guard: the command must target the current round. */
  current(p, phases) {
    const a = this.S.active;
    if (!a || a.id !== p.activeId) return { err: { ok: false, stale: true, error: '这一轮已经结束或已更换' } };
    if (phases && !phases.includes(a.phase)) return { err: { ok: false, stale: true, error: '计时状态已变化' } };
    return { a };
  }

  cmdTimerPause(p) {
    const { a, err } = this.current(p, ['running']);
    if (err) return err;
    this.pauseRound(null, this.now());
    a.pauses++;
    return {};
  }

  cmdTimerResume(p) {
    const { a, err } = this.current(p, ['paused']);
    if (err) return err;
    a.phase = 'running';
    a.lastAt = this.now();
    a.beat = a.lastAt;
    a.autoPaused = null;
    this.S.desktop.reminder = null;
    return {};
  }

  cmdTimerExtend(p) {
    const { a, err } = this.current(p, ['running', 'paused', 'due']);
    if (err) return err;
    if (a.mode !== 'down') return { ok: false, error: '正计时不需要加时' };
    a.budget += Math.max(1, Math.min(120, Math.round(Number(p.minutes) || 5))) * MIN;
    if (a.phase === 'due') { a.phase = 'running'; a.lastAt = this.now(); a.beat = a.lastAt; a.dueNotified = false; }
    return {};
  }

  cmdTimerCountUp(p) {
    const { a, err } = this.current(p, ['running', 'paused', 'due']);
    if (err) return err;
    a.mode = 'up';
    if (a.phase === 'due') { a.phase = 'running'; a.lastAt = this.now(); a.beat = a.lastAt; }
    return {};
  }

  cmdTimerEnd(p) {
    const { err } = this.current(p, ['running', 'paused', 'due']);
    if (err) return err;
    return this.endRound(this.now());
  }

  cmdSessionOutcome(p) {
    const s = this.S.sessions.find((x) => x.id === p.sessionId);
    if (!s) return { ok: false, error: '找不到这段记录' };
    if (p.outcome !== undefined) {
      if (!['done', 'continue', null].includes(p.outcome)) return { ok: false, error: '未知的完成状态' };
      s.outcome = p.outcome;
    }
    if (typeof p.note === 'string') s.note = p.note.trim().slice(0, 2000);
    const t = s.taskId ? this.task(s.taskId) : null;
    if (t && p.outcome === 'done' && !t.done) {
      t.done = true; t.doneAt = this.now(); t.next = null;
      this.emitLater({ type: 'done', taskId: t.id, sessionId: s.id });
    }
    if (t && p.outcome === 'continue') {
      t.done = false;
      t.doneAt = null;
      if (typeof p.next === 'string') {
        t.next = p.next.trim().slice(0, 200) || null;
        t.nextAt = t.next ? this.now() : null;
      }
    }
    return {};
  }

  cmdRestStart(p) {
    if (this.S.active) return { ok: false, error: '先结束当前这一轮再休息' };
    const m = Math.max(1, Math.min(60, Math.round(Number(p.minutes) || 5)));
    const now = this.now();
    this.S.desktop.rest = { startedAt: now, endsAt: now + m * MIN };
    return {};
  }

  cmdRestEnd() {
    this.S.desktop.rest = null;
    return {};
  }

  cmdReminderDismiss() {
    this.S.desktop.reminder = null;
    return {};
  }

  /** Replace T计划 data from an export of the web app; keeps the running round. */
  cmdImport(p) {
    const src = p.state;
    if (!src || typeof src !== 'object' || !Array.isArray(src.tasks)) {
      return { ok: false, error: '不是有效的 T计划 导出文件（缺少 tasks）' };
    }
    const keep = { active: this.S.active, desktop: this.S.desktop };
    const from = Number(src.schema) || 1;
    if (from > SCHEMA) return { ok: false, error: '这份文件来自更新版本的 T计划，请升级程序后再导入。' };
    const next = migrate(normalize(JSON.parse(JSON.stringify(src))));
    next.active = keep.active;     // never interrupt the current round
    next.desktop = keep.desktop;
    this.S = next;
    return { tasks: next.tasks.length, sessions: next.sessions.length };
  }

  // ------------------------------------------------------------ timer engine

  pauseRound(reason, at) {
    const a = this.S.active;
    a.acc = elapsed(a, at);
    a.phase = 'paused';
    a.lastAt = at;
    if (reason) {
      a.autoPaused = reason;
      this.S.desktop.reminder = { kind: 'autoPaused', reason, activeId: a.id, elapsed: a.acc, at: this.now() };
      this.emitLater({ type: 'autoPaused', reason, activeId: a.id });
    }
  }

  /** Countdown reached zero: record the session immediately, alert once. */
  markDue(at) {
    const a = this.S.active;
    a.acc = a.budget;
    a.phase = 'due';
    a.lastAt = at;
    a.dueAt = at;
    this.upsertSession(a, at);
    if (!a.dueNotified) {
      a.dueNotified = true;
      this.emitLater({ type: 'timeUp', activeId: a.id, sessionId: a.id });
    }
  }

  /** One record per round: the session id IS the round id, writes are upserts. */
  upsertSession(a, endAt) {
    const durationMs = elapsed(a, endAt);
    const minutes = Math.round(durationMs / MIN * 100) / 100;
    let s = this.S.sessions.find((x) => x.id === a.id);
    if (!s) {
      s = {
        id: a.id, title: a.title, taskId: a.taskId, cat: a.cat, course: a.course || null,
        date: dateOfMs(a.startedAt), start: a.startedAt, end: endAt, minutes, durationMs,
        note: '', src: a.src || 'pet', outcome: null, step: a.step || null,
      };
      this.S.sessions.push(s);
    } else {
      s.end = endAt;
      s.minutes = minutes;
      s.durationMs = durationMs;
    }
    a.sessionWritten = true;
    return s;
  }

  endRound(at) {
    const a = this.S.active;
    const e = elapsed(a, at);
    this.S.active = null;
    this.S.desktop.reminder = null;
    const endAt = a.phase === 'due' ? a.dueAt : at; // a due round ended when time ran out
    a.acc = e; a.phase = 'ended'; a.endedAt = endAt;
    const s = this.upsertSession(a, endAt);
    this.S.desktop.lastEnded = { sessionId: s.id, taskId: s.taskId, minutes: s.minutes, at };
    this.emitLater({ type: 'ended', sessionId: s.id, minutes: s.minutes, taskId: s.taskId, step: s.step });
    return { recorded: true, sessionId: s.id, minutes: s.minutes };
  }

  armTimers() {
    for (const k of Object.keys(this.timers)) {
      if (this.timers[k]) this.clearTimer(this.timers[k]);
      this.timers[k] = null;
    }
    const a = this.S.active, now = this.now();
    if (a && a.phase === 'running' && a.mode === 'down') {
      const left = a.budget - elapsed(a, now);
      this.timers.due = this.setTimer(() => this.onDueTimer(), Math.max(0, left));
    }
    if (a && a.phase === 'due') {
      const left = (a.dueAt || now) + DUE_AUTO_FINALIZE_MS - now;
      this.timers.finalize = this.setTimer(() => this.onFinalizeTimer(), Math.max(0, left));
    }
    const r = this.S.desktop.rest;
    if (r) this.timers.rest = this.setTimer(() => this.onRestTimer(), Math.max(0, r.endsAt - now));
  }

  onDueTimer() {
    const a = this.S.active, now = this.now();
    if (!a || a.phase !== 'running' || a.mode !== 'down') return;
    if (elapsed(a, now) < a.budget) { this.armTimers(); return; } // timer fired early
    this.markDue(now);
    this.commit();
  }

  onFinalizeTimer() {
    const a = this.S.active;
    if (!a || a.phase !== 'due') return;
    this.endRound(a.dueAt);
    this.emitLater({ type: 'autoFinalized', sessionId: a.id });
    this.commit();
  }

  onRestTimer() {
    if (!this.S.desktop.rest) return;
    this.S.desktop.rest = null;
    this.emitLater({ type: 'restEnded' });
    this.commit();
  }

  // ------------------------------------------------------------- plumbing

  emitLater(ev) { this.pendingEvents.push({ ...ev, at: this.now() }); }

  commit() {
    this.S.desktop.rev++;
    this.armTimers();
    this.persist();
    const events = this.pendingEvents.splice(0);
    this.emit('change', this.S.desktop.rev);
    for (const ev of events) this.emit('event', ev);
  }

  persist() {
    this.write(this.S);
  }

  snapshot() { return JSON.parse(JSON.stringify(this.S)); }
}

/** Small view model for the pet window (it never needs the full history). */
function petView(S, now) {
  const today = dateOfMs(now);
  const mainId = S.main[today] || null;
  const mainTask = mainId ? S.tasks.find((t) => t.id === mainId) || null : null;
  const open = S.tasks
    .filter((t) => !t.done && (t.date == null || t.date <= today))
    .sort((x, y) => (y.id === mainId) - (x.id === mainId) || (y.pin === true) - (x.pin === true) ||
      String(x.date || '9999').localeCompare(String(y.date || '9999')) ||
      String(x.at || '99').localeCompare(String(y.at || '99')))
    .slice(0, 6)
    .map((t) => ({ id: t.id, title: t.title, date: t.date, at: t.at, est: t.est, next: t.next || null }));
  const todaySessions = S.sessions.filter((s) => s.date === today);
  const a = S.active;
  return {
    now,
    rev: S.desktop.rev,
    active: a ? {
      id: a.id, title: a.title, taskId: a.taskId, mode: a.mode, phase: a.phase, budget: a.budget,
      acc: a.acc, lastAt: a.lastAt, startedAt: a.startedAt, step: a.step, autoPaused: a.autoPaused,
    } : null,
    mainTask: mainTask ? { id: mainTask.id, title: mainTask.title, next: mainTask.next || null, est: mainTask.est, done: mainTask.done } : null,
    openTasks: open,
    today: { minutes: Math.round(todaySessions.reduce((n, s) => n + s.minutes, 0)*100)/100, count: todaySessions.length },
    reviewTasks: S.tasks.filter(t => t.date === today || todaySessions.some(s=>s.taskId===t.id)).map(t=>({id:t.id,title:t.title,done:!!t.done,next:t.next||null,recordCount:todaySessions.filter(s=>s.taskId===t.id).length,minutes:Math.round(todaySessions.filter(s=>s.taskId===t.id).reduce((n,s)=>n+s.minutes,0)*100)/100})),
    lastEnded: S.desktop.lastEnded,
    rest: S.desktop.rest,
    reminder: S.desktop.reminder,
  };
}

module.exports = { Core, SCHEMA, normalize, migrate, elapsed, petView, dateOfMs, MIN, DUE_AUTO_FINALIZE_MS };
