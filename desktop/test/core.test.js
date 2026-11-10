'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core, petView, MIN } = require('../src/main/core');

/** Core wired to a fake clock, fake timers and an in-memory "disk". */
function harness(initial) {
  let now = new Date(2026, 10, 2, 9, 0, 0).getTime();
  let disk = initial ? JSON.parse(JSON.stringify(initial)) : null;
  let timers = [];
  let seq = 0;
  const core = new Core({
    now: () => now,
    setTimer: (fn, ms) => { const h = ++seq; timers.push({ h, at: now + ms, fn }); return h; },
    clearTimer: (h) => { timers = timers.filter((t) => t.h !== h); },
    read: () => disk && JSON.parse(JSON.stringify(disk)),
    write: (s) => { disk = JSON.parse(JSON.stringify(s)); },
  });
  const events = [];
  core.on('event', (e) => events.push(e));
  core.load();
  return {
    core, events,
    get disk() { return disk; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    setNow(v) { now = v; },
    get now() { return now; },
  };
}

const start = (core, p) => core.dispatch({ type: 'timer.start', payload: p });

test('only one active timer at a time', () => {
  const h = harness();
  assert.equal(start(h.core, { title: 'A', minutes: 10 }).ok, true);
  const r = start(h.core, { title: 'B', minutes: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /先结束/);
});

test('countdown reaching zero records the session once and alerts once', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: '极限', minutes: 10 });
  h.advance(10 * MIN);
  assert.equal(h.core.S.active.phase, 'due');
  assert.equal(h.core.S.sessions.length, 1);
  assert.equal(h.core.S.sessions[0].id, activeId);
  assert.equal(h.core.S.sessions[0].minutes, 10);
  assert.equal(h.events.filter((e) => e.type === 'timeUp').length, 1);
  h.advance(60 * 1000);
  assert.equal(h.events.filter((e) => e.type === 'timeUp').length, 1);
});

test('ending twice (two windows) produces exactly one record', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 30 });
  h.advance(12 * MIN);
  const r1 = h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  const r2 = h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.stale, true);
  assert.equal(h.core.S.sessions.length, 1);
  assert.equal(h.core.S.sessions[0].minutes, 12);
});

test('continuing after time-up extends the same record instead of adding one', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 10 });
  h.advance(10 * MIN);
  h.core.dispatch({ type: 'timer.countUp', payload: { activeId } });
  h.advance(20 * MIN);
  h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(h.core.S.sessions.length, 1);
  assert.equal(h.core.S.sessions[0].minutes, 30);
});

test('ending a due round records the budget and the due time, not later', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 10 });
  h.advance(10 * MIN);
  const dueAt = h.now;
  h.advance(3 * MIN); // user looks away for 3 minutes, then ends
  h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(h.core.S.sessions[0].minutes, 10);
  assert.equal(h.core.S.sessions[0].end, dueAt);
});

test('unanswered time-up is finalised after 15 minutes with the budget only', () => {
  const h = harness();
  start(h.core, { title: 'A', minutes: 10 });
  h.advance(10 * MIN + 15 * MIN);
  assert.equal(h.core.S.active, null);
  assert.equal(h.core.S.sessions.length, 1);
  assert.equal(h.core.S.sessions[0].minutes, 10);
  assert.equal(h.core.S.sessions[0].outcome, null);
});

test('pause stops counting; resume continues', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 'up' });
  h.advance(5 * MIN);
  h.core.dispatch({ type: 'timer.pause', payload: { activeId } });
  h.advance(30 * MIN);
  h.core.dispatch({ type: 'timer.resume', payload: { activeId } });
  h.advance(5 * MIN);
  h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(h.core.S.sessions[0].minutes, 10);
});

