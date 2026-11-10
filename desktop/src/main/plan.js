'use strict';
// Planning layer of the Core: goal tree, week plans, reviews, and the
// read-only queries built on top of them. Everything here is pure data logic
// (no Electron), mixed into Core's command table by core.js.
//
// Rules that keep the records trustworthy:
//   * Sessions are evidence. Nothing in this file creates or edits a session.
//   * Facts (minutes, counts) are always computed from sessions on demand and
//     never stored, so an AI draft or a user note can never overwrite them.
//   * Multi-item writes (applyDraft) validate everything first, then mutate.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const uid = (p, now) => p + '_' + now.toString(36) + Math.random().toString(36).slice(2, 7);

function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function isDate(s) { return typeof s === 'string' && DATE_RE.test(s) && ymd(parseYmd(s)) === s; }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
/** Monday of the week containing the given date. */
function weekStartOf(s) { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
function weekDays(ws) { return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(ws, i)); }
const round2 = (n) => Math.round(n * 100) / 100;
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const estOf = (v, fallback) => (Number(v) > 0 ? Math.min(600, Math.round(Number(v))) : fallback);

const LIMITS = { goalDepth: 6, draftGoals: 60, draftTasks: 120, weekItems: 80 };
const GOAL_STATUS = ['active', 'done', 'dropped'];
const ORIGINS = ['user', 'agent'];
const originOf = (v) => (ORIGINS.includes(v) ? v : 'user');

// ---------------------------------------------------------------- helpers

function goalById(S, id) { return S.goals.find((g) => g.id === id) || null; }

function goalDepth(S, id) {
  let depth = 0;
  for (let g = goalById(S, id); g; g = g.parentId ? goalById(S, g.parentId) : null) {
    if (++depth > 50) break; // corrupted cycle guard
  }
  return depth;
}

function subtreeIds(S, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of S.goals) if (g.parentId && out.has(g.parentId) && !out.has(g.id)) { out.add(g.id); grew = true; }
  }
  return out;
}

function rootGoalId(S, id) {
  let g = goalById(S, id), guard = 0;
  while (g && g.parentId && guard++ < 50) g = goalById(S, g.parentId) || null;
  return g ? g.id : null;
}

function makeGoal(now, fields) {
  return {
    id: uid('g', now), parentId: fields.parentId || null, title: fields.title, note: fields.note || '',
    status: 'active', origin: originOf(fields.origin), createdAt: now, order: fields.order || 0,
  };
}

function makeTask(now, fields) {
  return {
    id: uid('t', now), title: fields.title, cat: fields.cat || 'other',
    date: fields.date === undefined ? null : fields.date, at: fields.at || null,
    est: estOf(fields.est, 30), done: false, doneAt: null, pin: false, createdAt: now,
    tree: null, check: false, legacy: null, next: null, nextAt: null,
    goalId: fields.goalId || null, week: fields.week || null, origin: originOf(fields.origin),
  };
}

function nextOrder(S, parentId) {
  return S.goals.filter((g) => (g.parentId || null) === (parentId || null)).reduce((m, g) => Math.max(m, g.order || 0), 0) + 1;
}

/** Flatten a nested draft into goal/task records without touching state. */
function flattenDraft(S, node, parentId, depth, origin, now, acc) {
  if (!node || typeof node !== 'object') throw new Error('目标草稿的格式不正确');
  const title = text(node.title, 150);
  if (!title) throw new Error('目标草稿里有节点缺少标题');
  if (depth > LIMITS.goalDepth) throw new Error(`目标树最多 ${LIMITS.goalDepth} 层`);
  const g = makeGoal(now, { title, note: text(node.note, 2000), parentId, origin, order: acc.order++ });
  acc.goals.push(g);
  if (acc.goals.length > LIMITS.draftGoals) throw new Error(`一次最多写入 ${LIMITS.draftGoals} 个目标节点`);
  for (const t of Array.isArray(node.tasks) ? node.tasks : []) {
    const tt = text(typeof t === 'string' ? t : t && t.title, 150);
    if (!tt) throw new Error(`「${title}」下有任务缺少标题`);
    acc.tasks.push(makeTask(now, { title: tt, est: t && t.est, goalId: g.id, origin, date: null }));
    if (acc.tasks.length > LIMITS.draftTasks) throw new Error(`一次最多写入 ${LIMITS.draftTasks} 个任务`);
  }
  for (const c of Array.isArray(node.children) ? node.children : []) flattenDraft(S, c, g.id, depth + 1, origin, now, acc);
  return g;
}

