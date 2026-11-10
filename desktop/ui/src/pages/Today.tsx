import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { Session, Task } from '../api';
import { Badge, Confirm, Editable, Empty, Icon, IconButton, QuickAdd } from '../components/ui';
import { addDays, clock, dayLabel, elapsed, fmtMin, hm, sum } from '../util';

function TimerCard() {
  const { S, now, today, run } = useApp();
  const a = S.active;
  const mainTask = S.tasks.find((t) => t.id === S.main[today]) || null;
  const [free, setFree] = useState('');

  if (a) {
    const e = elapsed(a, now);
    const id = { activeId: a.id };
    const phase = { running: a.mode === 'up' ? '正计时' : '专注中', paused: '已暂停', due: '时间到' }[a.phase];
    return (
      <section className={`card timer ${a.phase}`} data-testid="timer">
        <div className="timer-head">
          <Badge tone={a.phase === 'running' ? 'ok' : 'warn'}>{phase}</Badge>
          <span className="muted">开始于 {hm(a.startedAt)}{a.mode === 'down' ? ` · 计划 ${Math.round(a.budget / 60000)} 分钟` : ''}</span>
        </div>
        <h2 className="timer-title">{a.title}</h2>
        {a.step && <p className="muted">这一步：{a.step}</p>}
        <div className="clock" data-testid="clock">{clock(a.mode === 'down' ? a.budget - e : e)}</div>
        {a.phase === 'due' ? (
          <>
            <p className="muted">这段时间已经记下来了。继续一会儿，还是先到这里？</p>
            <div className="row">
              <button className="btn" onClick={() => run('timer.extend', { ...id, minutes: 5 })}>再 5 分钟</button>
              <button className="btn" onClick={() => run('timer.countUp', id)}>正计时继续</button>
              <button className="btn primary" onClick={() => run('timer.end', id)}>结束这一轮</button>
            </div>
          </>
        ) : (
          <div className="row">
            {a.phase === 'running'
              ? <button className="btn" onClick={() => run('timer.pause', id)}><Icon name="pause" size={14} fill /> 暂停</button>
              : <button className="btn primary" onClick={() => run('timer.resume', id)}><Icon name="play" size={14} fill /> 继续</button>}
            {a.mode === 'down' && <button className="btn" onClick={() => run('timer.extend', { ...id, minutes: 5 })}>+5 分钟</button>}
            <button className="btn" onClick={() => run('timer.end', id)}><Icon name="stop" size={14} fill /> 结束并记录</button>
          </div>
        )}
        {a.autoPaused && <p className="muted">电脑休眠、锁屏或重启时已自动暂停，这段时间没有计入。</p>}
      </section>
    );
  }

  const start = (minutes: number | 'up') => {
    if (mainTask) return run('timer.start', { taskId: mainTask.id, minutes });
    if (free.trim()) return run('timer.start', { title: free.trim(), minutes }).then((r) => { if (r.ok) setFree(''); });
    return undefined;
  };
  const can = !!mainTask || !!free.trim();
  return (
    <section className="card timer idle" data-testid="timer">
      <p className="eyebrow">现在先做这一件</p>
      {mainTask ? (
        <>
          <h2 className="timer-title">{mainTask.title}</h2>
          {mainTask.next && <p className="muted">上次停在：{mainTask.next}</p>}
        </>
      ) : (
        <>
          <input className="input big" value={free} maxLength={150} placeholder="直接写一件事，或在下面的任务上点 ★ 选为主任务"
            onChange={(e) => setFree(e.target.value)} />
        </>
      )}
      <div className="row">
        <button className="btn primary" disabled={!can} onClick={() => start(5)}><Icon name="play" size={14} fill /> 先做 5 分钟</button>
        <button className="btn" disabled={!can} onClick={() => start(10)}>10 分钟</button>
        <button className="btn" disabled={!can} onClick={() => start(mainTask ? mainTask.est : 25)}>{mainTask ? `按计划 ${mainTask.est} 分钟` : '25 分钟'}</button>
        <button className="btn" disabled={!can} onClick={() => start('up')}>正计时</button>
        {mainTask && <button className="btn ghost" onClick={() => run('task.setMain', { taskId: null })}>换一件</button>}
      </div>
    </section>
  );
}

