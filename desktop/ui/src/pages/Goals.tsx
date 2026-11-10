import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { GoalNode, State } from '../api';
import { Badge, Confirm, Editable, Empty, Icon, IconButton, QuickAdd } from '../components/ui';
import { fmtMin, round2 } from '../util';

/** Same shape as the Core's goal.tree query, built locally so it stays live. */
function buildTree(S: State): GoalNode[] {
  const minutes = new Map<string, number>();
  for (const s of S.sessions) if (s.taskId) minutes.set(s.taskId, (minutes.get(s.taskId) || 0) + s.minutes);
  const ids = new Set(S.goals.map((g) => g.id));
  const build = (g: State['goals'][number]): GoalNode => {
    const tasks = S.tasks.filter((t) => t.goalId === g.id).map((t) => ({
      id: t.id, title: t.title, done: t.done, date: t.date, est: t.est, next: t.next, minutes: round2(minutes.get(t.id) || 0), origin: t.origin,
    }));
    const children = S.goals.filter((c) => c.parentId === g.id).sort((a, b) => a.order - b.order).map(build);
    return {
      id: g.id, title: g.title, note: g.note, status: g.status, origin: g.origin, tasks, children,
      minutes: round2(tasks.reduce((n, t) => n + t.minutes, 0) + children.reduce((n, c) => n + c.minutes, 0)),
      taskCount: tasks.length + children.reduce((n, c) => n + c.taskCount, 0),
      taskDone: tasks.filter((t) => t.done).length + children.reduce((n, c) => n + c.taskDone, 0),
    };
  };
  return S.goals.filter((g) => !g.parentId || !ids.has(g.parentId)).sort((a, b) => a.order - b.order).map(build);
}

function Node({ g, depth }: { g: GoalNode; depth: number }) {
  const { run, today, go } = useApp();
  const [open, setOpen] = useState(depth < 3);
  const [adding, setAdding] = useState<null | 'goal' | 'task'>(null);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const hasKids = g.children.length + g.tasks.length > 0;
  const pct = g.taskCount ? Math.round((g.taskDone / g.taskCount) * 100) : 0;
  return (
    <li className={`gnode status-${g.status}`} data-goal={g.title}>
      <div className="gnode-row">
        <button type="button" className={`caret${open ? ' open' : ''}${hasKids ? '' : ' hidden'}`} onClick={() => setOpen((v) => !v)} aria-label={open ? '收起' : '展开'}>
          <Icon name="chevron" size={14} />
        </button>
        <div className="gnode-main">
          <div className="gnode-title">
            <Editable value={g.title} editing={editing} onDone={() => setEditing(false)} onSave={(title) => run('goal.update', { goalId: g.id, title })} />
            {g.origin === 'agent' && <Badge tone="ai">AI 建议</Badge>}
            {g.status === 'done' && <Badge tone="ok">已达成</Badge>}
            {g.status === 'dropped' && <Badge tone="muted">已放下</Badge>}
          </div>
          {g.note && <p className="gnode-note">{g.note}</p>}
          <div className="gnode-meta">
            {g.taskCount > 0 && <><div className="progress" title={`${pct}%`}><i style={{ width: `${pct}%` }} /></div><span>{g.taskDone} / {g.taskCount} 个任务</span></>}
            {g.minutes > 0 && <span>已记录 {fmtMin(g.minutes)}</span>}
          </div>
        </div>
        {asking ? (
          <Confirm text="删除这个目标和它的下级目标？任务和计时记录会保留。" yes="删除" onYes={() => run('goal.delete', { goalId: g.id })} onNo={() => setAsking(false)} />
        ) : (
          <div className="gnode-actions">
            {depth < 6 && <button className="btn sm ghost" onClick={() => { setOpen(true); setAdding('goal'); }}>+ 子目标</button>}
            <button className="btn sm ghost" onClick={() => { setOpen(true); setAdding('task'); }}>+ 任务</button>
            <IconButton name="spark" label="让 AI 继续拆解这个目标"
              onClick={() => go('chat', { chatDraft: `请帮我把目标「${g.title}」继续拆解成更小的子目标和第一步任务，挂在这个目标下面。` })} />
            <IconButton name="check" label={g.status === 'done' ? '改回进行中' : '标记为已达成'} active={g.status === 'done'}
              onClick={() => run('goal.update', { goalId: g.id, status: g.status === 'done' ? 'active' : 'done' })} />
            <IconButton name="edit" label="修改标题" onClick={() => setEditing(true)} />
            <IconButton name="trash" label="删除目标" danger onClick={() => setAsking(true)} />
          </div>
        )}
      </div>
      {open && (
        <div className="gnode-kids">
          {g.tasks.length > 0 && (
            <ul className="gtasks">
              {g.tasks.map((t) => (
                <li key={t.id} className={`gtask${t.done ? ' done' : ''}`}>
                  <input type="checkbox" checked={t.done} aria-label={`完成：${t.title}`} onChange={(e) => run('task.setDone', { taskId: t.id, done: e.target.checked })} />
                  <span className="gtask-title">{t.title}</span>
                  <span className="gtask-meta">
                    {t.date ? t.date === today ? '今天' : t.date : '未排期'} · {t.est} 分钟{t.minutes ? ` · 已记录 ${fmtMin(t.minutes)}` : ''}
                  </span>
                  {!t.done && t.date !== today && <button className="btn sm ghost" onClick={() => run('task.schedule', { taskId: t.id, date: today })}>今天做</button>}
                </li>
              ))}
            </ul>
          )}
          {adding === 'task' && <QuickAdd autoFocus placeholder="这个目标下的一个任务，回车保存" onCancel={() => setAdding(null)}
            onAdd={(title) => run('task.add', { title, date: null, goalId: g.id })} />}
          {adding === 'goal' && <QuickAdd autoFocus placeholder="子目标，回车保存" onCancel={() => setAdding(null)}
            onAdd={(title) => run('goal.add', { title, parentId: g.id })} />}
          {g.children.length > 0 && <ul className="gtree">{g.children.map((c) => <Node key={c.id} g={c} depth={depth + 1} />)}</ul>}
        </div>
      )}
    </li>
  );
}

export function Goals() {
  const { S, run, go } = useApp();
  const tree = useMemo(() => buildTree(S), [S]);
  const [adding, setAdding] = useState(false);
  const askAi = () => go('chat', { chatDraft: '我想达成的目标是：\n\n请先问我几个关键问题，再帮我拆成一棵目标树。' });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>目标</h1>
          <p className="muted">大目标拆成小目标，小目标落到能直接开始的任务。</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> 新目标</button>
          <button className="btn primary" onClick={askAi}><Icon name="spark" size={15} /> 让 AI 帮我拆解</button>
        </div>
      </header>
      {adding && <section className="card"><QuickAdd autoFocus placeholder="目标名称，回车保存" onCancel={() => setAdding(false)}
        onAdd={async (title) => { await run('goal.add', { title }); setAdding(false); }} /></section>}
      {tree.length ? (
        <section className="card"><ul className="gtree root">{tree.map((g) => <Node key={g.id} g={g} depth={1} />)}</ul></section>
      ) : !adding && (
        <section className="card">
          <Empty title="还没有目标">
            <p className="muted">可以自己写一个，也可以在聊天里告诉 AI 你想做成什么，它会先提一份草稿，你确认后才会写进来。</p>
          </Empty>
        </section>
      )}
    </div>
  );
}