function reviewKeyOk(scope, key) {
  if (scope === 'day') return isDate(key);
  if (scope === 'week') return isDate(key) && weekStartOf(key) === key;
  return false;
}

function findReview(S, scope, key) { return S.reviews.find((r) => r.scope === scope && r.key === key) || null; }

function ensureReview(S, scope, key, now) {
  let r = findReview(S, scope, key);
  if (!r) { r = { id: uid('r', now), scope, key, reflection: '', aiDraft: null, createdAt: now, updatedAt: now }; S.reviews.push(r); }
  return r;
}

// ---------------------------------------------------------------- commands
// Each handler runs with `this` = Core, exactly like the handlers in core.js.

const handlers = {
  'task.update'(p) {
    const t = this.task(p.taskId);
    if (!t) return { ok: false, error: '找不到这个任务' };
    const S = this.S;
    if (p.title !== undefined) {
      const title = text(p.title, 150);
      if (!title) return { ok: false, error: '任务标题不能为空' };
      t.title = title;
    }
    if (p.goalId !== undefined) {
      if (p.goalId !== null && !goalById(S, p.goalId)) return { ok: false, error: '找不到这个目标' };
      t.goalId = p.goalId;
    }
    if (p.week !== undefined) {
      if (p.week !== null && !isDate(p.week)) return { ok: false, error: '周的日期格式不正确' };
      t.week = p.week === null ? null : weekStartOf(p.week);
    }
    if (p.est !== undefined) t.est = estOf(p.est, t.est || 30);
    if (p.cat !== undefined) t.cat = text(p.cat, 30) || 'other';
    if (p.pin !== undefined) t.pin = !!p.pin;
    if (p.date !== undefined) {
      if (p.date !== null && !isDate(p.date)) return { ok: false, error: '日期格式不正确' };
      t.date = p.date;
    }
    if (p.at !== undefined) t.at = TIME_RE.test(p.at || '') ? p.at : null;
    return {};
  },

  /** Add several tasks in one step (all or nothing). */
  'task.addMany'(p) {
    const S = this.S;
    const list = Array.isArray(p.tasks) ? p.tasks : [];
    if (!list.length) return { ok: false, error: '没有要添加的任务' };
    if (list.length > 40) return { ok: false, error: '一次最多添加 40 个任务' };
    const fresh = [];
    for (const n of list) {
      const title = text(n && n.title, 150);
      if (!title) return { ok: false, error: '有任务缺少标题' };
      if (n.date != null && !isDate(n.date)) return { ok: false, error: `「${title}」的日期格式不正确` };
      if (n.goalId && !goalById(S, n.goalId)) return { ok: false, error: `「${title}」关联的目标不存在` };
      fresh.push({ title, date: n.date || null, est: n.est, goalId: n.goalId || null, at: TIME_RE.test(n.at || '') ? n.at : null });
    }
    const now = this.now();
    const made = fresh.map((n) => makeTask(now, { ...n, week: n.date ? null : (p.week && isDate(p.week) ? weekStartOf(p.week) : null), origin: p.origin }));
    S.tasks.push(...made);
    return { taskIds: made.map((t) => t.id), added: made.length };
  },

  /** Removes the task only. Its sessions stay: they are the study record. */
  'task.delete'(p) {
    const S = this.S;
    const i = S.tasks.findIndex((t) => t.id === p.taskId);
    if (i < 0) return { ok: false, error: '找不到这个任务' };
    S.tasks.splice(i, 1);
    for (const day of Object.keys(S.main)) if (S.main[day] === p.taskId) delete S.main[day];
    if (S.active && S.active.taskId === p.taskId) S.active.taskId = null;
    return {};
  },

  'goal.add'(p) {
    const S = this.S;
    const title = text(p.title, 150);
    if (!title) return { ok: false, error: '目标标题不能为空' };
    const parentId = p.parentId || null;
    if (parentId && !goalById(S, parentId)) return { ok: false, error: '找不到上级目标' };
    if (parentId && goalDepth(S, parentId) >= LIMITS.goalDepth) return { ok: false, error: `目标树最多 ${LIMITS.goalDepth} 层` };
    const g = makeGoal(this.now(), { title, note: text(p.note, 2000), parentId, origin: p.origin, order: nextOrder(S, parentId) });
    S.goals.push(g);
    return { goalId: g.id };
  },

  'goal.update'(p) {
    const S = this.S;
    const g = goalById(S, p.goalId);
    if (!g) return { ok: false, error: '找不到这个目标' };
    if (p.title !== undefined) {
      const title = text(p.title, 150);
      if (!title) return { ok: false, error: '目标标题不能为空' };
      g.title = title;
    }
    if (p.note !== undefined) g.note = text(p.note, 2000);
    if (p.status !== undefined) {
      if (!GOAL_STATUS.includes(p.status)) return { ok: false, error: '未知的目标状态' };
      g.status = p.status;
    }
    if (p.parentId !== undefined) {
      const parentId = p.parentId || null;
      if (parentId && !goalById(S, parentId)) return { ok: false, error: '找不到上级目标' };
      if (parentId && subtreeIds(S, g.id).has(parentId)) return { ok: false, error: '不能把目标移到它自己的下级里' };
      g.parentId = parentId;
      g.order = nextOrder(S, parentId);
    }
    return {};
  },

  /** Deletes the goal and its sub-goals. Tasks survive and become unlinked. */
  'goal.delete'(p) {
    const S = this.S;
    if (!goalById(S, p.goalId)) return { ok: false, error: '找不到这个目标' };
    const gone = subtreeIds(S, p.goalId);
    S.goals = S.goals.filter((g) => !gone.has(g.id));
    let unlinked = 0;
    for (const t of S.tasks) if (t.goalId && gone.has(t.goalId)) { t.goalId = null; unlinked++; }
    for (const w of Object.values(S.weeks)) w.goalIds = (w.goalIds || []).filter((id) => !gone.has(id));
    return { removed: gone.size, unlinkedTasks: unlinked };
  },

  /** Write a whole (sub)tree at once: goals, sub-goals and their first tasks. */
  'goal.applyDraft'(p) {
    const S = this.S;
    const parentId = p.parentId || null;
    if (parentId && !goalById(S, parentId)) return { ok: false, error: '找不到上级目标' };
    const acc = { goals: [], tasks: [], order: nextOrder(S, parentId) };
    const startDepth = parentId ? goalDepth(S, parentId) + 1 : 1;
    const root = flattenDraft(S, p.tree, parentId, startDepth, originOf(p.origin), this.now(), acc);
    S.goals.push(...acc.goals);
    S.tasks.push(...acc.tasks);
    return { rootId: root.id, goals: acc.goals.length, tasks: acc.tasks.length };
  },

  'week.update'(p) {
    const S = this.S;
    if (!isDate(p.weekStart)) return { ok: false, error: '周的日期格式不正确' };
    const ws = weekStartOf(p.weekStart);
    if (p.goalIds !== undefined) {
      if (!Array.isArray(p.goalIds) || p.goalIds.some((id) => !goalById(S, id))) return { ok: false, error: '本周重点里有不存在的目标' };
    }
    const w = S.weeks[ws] || (S.weeks[ws] = { weekStart: ws, focus: '', goalIds: [], capacityMin: null, note: '', origin: 'user', updatedAt: 0 });
    if (p.focus !== undefined) w.focus = text(p.focus, 300);
    if (p.note !== undefined) w.note = text(p.note, 2000);
    if (p.goalIds !== undefined) w.goalIds = [...new Set(p.goalIds)].slice(0, 12);
    if (p.capacityMin !== undefined) w.capacityMin = Number(p.capacityMin) > 0 ? Math.min(10080, Math.round(Number(p.capacityMin))) : null;
    if (p.origin !== undefined) w.origin = originOf(p.origin);
    w.updatedAt = this.now();
    return { weekStart: ws };
  },

  /**
   * Apply a whole week plan: the focus line, which existing tasks go on which
   * day, and any new tasks. `date: null` means "this week, day not decided".
   */
  'week.applyDraft'(p) {
    const S = this.S;
    if (!isDate(p.weekStart)) return { ok: false, error: '周的日期格式不正确' };
    const ws = weekStartOf(p.weekStart);
    const days = weekDays(ws);
    const assign = Array.isArray(p.assign) ? p.assign : [];
    const add = Array.isArray(p.add) ? p.add : [];
    if (assign.length + add.length > LIMITS.weekItems) return { ok: false, error: `一周最多安排 ${LIMITS.weekItems} 项` };
    const dayOk = (d) => d == null || (isDate(d) && days.includes(d));
    for (const a of assign) {
      if (!this.task(a.taskId)) return { ok: false, error: '周计划里有不存在的任务' };
      if (!dayOk(a.date)) return { ok: false, error: '周计划里有日期不在这一周内' };
    }
    const fresh = [];
    for (const n of add) {
      const title = text(n && n.title, 150);
      if (!title) return { ok: false, error: '周计划里有新任务缺少标题' };
      if (!dayOk(n.date)) return { ok: false, error: '周计划里有日期不在这一周内' };
      if (n.goalId && !goalById(S, n.goalId)) return { ok: false, error: '周计划里有不存在的目标' };
      fresh.push({ title, date: n.date || null, est: n.est, goalId: n.goalId || null, at: TIME_RE.test(n.at || '') ? n.at : null });
    }
    if (p.goalIds !== undefined && (!Array.isArray(p.goalIds) || p.goalIds.some((id) => !goalById(S, id)))) {
      return { ok: false, error: '本周重点里有不存在的目标' };
    }
    // -- validated; mutate
    const now = this.now();
    const origin = originOf(p.origin);
    const r = handlers['week.update'].call(this, {
      weekStart: ws, origin,
      ...(p.focus !== undefined ? { focus: p.focus } : {}),
      ...(p.note !== undefined ? { note: p.note } : {}),
      ...(p.goalIds !== undefined ? { goalIds: p.goalIds } : {}),
      ...(p.capacityMin !== undefined ? { capacityMin: p.capacityMin } : {}),
    });
    if (r.ok === false) return r;
    for (const a of assign) { const t = this.task(a.taskId); t.date = a.date || null; t.week = ws; }
    for (const n of fresh) S.tasks.push(makeTask(now, { ...n, week: ws, origin }));
    return { weekStart: ws, assigned: assign.length, added: fresh.length };
  },

  /** The user's own words. Kept apart from the AI draft on purpose. */
  'review.save'(p) {
    if (!reviewKeyOk(p.scope, p.key)) return { ok: false, error: '复盘的日期不正确' };
    const now = this.now();
    const r = ensureReview(this.S, p.scope, p.key, now);
    r.reflection = text(p.reflection, 8000);
    r.updatedAt = now;
    return { reviewId: r.id };
  },

  /** An AI-written draft; always stored with its model so it stays labelled. */
  'review.setDraft'(p) {
    if (!reviewKeyOk(p.scope, p.key)) return { ok: false, error: '复盘的日期不正确' };
    const body = text(p.text, 12000);
    if (!body) return { ok: false, error: 'AI 草稿是空的' };
    const now = this.now();
    const r = ensureReview(this.S, p.scope, p.key, now);
    r.aiDraft = { text: body, model: text(p.model, 120) || null, at: now };
    r.updatedAt = now;
    return { reviewId: r.id };
  },

  'review.clearDraft'(p) {
    const r = findReview(this.S, p.scope, p.key);
    if (!r) return {};
    r.aiDraft = null;
    r.updatedAt = this.now();
    return {};
  },
};