test('sleep auto-pauses: sleeping time is never counted, and a reminder is raised', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 25 });
  h.advance(7 * MIN);
  h.core.autoPause('sleep');
  h.advance(120 * MIN); // laptop asleep for two hours
  assert.equal(h.core.S.active.phase, 'paused');
  assert.equal(h.core.S.desktop.reminder.reason, 'sleep');
  assert.equal(h.core.S.sessions.length, 0); // countdown did not "finish" during sleep
  h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(h.core.S.sessions[0].minutes, 7);
});

test('crash: on restart, time counts only up to the last heartbeat', () => {
  const h = harness();
  start(h.core, { title: 'A', minutes: 'up' });
  h.advance(30 * 1000); h.core.heartbeat();
  h.advance(30 * 1000); h.core.heartbeat();   // last beat at 1:00
  const saved = h.disk;
  // Process dies; the app is restarted 40 minutes later.
  const h2 = harness(saved);
  h2.setNow(saved.active.startedAt + 41 * MIN);
  h2.core.load();
  assert.equal(h2.core.S.active.phase, 'paused');
  assert.equal(h2.core.S.active.autoPaused, 'crash');
  assert.equal(Math.round(h2.core.S.active.acc / 1000), 60);
});

test('quick restart also pauses and excludes downtime', () => {
  const h = harness();
  start(h.core, { title: 'A', minutes: 30 });
  h.advance(5 * MIN); h.core.heartbeat();
  const saved = h.disk;
  const h2 = harness(saved);
  h2.setNow(saved.active.beat + 60 * 1000);
  h2.core.load();
  assert.equal(h2.core.S.active.phase, 'paused');
  assert.equal(h2.core.S.active.acc,5*MIN);
});

test('quit auto-pauses and persists the reminder for the next launch', () => {
  const h = harness();
  start(h.core, { title: 'A', minutes: 30 });
  h.advance(4 * MIN);
  h.core.autoPause('quit');
  assert.equal(h.disk.active.phase, 'paused');
  assert.equal(h.disk.desktop.reminder.reason, 'quit');
});

test('short rounds preserve exact effort instead of discarding it', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 10 });
  h.advance(20 * 1000);
  const r = h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  assert.equal(r.recorded, true);
  assert.equal(h.core.S.sessions.length, 1);
  assert.equal(h.core.S.sessions[0].durationMs,20000);
});

test('outcome "done" completes the task; "continue" keeps a next step', () => {
  const h = harness();
  const { taskId } = h.core.dispatch({ type: 'task.add', payload: { title: '高数第三章', setMain: true } });
  const { activeId } = start(h.core, { taskId, minutes: 10, step: '先看第一道例题' });
  h.advance(10 * MIN);
  h.core.dispatch({ type: 'timer.end', payload: { activeId } });
  h.core.dispatch({ type: 'session.outcome', payload: { sessionId: activeId, outcome: 'continue', note: '卡在第二题', next: '从第二题开始' } });
  const t = h.core.task(taskId);
  assert.equal(t.done, false);
  assert.equal(t.next, '从第二题开始');
  assert.equal(h.core.S.sessions[0].note, '卡在第二题');
  assert.equal(h.core.S.sessions[0].step, '先看第一道例题');
  // Next round starts from the saved next step automatically.
  const r2 = start(h.core, { taskId, minutes: 5 });
  assert.equal(h.core.S.active.step, '从第二题开始');
  h.advance(5 * MIN);
  h.core.dispatch({ type: 'timer.end', payload: { activeId: r2.activeId } });
  h.core.dispatch({ type: 'session.outcome', payload: { sessionId: r2.activeId, outcome: 'done' } });
  assert.equal(t.done, true);
  assert.ok(h.events.some((e) => e.type === 'done'));
});

test('import replaces data but never interrupts the running round', () => {
  const h = harness();
  const { activeId } = start(h.core, { title: 'A', minutes: 30 });
  const r = h.core.dispatch({ type: 'data.import', payload: { state: { tasks: [{ id: 't1', title: 'X', date: '2026-11-02', done: false }], sessions: [] } } });
  assert.equal(r.ok, true);
  assert.equal(h.core.S.active.id, activeId);
  assert.equal(h.core.S.tasks.length, 1);
});

