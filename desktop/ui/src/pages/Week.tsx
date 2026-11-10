import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useApp } from '../store';
import type { Task } from '../api';
import { Badge, Icon, IconButton, QuickAdd } from '../components/ui';
import { addDays, fmtMin, md, sum, weekDays, weekStartOf, weekdayOf } from '../util';

function WeekTask({ t }: { t: Task }) {
  const { S, run } = useApp();
  const goal = t.goalId ? S.goals.find((g) => g.id === t.goalId) : null;
  const drag = (e: DragEvent) => { e.dataTransfer.setData('text/tplan-task', t.id); e.dataTransfer.effectAllowed = 'move'; };
  return (
    <li className={`wtask${t.done ? ' done' : ''}`} draggable onDragStart={drag} data-task={t.title}>
      <input type="checkbox" checked={t.done} aria-label={`完成：${t.title}`} onChange={(e) => run('task.setDone', { taskId: t.id, done: e.target.checked })} />
      <div className="wtask-body">
        <span className="wtask-title">{t.title}</span>
        <span className="wtask-meta">{t.est} 分钟{goal ? ` · ${goal.title}` : ''}{t.origin === 'agent' ? ' · AI 建议' : ''}</span>
      </div>
    </li>
  );
}

function Column({ title, sub, tasks, onDropTask, onAdd, isToday, testid }:
  { title: string; sub: string; tasks: Task[]; onDropTask: (id: string) => void; onAdd: (title: string) => void; isToday?: boolean; testid: string }) {
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <div className={`wcol${over ? ' over' : ''}${isToday ? ' today' : ''}`} data-col={testid}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('text/tplan-task')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData('text/tplan-task'); if (id) onDropTask(id); }}>
      <div className="wcol-head">
        <span className="wcol-title">{title}</span>
        <span className="wcol-sub">{sub}</span>
      </div>
      <ul className="wtasks">{tasks.map((t) => <WeekTask key={t.id} t={t} />)}</ul>
      {adding ? <QuickAdd placeholder="任务标题" autoFocus onAdd={onAdd} onCancel={() => setAdding(false)} />
        : <button type="button" className="wadd" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> 添加</button>}
    </div>
  );
}

export function Week() {
  const { S, today, run, go } = useApp();
  const [ws, setWs] = useState(weekStartOf(today));
  const days = weekDays(ws);
  const plan = S.weeks[ws];
  const [focus, setFocus] = useState(plan?.focus || '');
  const [hours, setHours] = useState(plan?.capacityMin ? String(plan.capacityMin / 60) : '');
  useEffect(() => { setFocus(plan?.focus || ''); setHours(plan?.capacityMin ? String(Math.round(plan.capacityMin / 6) / 10) : ''); }, [ws, plan?.focus, plan?.capacityMin]);

  const data = useMemo(() => {
    const end = days[6];
    const inWeek = S.tasks.filter((t) => (t.date && t.date >= ws && t.date <= end) || (!t.date && t.week === ws));
    const sessions = S.sessions.filter((s) => s.date >= ws && s.date <= end);
    return {
      byDay: days.map((d) => inWeek.filter((t) => t.date === d)),
      undecided: inWeek.filter((t) => !t.date),
      recordedByDay: days.map((d) => sum(sessions.filter((s) => s.date === d), (s) => s.minutes)),
      planned: sum(inWeek, (t) => t.est),
      recorded: sum(sessions, (s) => s.minutes),
      done: inWeek.filter((t) => t.done).length, total: inWeek.length,
    };
  }, [S.tasks, S.sessions, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const capacity = plan?.capacityMin || null;
  const scale = Math.max(capacity || 0, data.planned, data.recorded, 1);
  const saveFocus = () => { if (focus.trim() !== (plan?.focus || '')) void run('week.update', { weekStart: ws, focus }); };
  const saveHours = () => {
    const min = Math.round((Number(hours) || 0) * 60);
    if (min !== (plan?.capacityMin || 0)) void run('week.update', { weekStart: ws, capacityMin: min });
  };
  const isThisWeek = ws === weekStartOf(today);
  const askAi = () => go('chat', {
    chatDraft: `请帮我安排${isThisWeek ? '这一周' : `${md(ws)}开始的那一周`}（周一是 ${ws}）的学习计划。先看看我的目标树、以后清单和最近几周实际记录的时长，再提出一份周计划。`,
  });

  return (
    <div className="page wide">
      <header className="page-head">
        <div>
          <h1>周计划</h1>
          <p className="muted">{md(ws)} – {md(days[6])}{isThisWeek ? ' · 本周' : ''}</p>
        </div>
        <div className="row">
          <IconButton name="left" label="上一周" onClick={() => setWs(addDays(ws, -7))} />
          <button className="btn sm" disabled={isThisWeek} onClick={() => setWs(weekStartOf(today))}>回到本周</button>
          <IconButton name="chevron" label="下一周" onClick={() => setWs(addDays(ws, 7))} />
          <button className="btn ghost" onClick={askAi}><Icon name="spark" size={15} /> 让 AI 帮我排</button>
        </div>
      </header>

      <section className="card weekplan">
        <label className="field grow">
          <span>本周重点 {plan?.origin === 'agent' && <Badge tone="ai">AI 建议</Badge>}</span>
          <input className="input" value={focus} maxLength={300} placeholder="这一周最想推进的一件事" data-testid="week-focus"
            onChange={(e) => setFocus(e.target.value)} onBlur={saveFocus} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <label className="field">
          <span>打算投入（小时）</span>
          <input className="input narrow" type="number" min="0" step="0.5" value={hours} placeholder="可不填"
            onChange={(e) => setHours(e.target.value)} onBlur={saveHours} />
        </label>
        <div className="weekbars">
          <div className="bar-row"><span>已安排</span><div className="bar"><i style={{ width: `${(data.planned / scale) * 100}%` }} /></div><b>{fmtMin(data.planned)}</b></div>
          <div className="bar-row"><span>已记录</span><div className="bar rec"><i style={{ width: `${(data.recorded / scale) * 100}%` }} /></div><b>{fmtMin(data.recorded)}</b></div>
          <p className="muted small">
            {data.total ? `${data.done} / ${data.total} 个任务完成。` : '这一周还没有安排任务。'}
            {capacity && data.planned > capacity ? ` 已安排的时长比打算投入的多 ${fmtMin(data.planned - capacity)}。` : ''}
          </p>
        </div>
      </section>

      <div className="weekgrid">
        {days.map((d, i) => (
          <Column key={d} testid={d} isToday={d === today} title={weekdayOf(d)} tasks={data.byDay[i]}
            sub={`${md(d)}${data.recordedByDay[i] ? ` · 记录 ${fmtMin(data.recordedByDay[i])}` : ''}`}
            onDropTask={(id) => run('task.update', { taskId: id, date: d, week: ws })}
            onAdd={(title) => run('task.add', { title, date: d })} />
        ))}
        <Column testid="undecided" title="本周未定" sub="哪天做还没决定" tasks={data.undecided}
          onDropTask={(id) => run('task.update', { taskId: id, date: null, week: ws })}
          onAdd={(title) => run('task.add', { title, date: null, week: ws })} />
      </div>
      <p className="muted small">拖动任务可以换一天。任务不会自动改期。</p>
    </div>
  );
}