// ----------------------------------------------------------------- queries

function sessionsBetween(S, from, to) { return S.sessions.filter((s) => s.date >= from && s.date <= to); }
const sumMin = (list) => round2(list.reduce((n, s) => n + (s.minutes || 0), 0));

/** Group sessions by task, keeping "no task" rounds as their own rows. */
function byTask(S, sessions) {
  const rows = new Map();
  for (const s of sessions) {
    const key = s.taskId || 'free:' + s.title;
    let row = rows.get(key);
    if (!row) {
      const t = s.taskId ? S.tasks.find((x) => x.id === s.taskId) : null;
      row = {
        taskId: s.taskId || null, title: t ? t.title : s.title, minutes: 0, count: 0,
        done: t ? !!t.done : null, next: t ? t.next || null : null, goalId: t ? t.goalId || null : null,
        taskDeleted: !!(s.taskId && !t), notes: [],
      };
      rows.set(key, row);
    }
    row.minutes = round2(row.minutes + (s.minutes || 0));
    row.count++;
    if (s.note) row.notes.push(s.note);
  }
  return [...rows.values()].sort((a, b) => b.minutes - a.minutes);
}

/**
 * Facts for one day. "noRecord" lists tasks planned for the day that have no
 * timer session: that is a statement about the record, not about the study.
 */
