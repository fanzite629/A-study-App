'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core, SCHEMA, MIN } = require('../src/main/core');
const plan = require('../src/main/plan');

function harness(initial) {
  let now = new Date(2026, 10, 4, 9, 0, 0).getTime(); // Wednesday 2026-11-04
  let disk = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const backups = [];
  const core = new Core({
    now: () => now, setTimer: () => 0, clearTimer: () => {},
    read: () => disk && JSON.parse(JSON.stringify(disk)),
    write: (s) => { disk = JSON.parse(JSON.stringify(s)); },
    backup: (raw, from) => backups.push({ raw: JSON.parse(JSON.stringify(raw)), from }),
  });
  core.load();
  const d = (type, payload) => core.dispatch({ type, payload });
  return { core, d, backups, get disk() { return disk; }, advance(ms) { now += ms; } };
}

test('week helpers use Monday as the first day', () => {
  assert.equal(plan.weekStartOf('2026-11-04'), '2026-11-02');
  assert.equal(plan.weekStartOf('2026-11-08'), '2026-11-02'); // Sunday belongs to the same week
  assert.equal(plan.weekStartOf('2026-11-09'), '2026-11-09');
  assert.equal(plan.isDate('2026-02-30'), false);
});

test('schema 1 data is backed up, upgraded, and keeps every task and session', () => {
  const old = {
    app: 'tplan', v: 1, tasks: [{ id: 't1', title: '旧任务', date: '2026-11-03', est: 30, done: false }],
    sessions: [{ id: 's1', title: '旧任务', taskId: 't1', date: '2026-11-03', minutes: 12.5, durationMs: 750000 }],
    main: {}, settings: { cap: 180 },
  };
  const h = harness(old);
  assert.equal(h.backups.length, 1);
  assert.equal(h.backups[0].from, 1);
  assert.equal(h.backups[0].raw.schema, undefined);
  assert.equal(h.disk.schema, SCHEMA);
  assert.deepEqual(h.disk.sessions, old.sessions);
  assert.equal(h.disk.tasks[0].goalId, null);
  assert.equal(h.disk.tasks[0].origin, 'user');
  assert.deepEqual(h.disk.goals, []);
});

test('current-schema data is not backed up again; newer data is refused', () => {
  const h = harness();
  const h2 = harness(h.disk);
  assert.equal(h2.backups.length, 0);
  assert.throws(() => harness({ ...h.disk, schema: SCHEMA + 1 }), /更新版本/);
});

test('goal tree: add, nest, move, and refuse cycles', () => {
  const h = harness();
  const a = h.d('goal.add', { title: '考研数学' }).goalId;
  const b = h.d('goal.add', { title: '高数', parentId: a }).goalId;
  const c = h.d('goal.add', { title: '极限', parentId: b }).goalId;
  assert.equal(h.d('goal.update', { goalId: a, parentId: c }).ok, false);
  assert.equal(h.d('goal.update', { goalId: c, parentId: a }).ok, true);
  const tree = plan.goalTree(h.core.S);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map((x) => x.title), ['高数', '极限']);
  assert.equal(h.d('goal.add', { title: '', parentId: a }).ok, false);
  assert.equal(h.d('goal.add', { title: 'x', parentId: 'nope' }).ok, false);
});

test('deleting a goal removes its subtree but keeps the tasks and their records', () => {
  const h = harness();
  const a = h.d('goal.add', { title: 'A' }).goalId;
  const b = h.d('goal.add', { title: 'B', parentId: a }).goalId;
  const t = h.d('task.add', { title: '做题', goalId: b }).taskId;
  const { activeId } = h.d('timer.start', { taskId: t, minutes: 'up' });
  h.advance(3 * MIN);
  h.d('timer.end', { activeId });
  h.d('week.update', { weekStart: '2026-11-04', goalIds: [a] });
  const r = h.d('goal.delete', { goalId: a });
  assert.equal(r.removed, 2);
  assert.equal(r.unlinkedTasks, 1);
  assert.equal(h.core.S.goals.length, 0);
  assert.equal(h.core.task(t).goalId, null);
  assert.equal(h.core.S.sessions.length, 1);
  assert.deepEqual(h.core.S.weeks['2026-11-02'].goalIds, []);
});