function TaskRow({ t, kind }: { t: Task; kind: 'today' | 'overdue' | 'later' }) {
  const { S, today, run } = useApp();
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const isMain = S.main[today] === t.id;
  const goal = t.goalId ? S.goals.find((g) => g.id === t.goalId) : null;
  return (
    <li className={`task${t.done ? ' done' : ''}${isMain ? ' main' : ''}`} data-task={t.title}>
      <input type="checkbox" checked={t.done} aria-label={`完成：${t.title}`} onChange={(e) => run('task.setDone', { taskId: t.id, done: e.target.checked })} />
      <div className="task-body">
        <Editable className="task-title" value={t.title} editing={editing} onDone={() => setEditing(false)} onSave={(title) => run('task.update', { taskId: t.id, title })} />
        <div className="task-meta">
          {kind === 'overdue' && t.date && <span>原定 {dayLabel(t.date, today)}</span>}
          <span>{t.est} 分钟</span>
          {t.at && <span>{t.at}</span>}
          {goal && <span className="chip">{goal.title}</span>}
          {t.origin === 'agent' && <Badge tone="ai">AI 建议</Badge>}
          {t.next && <span>下一步：{t.next}</span>}
        </div>
      </div>
      {asking ? (
        <Confirm text="删除这个任务？已有的计时记录会保留。" yes="删除" onYes={() => run('task.delete', { taskId: t.id })} onNo={() => setAsking(false)} />
      ) : (
        <div className="task-actions">
          {kind !== 'today' && <button className="btn sm" onClick={() => run('task.schedule', { taskId: t.id, date: today })}>今天做</button>}
          {kind === 'today' && !t.done && (
            <>
              <IconButton name="star" label={isMain ? '取消主任务' : '设为今天的主任务'} active={isMain} fill={isMain}
                onClick={() => run('task.setMain', { taskId: isMain ? null : t.id })} />
              <IconButton name="play" label={`开始计时 ${t.est} 分钟`} disabled={!!S.active} fill
                onClick={() => run('timer.start', { taskId: t.id, minutes: t.est })} />
              <button className="btn sm ghost" onClick={() => run('task.schedule', { taskId: t.id, date: addDays(today, 1) })}>明天</button>
            </>
          )}
          {kind !== 'later' && !t.done && <button className="btn sm ghost" onClick={() => run('task.schedule', { taskId: t.id, date: null })}>以后</button>}
          <IconButton name="edit" label="修改标题" onClick={() => setEditing(true)} />
          <IconButton name="trash" label="删除任务" danger onClick={() => setAsking(true)} />
        </div>
      )}
    </li>
  );
}

function SessionRow({ s }: { s: Session }) {
  const { run } = useApp();
  const [mode, setMode] = useState<null | 'next' | 'note'>(null);
  const [text, setText] = useState('');
  const save = async () => {
    if (mode === 'next') await run('session.outcome', { sessionId: s.id, outcome: 'continue', next: text });
    if (mode === 'note') await run('session.outcome', { sessionId: s.id, note: text });
    setMode(null); setText('');
  };
  return (
    <li className="session">
      <div className="session-main">
        <span className="session-time">{hm(s.start)}–{hm(s.end)}</span>
        <span className="session-title">{s.title}</span>
        <span className="session-min">{fmtMin(s.minutes)}</span>
        {s.outcome === 'done' && <Badge tone="ok">完成</Badge>}
        {s.outcome === 'continue' && <Badge tone="muted">还要继续</Badge>}
      </div>
      {s.note && <p className="session-note">{s.note}</p>}
      {mode ? (
        <div className="row">
          <input className="input" autoFocus value={text} maxLength={mode === 'next' ? 200 : 2000}
            placeholder={mode === 'next' ? '下次从哪里继续？（可以留空）' : '想到什么就写一句'}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save(); if (e.key === 'Escape') setMode(null); }} />
          <button className="btn sm primary" onClick={save}>保存</button>
          <button className="btn sm ghost" onClick={() => setMode(null)}>取消</button>
        </div>
      ) : (
        <div className="row session-actions">
          {s.taskId && s.outcome !== 'done' && <button className="btn sm" onClick={() => run('session.outcome', { sessionId: s.id, outcome: 'done' })}>这件完成了</button>}
          {s.taskId && s.outcome !== 'continue' && <button className="btn sm" onClick={() => { setText(''); setMode('next'); }}>还要继续</button>}
          <button className="btn sm ghost" onClick={() => { setText(s.note || ''); setMode('note'); }}>{s.note ? '改备注' : '加备注'}</button>
        </div>
      )}
    </li>
  );
}