function dayFacts(S, date) {
  const sessions = S.sessions.filter((s) => s.date === date);
  const worked = byTask(S, sessions);
  const seen = new Set(worked.map((r) => r.taskId).filter(Boolean));
  const planned = S.tasks.filter((t) => t.date === date);
  return {
    scope: 'day', key: date,
    minutes: sumMin(sessions), count: sessions.length,
    tasks: worked,
    noRecord: planned.filter((t) => !seen.has(t.id)).map((t) => ({ taskId: t.id, title: t.title, done: !!t.done, est: t.est })),
    planned: planned.length, plannedDone: planned.filter((t) => t.done).length,
    review: findReview(S, 'day', date),
  };
}

function tasksOfWeek(S, ws) {
  const end = addDays(ws, 6);
  return S.tasks.filter((t) => (t.date && t.date >= ws && t.date <= end) || (!t.date && t.week === ws));
}

function weekFacts(S, weekStart) {
  const ws = weekStartOf(weekStart);
  const days = weekDays(ws);
  const sessions = sessionsBetween(S, ws, days[6]);
  const planned = tasksOfWeek(S, ws);
  const worked = byTask(S, sessions);
  const goalMin = new Map();
  for (const r of worked) {
    const root = r.goalId ? rootGoalId(S, r.goalId) : null;
    goalMin.set(root, round2((goalMin.get(root) || 0) + r.minutes));
  }
  return {
    scope: 'week', key: ws, days,
    minutes: sumMin(sessions), count: sessions.length,
    perDay: days.map((d) => ({ date: d, minutes: sumMin(sessions.filter((s) => s.date === d)), count: sessions.filter((s) => s.date === d).length })),
    tasks: worked,
    goals: [...goalMin.entries()].map(([id, minutes]) => ({ goalId: id, title: id ? (goalById(S, id) || {}).title || '（已删除的目标）' : '未关联目标', minutes }))
      .sort((a, b) => b.minutes - a.minutes),
    planned: planned.length, plannedDone: planned.filter((t) => t.done).length,
    plannedMinutes: planned.reduce((n, t) => n + (t.est || 0), 0),
    noRecord: planned.filter((t) => !t.done && !sessions.some((s) => s.taskId === t.id)).map((t) => ({ taskId: t.id, title: t.title, date: t.date })),
    plan: S.weeks[ws] || null,
    review: findReview(S, 'week', ws),
  };
}

