import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type DayFacts, type FactRow, type WeekFacts } from '../api';
import { useApp } from '../store';
import { Badge, Icon, IconButton } from '../components/ui';
import { addDays, dayLabel, fmtMin, hm, md, weekStartOf, weekdayOf, ymd } from '../util';

type Scope = 'day' | 'week';
type Facts = DayFacts | WeekFacts;

function Row({ r }: { r: FactRow }) {
  const mark = r.done === true ? '✓' : r.taskId ? '◐' : '·';
  const status = r.done === true ? '完成' : r.taskId ? (r.taskDeleted ? '任务已删除' : '还要继续') : '没有关联任务';
  return (
    <li className="fact">
      <span className={`fact-mark${r.done ? ' ok' : ''}`}>{mark}</span>
      <div className="fact-body">
        <div className="fact-line"><span className="fact-title">{r.title}</span><span className="fact-min">{fmtMin(r.minutes)} · {r.count} 段</span><span className="muted">{status}</span></div>
        {r.next && r.done !== true && <p className="muted small">下一步：{r.next}</p>}
        {r.notes.map((n, i) => <p key={i} className="fact-note">{n}</p>)}
      </div>
    </li>
  );
}

export function Review() {
  const { S, today, run, toast, go } = useApp();
  const [scope, setScope] = useState<Scope>('day');
  const [day, setDay] = useState(today);
  const [week, setWeek] = useState(weekStartOf(today));
  const key = scope === 'day' ? day : week;
  const [facts, setFacts] = useState<Facts | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const rev = S.desktop.rev;

  useEffect(() => {
    let live = true;
    const q = scope === 'day' ? api.query<DayFacts>('day.facts', { date: key }) : api.query<WeekFacts>('week.facts', { weekStart: key });
    void q.then((r) => { if (live && r.ok) setFacts(r.data); });
    return () => { live = false; };
  }, [scope, key, rev]);

  // Load the saved reflection when the period changes, but never clobber typing.
  const saved = facts && facts.key === key && facts.scope === scope ? facts.review?.reflection || '' : null;
  useEffect(() => { if (saved !== null && !dirty) setText(saved); }, [saved, dirty]);
  useEffect(() => { setDirty(false); setFacts(null); }, [scope, key]);

  const save = async () => {
    const r = await run('review.save', { scope, key, reflection: text });
    if (r.ok) setDirty(false);
  };
  const draft = async () => {
    setDrafting(true);
    const r = await api.review.draft({ scope, key });
    setDrafting(false);
    if (!r.ok) { toast(r.error || '生成失败'); if (r.needProfile) go('settings'); }
  };

  const f = facts && facts.key === key && facts.scope === scope ? facts : null;
  const ai = f?.review?.aiDraft || null;
  const step = scope === 'day' ? 1 : 7;
  const move = (n: number) => (scope === 'day' ? setDay(addDays(day, n * step)) : setWeek(addDays(week, n * step)));
  const atNow = scope === 'day' ? day === today : week === weekStartOf(today);
  const title = scope === 'day' ? `${dayLabel(day, today)}${day === today ? ` · ${md(day)} ${weekdayOf(day)}` : ''}` : `${md(week)} – ${md(addDays(week, 6))}${atNow ? ' · 本周' : ''}`;
  const maxDay = f && f.scope === 'week' ? Math.max(1, ...f.perDay.map((d) => d.minutes)) : 1;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>复盘</h1>
          <p className="muted">{title}</p>
        </div>
        <div className="row">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={scope === 'day'} className={scope === 'day' ? 'on' : ''} onClick={() => setScope('day')}>按天</button>
            <button role="tab" aria-selected={scope === 'week'} className={scope === 'week' ? 'on' : ''} onClick={() => setScope('week')}>按周</button>
          </div>
          <IconButton name="left" label={scope === 'day' ? '前一天' : '上一周'} onClick={() => move(-1)} />
          <button className="btn sm" disabled={atNow} onClick={() => (scope === 'day' ? setDay(today) : setWeek(weekStartOf(today)))}>{scope === 'day' ? '今天' : '本周'}</button>
          <IconButton name="chevron" label={scope === 'day' ? '后一天' : '下一周'} disabled={atNow} onClick={() => move(1)} />
        </div>
      </header>

      <section className="card" data-testid="facts">
        <div className="card-head">
          <h3>记录下来的事实</h3>
          <span className="muted">来自计时记录，不会被修改</span>
        </div>
        {!f ? <p className="muted pad">正在读取…</p> : (
          <>
            <div className="stats">
              <div><b>{fmtMin(f.minutes)}</b><span>记录时长</span></div>
              <div><b>{f.count}</b><span>段计时</span></div>
              <div><b>{f.plannedDone} / {f.planned}</b><span>计划任务完成</span></div>
              {f.scope === 'week' && <div><b>{fmtMin(f.plannedMinutes)}</b><span>计划时长</span></div>}
            </div>
            {f.scope === 'week' && (
              <div className="daybars" aria-label="每天记录的时长">
                {f.perDay.map((d) => (
                  <div key={d.date} className="daybar" title={`${md(d.date)}：${fmtMin(d.minutes)}`}>
                    <div className="daybar-track"><i style={{ height: `${(d.minutes / maxDay) * 100}%` }} /></div>
                    <span>{weekdayOf(d.date).slice(1)}</span>
                    <em>{d.minutes ? Math.round(d.minutes) : ''}</em>
                  </div>
                ))}
              </div>
            )}
            {f.scope === 'week' && f.plan?.focus && <p className="pad">本周重点：{f.plan.focus}</p>}
            {f.tasks.length > 0 && <ul className="facts">{f.tasks.map((r, i) => <Row key={(r.taskId || r.title) + i} r={r} />)}</ul>}
            {f.scope === 'week' && f.goals.length > 0 && f.minutes > 0 && (
              <div className="goalsplit">
                <h4>时间花在哪些目标上</h4>
                {f.goals.map((g) => (
                  <div key={g.goalId || 'none'} className="bar-row"><span>{g.title}</span><div className="bar rec"><i style={{ width: `${(g.minutes / f.minutes) * 100}%` }} /></div><b>{fmtMin(g.minutes)}</b></div>
                ))}
              </div>
            )}
            {f.noRecord.length > 0 && (
              <div className="norecord">
                <h4>{scope === 'day' ? '计划在这一天、没有计时记录的任务' : '本周计划里、还没有计时记录的任务'}</h4>
                <ul>{f.noRecord.map((t) => <li key={t.taskId}>{t.title}{'done' in t && t.done ? '（已勾选完成）' : ''}</li>)}</ul>
                <p className="muted small">没有计时记录只说明没有记录，不代表没有学习。</p>
              </div>
            )}
            {f.count === 0 && f.noRecord.length === 0 && <p className="muted pad">这段时间没有计时记录，也没有计划任务。</p>}
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>我的反思</h3>
          <span className="muted">{dirty ? '有未保存的修改' : f?.review?.reflection ? `已保存 · ${hm(f.review.updatedAt)}` : '想到什么写什么，可以不写'}</span>
        </div>
        <textarea className="textarea" rows={5} maxLength={8000} value={text} data-testid="reflection"
          placeholder="哪里顺利？哪里卡住了？下次想怎么做？"
          onChange={(e) => { setText(e.target.value); setDirty(true); }} />
        <div className="row end"><button className="btn primary" disabled={!dirty} onClick={save}>保存</button></div>
      </section>

      <section className="card ai-draft">
        <div className="card-head">
          <h3>AI 复盘草稿 <Badge tone="ai">AI 生成</Badge></h3>
          <div className="row">
            {ai && <button className="btn sm ghost" onClick={() => run('review.clearDraft', { scope, key })}>删除草稿</button>}
            <button className="btn sm" disabled={drafting || !f} onClick={draft} data-testid="draft-btn">
              <Icon name="spark" size={14} /> {drafting ? '正在生成…' : ai ? '重新生成' : '根据记录生成'}
            </button>
          </div>
        </div>
        {ai ? (
          <>
            <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{ai.text}</Markdown></div>
            <p className="muted small">由 {ai.model || '模型'} 于 {md(ymd(new Date(ai.at)))} {hm(ai.at)} 根据上面的记录生成，可能有误。它与“我的反思”分开保存，不会改动任何记录。</p>
          </>
        ) : <p className="muted pad">AI 只会读取上面的事实和你的反思来写草稿，写出的内容单独保存。</p>}
      </section>
    </div>
  );
}