export function Today() {
  const { S, today, run, go } = useApp();
  const [showLater, setShowLater] = useState(false);
  const mainId = S.main[today];
  const lists = useMemo(() => {
    const rank = (t: Task) => (t.done ? 2 : t.id === mainId ? 0 : 1);
    return {
      todays: S.tasks.filter((t) => t.date === today).sort((a, b) => rank(a) - rank(b) || (a.at || '99').localeCompare(b.at || '99') || a.createdAt - b.createdAt),
      overdue: S.tasks.filter((t) => !t.done && t.date && t.date < today).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      later: S.tasks.filter((t) => !t.done && !t.date),
      sessions: S.sessions.filter((s) => s.date === today).sort((a, b) => b.start - a.start),
    };
  }, [S.tasks, S.sessions, today, mainId]);
  const minutes = sum(lists.sessions, (s) => s.minutes);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>今天</h1>
          <p className="muted">{dayLabel(today, '')}</p>
        </div>
        <button className="btn ghost" onClick={() => go('chat', { chatDraft: '帮我看看今天的任务，建议我先做哪一件，以及第一步是什么。' })}>
          <Icon name="spark" size={15} /> 问问 AI
        </button>
      </header>

      <TimerCard />

      <section className="card">
        <div className="card-head">
          <h3>今天的任务</h3>
          <span className="muted">{lists.todays.filter((t) => t.done).length} / {lists.todays.length} 完成</span>
        </div>
        {lists.todays.length ? <ul className="tasks">{lists.todays.map((t) => <TaskRow key={t.id} t={t} kind="today" />)}</ul>
          : <Empty title="今天还没有安排任务">写下一件事，或者从“以后清单”里挑一件。</Empty>}
        <QuickAdd placeholder="添加今天的任务，回车保存" onAdd={(title) => run('task.add', { title, date: today })} />
      </section>

      {lists.overdue.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>之前排的，还没完成</h3><span className="muted">由你决定今天做还是放回清单，不会自动改期</span></div>
          <ul className="tasks">{lists.overdue.map((t) => <TaskRow key={t.id} t={t} kind="overdue" />)}</ul>
        </section>
      )}

      <section className="card">
        <button type="button" className="card-head fold" onClick={() => setShowLater((v) => !v)} aria-expanded={showLater}>
          <h3><span className={`caret${showLater ? ' open' : ''}`}><Icon name="chevron" size={14} /></span> 以后清单</h3>
          <span className="muted">{lists.later.length} 件</span>
        </button>
        {showLater && (
          <>
            {lists.later.length ? <ul className="tasks">{lists.later.map((t) => <TaskRow key={t.id} t={t} kind="later" />)}</ul>
              : <p className="muted pad">想做但还没定日子的事会放在这里。</p>}
            <QuickAdd placeholder="想到一件以后要做的事，回车保存" onAdd={(title) => run('task.add', { title, date: null })} />
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>今天的记录</h3>
          <span className="muted">{lists.sessions.length ? `${lists.sessions.length} 段，共 ${fmtMin(minutes)}` : '还没有计时记录'}</span>
        </div>
        {lists.sessions.length ? <ul className="sessions">{lists.sessions.map((s) => <SessionRow key={s.id} s={s} />)}</ul>
          : <p className="muted pad">没有计时记录不代表没有学习。结束一轮计时后，记录会自动出现在这里。</p>}
      </section>
    </div>
  );
}