test('goal.applyDraft writes the whole tree or nothing', () => {
  const h = harness();
  const bad = h.d('goal.applyDraft', { origin: 'agent', tree: { title: '根', children: [{ title: '好的' }, { title: '' }] } });
  assert.equal(bad.ok, false);
  assert.equal(h.core.S.goals.length, 0);
  assert.equal(h.core.S.tasks.length, 0);
  const ok = h.d('goal.applyDraft', {
    origin: 'agent',
    tree: { title: '英语六级', note: '12 月考试', tasks: [{ title: '做一套真题', est: 120 }],
      children: [{ title: '听力', tasks: ['精听一篇'] }, { title: '阅读', children: [{ title: '长难句' }] }] },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.goals, 4);
  assert.equal(ok.tasks, 2);
  assert.ok(h.core.S.goals.every((g) => g.origin === 'agent'));
  const made = h.core.S.tasks;
  assert.ok(made.every((t) => t.origin === 'agent' && t.date === null && t.goalId));
  assert.equal(made[0].est, 120);
  const tree = plan.goalTree(h.core.S);
  assert.equal(tree[0].taskCount, 2);
  assert.deepEqual(tree[0].children.map((c) => c.title), ['听力', '阅读']);
});

test('goal depth is limited', () => {
  const h = harness();
  let node = { title: 'L7' };
  for (let i = 6; i >= 1; i--) node = { title: 'L' + i, children: [node] };
  assert.match(h.d('goal.applyDraft', { tree: node }).error, /最多 6 层/);
  assert.equal(h.core.S.goals.length, 0);
});

test('week.applyDraft validates dates and tasks before changing anything', () => {
  const h = harness();
  const t1 = h.d('task.add', { title: '已有任务', date: null }).taskId;
  const outside = h.d('week.applyDraft', { weekStart: '2026-11-04', focus: '重点', assign: [{ taskId: t1, date: '2026-11-03' }], add: [{ title: '新任务', date: '2026-11-10' }] });
  assert.equal(outside.ok, false);
  assert.equal(h.core.task(t1).date, null);
  assert.equal(h.core.S.weeks['2026-11-02'], undefined);
  assert.equal(h.d('week.applyDraft', { weekStart: '2026-11-04', assign: [{ taskId: 'nope' }] }).ok, false);

  const ok = h.d('week.applyDraft', {
    weekStart: '2026-11-04', focus: '把极限做完', capacityMin: 600, origin: 'agent',
    assign: [{ taskId: t1, date: '2026-11-05' }], add: [{ title: '复习笔记', date: null, est: 45 }, { title: '周日小测', date: '2026-11-08' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.weekStart, '2026-11-02');
  assert.equal(h.core.task(t1).date, '2026-11-05');
  const w = h.core.S.weeks['2026-11-02'];
  assert.equal(w.focus, '把极限做完');
  assert.equal(w.capacityMin, 600);
  assert.equal(w.origin, 'agent');
  const view = plan.weekView(h.core.S, '2026-11-02');
  assert.deepEqual(view.tasks.map((t) => t.title).sort(), ['复习笔记', '周日小测', '已有任务'].sort());
  assert.equal(view.tasks.find((t) => t.title === '复习笔记').date, null);
});

test('task.update, task.addMany and task.delete', () => {
  const h = harness();
  const g = h.d('goal.add', { title: 'G' }).goalId;
  const t = h.d('task.add', { title: '原标题', setMain: true }).taskId;
  assert.equal(h.d('task.update', { taskId: t, title: '新标题', est: 50, goalId: g, date: null, week: '2026-11-06' }).ok, true);
  const task = h.core.task(t);
  assert.deepEqual([task.title, task.est, task.goalId, task.date, task.week], ['新标题', 50, g, null, '2026-11-02']);
  assert.equal(h.d('task.update', { taskId: t, goalId: 'nope' }).ok, false);
  assert.equal(h.d('task.update', { taskId: t, title: ' ' }).ok, false);

  assert.equal(h.d('task.addMany', { tasks: [{ title: 'a' }, { title: '' }] }).ok, false);
  assert.equal(h.core.S.tasks.length, 1);
  assert.equal(h.d('task.addMany', { tasks: [{ title: 'a', date: '2026-11-05' }, { title: 'b', goalId: g }], origin: 'agent' }).added, 2);

  const { activeId } = h.d('timer.start', { taskId: t, minutes: 'up' });
  h.advance(2 * MIN);
  assert.equal(h.d('task.delete', { taskId: t }).ok, true);
  assert.equal(h.core.task(t), null);
  assert.equal(Object.keys(h.core.S.main).length, 0);
  assert.equal(h.core.S.active.taskId, null);   // the round keeps running, unlinked
  h.d('timer.end', { activeId });
  assert.equal(h.core.S.sessions.length, 1);    // the record of deleted work is kept
});

test('day and week facts come from sessions; "no record" is reported separately', () => {
  const h = harness();
  const g = h.d('goal.add', { title: '数学' }).goalId;
  const sub = h.d('goal.add', { title: '极限', parentId: g }).goalId;
  const worked = h.d('task.add', { title: '极限 20 题', goalId: sub }).taskId;
  h.d('task.add', { title: '没计时的任务' });
  let r = h.d('timer.start', { taskId: worked, minutes: 'up' });
  h.advance(25 * MIN);
  h.d('timer.end', { activeId: r.activeId });
  h.d('session.outcome', { sessionId: r.activeId, note: '夹逼定理卡住' });
  r = h.d('timer.start', { title: '随手背单词', minutes: 'up' });
  h.advance(10 * MIN);
  h.d('timer.end', { activeId: r.activeId });

  const day = plan.dayFacts(h.core.S, '2026-11-04');
  assert.equal(day.minutes, 35);
  assert.equal(day.count, 2);
  assert.deepEqual(day.tasks.map((x) => [x.title, x.minutes]), [['极限 20 题', 25], ['随手背单词', 10]]);
  assert.deepEqual(day.tasks[0].notes, ['夹逼定理卡住']);
  assert.deepEqual(day.noRecord.map((x) => x.title), ['没计时的任务']);

  const week = plan.weekFacts(h.core.S, '2026-11-04');
  assert.equal(week.key, '2026-11-02');
  assert.equal(week.minutes, 35);
  assert.equal(week.perDay[2].minutes, 35);
  assert.equal(week.perDay[0].minutes, 0);
  assert.deepEqual(week.goals, [{ goalId: g, title: '数学', minutes: 25 }, { goalId: null, title: '未关联目标', minutes: 10 }]);
  assert.equal(week.planned, 2);
  assert.equal(plan.goalTree(h.core.S)[0].minutes, 25);
});

test('reviews keep the user reflection and the AI draft apart', () => {
  const h = harness();
  assert.equal(h.d('review.save', { scope: 'week', key: '2026-11-04', reflection: 'x' }).ok, false); // not a Monday
  h.d('review.save', { scope: 'day', key: '2026-11-04', reflection: '今天状态不错' });
  h.d('review.setDraft', { scope: 'day', key: '2026-11-04', text: 'AI 写的草稿', model: 'm1' });
  h.d('review.save', { scope: 'day', key: '2026-11-04', reflection: '改了一下' });
  assert.equal(h.core.S.reviews.length, 1);
  const r = h.core.S.reviews[0];
  assert.equal(r.reflection, '改了一下');
  assert.equal(r.aiDraft.text, 'AI 写的草稿');
  assert.equal(r.aiDraft.model, 'm1');
  h.d('review.clearDraft', { scope: 'day', key: '2026-11-04' });
  assert.equal(h.core.S.reviews[0].aiDraft, null);
  assert.equal(h.core.S.reviews[0].reflection, '改了一下');
});

test('check() validates a command without saving or emitting anything', () => {
  const h = harness();
  const before = JSON.stringify(h.disk);
  const events = [];
  h.core.on('change', () => events.push('change'));
  assert.equal(h.core.check({ type: 'goal.applyDraft', payload: { tree: { title: '试运行', tasks: ['a'] } } }).ok, true);
  assert.equal(h.core.check({ type: 'goal.applyDraft', payload: { tree: { title: '' } } }).ok, false);
  assert.equal(h.core.S.goals.length, 0);
  assert.equal(JSON.stringify(h.disk), before);
  assert.deepEqual(events, []);
});

test('query() answers by name and rejects unknown names', () => {
  const h = harness();
  assert.equal(h.core.query('week.view', { weekStart: '2026-11-04' }).data.weekStart, '2026-11-02');
  assert.equal(h.core.query('nope').ok, false);
});

test('import keeps new planning data consistent', () => {
  const h = harness();
  const g = h.d('goal.add', { title: 'G' }).goalId;
  h.d('task.add', { title: 'T', goalId: g });
  const exported = h.core.snapshot();
  const h2 = harness();
  assert.equal(h2.d('data.import', { state: exported }).ok, true);
  assert.equal(h2.core.S.goals.length, 1);
  assert.equal(h2.core.S.tasks[0].goalId, g);
  const legacy = { tasks: [{ id: 'x', title: '旧', goalId: 'ghost' }] };
  assert.equal(h2.d('data.import', { state: legacy }).ok, true);
  assert.equal(h2.core.S.tasks[0].goalId, null);
  assert.equal(h2.d('data.import', { state: { tasks: [], schema: 99 } }).ok, false);
});