test('petView lists the main task first and sums today', () => {
  const h = harness();
  h.core.dispatch({ type: 'task.add', payload: { title: 'A' } });
  const { taskId } = h.core.dispatch({ type: 'task.add', payload: { title: 'B', setMain: true } });
  h.core.dispatch({ type: 'task.add', payload: { title: 'Later', date: null } });
  const v = petView(h.core.S, h.now);
  assert.equal(v.mainTask.id, taskId);
  assert.equal(v.openTasks[0].id, taskId);
  assert.equal(v.openTasks.length, 3);
});

test('unknown commands and stale ids are rejected without changing data', () => {
  const h = harness();
  const rev = h.core.S.desktop.rev;
  assert.equal(h.core.dispatch({ type: 'nope' }).ok, false);
  assert.equal(h.core.dispatch({ type: 'timer.pause', payload: { activeId: 'x' } }).ok, false);
  assert.equal(h.core.S.desktop.rev, rev);
});

test('scheduled reminders respect quiet, focus, interval, day budget and deduplication', () => {
  const h = harness();
  for(let i=0;i<6;i++) h.core.dispatch({type:'task.add',payload:{title:'任务 '+i,at:'09:00'}});
  h.core.checkReminders(true);
  assert.equal(h.events.length,0);
  const {activeId}=start(h.core,{title:'正在专注',minutes:'up'});
  h.core.checkReminders(false);
  assert.equal(h.events.length,0);
  h.core.dispatch({type:'timer.end',payload:{activeId}});
  h.core.checkReminders(false);
  h.core.checkReminders(false);
  assert.equal(h.events.filter(e=>e.type==='gentleReminder').length,1);
  for(let i=0;i<5;i++){h.advance(30*MIN);h.core.checkReminders(false);}
  const reminders=h.events.filter(e=>e.type==='gentleReminder');
  assert.equal(reminders.length,4);
  assert.equal(new Set(reminders.map(e=>e.taskId)).size,4);
});

test('evening review is opt-in and only sent once per day', () => {
  const h=harness();h.advance(12*60*MIN);
  h.core.checkReminders(false);assert.equal(h.events.length,0);
  h.core.dispatch({type:'settings.update',payload:{eveningReview:true,reviewTime:'20:00'}});
  h.core.checkReminders(false);h.advance(31*MIN);h.core.checkReminders(false);
  assert.equal(h.events.filter(e=>e.review).length,1);
});

test('review distinguishes no records from completion and never auto-reschedules', () => {
  const h=harness();
  const {taskId}=h.core.dispatch({type:'task.add',payload:{title:'未计时的任务'}});
  const v=petView(h.core.S,h.now);
  assert.equal(v.reviewTasks[0].recordCount,0);
  assert.equal(v.reviewTasks[0].done,false);
  h.advance(24*60*MIN);
  assert.equal(h.core.task(taskId).date,'2026-11-02');
  h.core.dispatch({type:'task.schedule',payload:{taskId,date:null}});
  assert.equal(h.core.task(taskId).date,null);
  h.core.dispatch({type:'task.schedule',payload:{taskId,date:'2026-11-04'}});
  assert.equal(h.core.task(taskId).date,'2026-11-04');
});

test('correcting a finished round to continue reopens its task', () => {
  const h=harness();const {taskId}=h.core.dispatch({type:'task.add',payload:{title:'高数'}});
  const {activeId}=start(h.core,{taskId,minutes:5});h.advance(MIN);
  h.core.dispatch({type:'timer.end',payload:{activeId}});
  h.core.dispatch({type:'session.outcome',payload:{sessionId:activeId,outcome:'done'}});
  h.core.dispatch({type:'session.outcome',payload:{sessionId:activeId,outcome:'continue',next:'第二题'}});
  assert.equal(h.core.task(taskId).done,false);assert.equal(h.core.task(taskId).next,'第二题');
  assert.equal(h.core.S.sessions.length,1);
});