/** Average recorded minutes per week over the last `n` full weeks. */
function recentWeeklyMinutes(S, today, n = 4) {
  const thisWeek = weekStartOf(today);
  const weeks = [];
  for (let i = 1; i <= n; i++) {
    const ws = addDays(thisWeek, -7 * i);
    weeks.push({ weekStart: ws, minutes: sumMin(sessionsBetween(S, ws, addDays(ws, 6))) });
  }
  const withData = weeks.filter((w) => w.minutes > 0);
  return { weeks, average: withData.length ? round2(withData.reduce((a, w) => a + w.minutes, 0) / withData.length) : null };
}

function weekView(S, weekStart) {
  const ws = weekStartOf(weekStart);
  const tasks = tasksOfWeek(S, ws);
  return {
    weekStart: ws, days: weekDays(ws), plan: S.weeks[ws] || null,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, date: t.date, at: t.at || null, est: t.est, done: !!t.done, goalId: t.goalId || null, next: t.next || null })),
  };
}

/** Nested goal tree with each node's tasks and recorded minutes (subtree total). */
function goalTree(S) {
  const minutesByTask = new Map();
  for (const s of S.sessions) if (s.taskId) minutesByTask.set(s.taskId, (minutesByTask.get(s.taskId) || 0) + (s.minutes || 0));
  const build = (g) => {
    const tasks = S.tasks.filter((t) => t.goalId === g.id).map((t) => ({
      id: t.id, title: t.title, done: !!t.done, date: t.date, est: t.est, next: t.next || null,
      minutes: round2(minutesByTask.get(t.id) || 0), origin: t.origin || 'user',
    }));
    const children = S.goals.filter((c) => c.parentId === g.id).sort((a, b) => (a.order || 0) - (b.order || 0)).map(build);
    const minutes = round2(tasks.reduce((n, t) => n + t.minutes, 0) + children.reduce((n, c) => n + c.minutes, 0));
    const total = tasks.length + children.reduce((n, c) => n + c.taskCount, 0);
    const done = tasks.filter((t) => t.done).length + children.reduce((n, c) => n + c.taskDone, 0);
    return { id: g.id, title: g.title, note: g.note || '', status: g.status, origin: g.origin, tasks, children, minutes, taskCount: total, taskDone: done };
  };
  return S.goals.filter((g) => !g.parentId || !goalById(S, g.parentId)).sort((a, b) => (a.order || 0) - (b.order || 0)).map(build);
}

const queries = {
  'day.facts': (S, a) => (isDate(a && a.date) ? dayFacts(S, a.date) : null),
  'week.facts': (S, a) => (isDate(a && a.weekStart) ? weekFacts(S, a.weekStart) : null),
  'week.view': (S, a) => (isDate(a && a.weekStart) ? weekView(S, a.weekStart) : null),
  'goal.tree': (S) => goalTree(S),
  'week.recent': (S, a) => (isDate(a && a.today) ? recentWeeklyMinutes(S, a.today, a.weeks) : null),
};

module.exports = {
  handlers, queries, LIMITS,
  dayFacts, weekFacts, weekView, goalTree, recentWeeklyMinutes, tasksOfWeek,
  weekStartOf, weekDays, addDays, isDate, ymd, goalById, subtreeIds,
};
