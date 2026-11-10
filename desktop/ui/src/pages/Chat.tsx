import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type ChatEvent, type ChatMessage, type ChatMeta, type Conversation, type DraftNode, type ProfileList, type Proposal } from '../api';
import { useApp } from '../store';
import { Badge, Confirm, Icon, IconButton } from '../components/ui';
import { dayLabel, weekdayOf, md } from '../util';

const SUGGESTIONS = [
  '我想达成一个目标，帮我拆成目标树。先问我几个关键问题。',
  '看看我最近的记录，帮我排一下这一周。',
  '今天先做哪一件？第一步是什么？',
  '回顾一下我这周的学习记录。',
];

const MD = ({ text }: { text: string }) => <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;

function TreePreview({ node }: { node: DraftNode }) {
  return (
    <li>
      <span className="pv-goal">{node.title}</span>
      {node.note && <span className="pv-note"> — {node.note}</span>}
      {(node.tasks?.length || node.children?.length) ? (
        <ul>
          {node.tasks?.map((t, i) => <li key={'t' + i} className="pv-task">☐ {t.title}{t.est ? <em> {t.est} 分钟</em> : null}</li>)}
          {node.children?.map((c, i) => <TreePreview key={'c' + i} node={c} />)}
        </ul>
      ) : null}
    </li>
  );
}

function Preview({ p }: { p: Proposal }) {
  const { today } = useApp();
  const v = p.preview;
  if (v.kind === 'goalTree') return (
    <>
      {v.parent && <p className="muted small">挂在「{v.parent}」下面</p>}
      <ul className="pv-tree"><TreePreview node={v.tree} /></ul>
    </>
  );
  if (v.kind === 'tasks') return (
    <ul className="pv-list">
      {v.tasks.map((t, i) => <li key={i}>☐ {t.title}<em> {t.date ? dayLabel(t.date, today) : '以后清单'}{t.est ? ` · ${t.est} 分钟` : ''}{t.goal ? ` · ${t.goal}` : ''}</em></li>)}
    </ul>
  );
  if (v.kind === 'week') {
    const groups = [...v.days.map((d) => ({ label: `${weekdayOf(d)} ${md(d)}`, items: v.items.filter((i) => i.date === d) })),
      { label: '本周未定', items: v.items.filter((i) => !i.date) }].filter((g) => g.items.length);
    return (
      <>
        {v.focus && <p><b>本周重点：</b>{v.focus}</p>}
        {v.goals.length > 0 && <p className="muted small">重点目标：{v.goals.join('、')}</p>}
        {groups.map((g) => (
          <div key={g.label} className="pv-day">
            <span className="pv-daylabel">{g.label}</span>
            <ul className="pv-list">{g.items.map((i, k) => <li key={k}>{i.title}<em>{i.est ? ` ${i.est} 分钟` : ''}{i.isNew ? ' · 新任务' : ''}</em></li>)}</ul>
          </div>
        ))}
        <p className="muted small">合计约 {v.totalMinutes} 分钟{v.capacityMin ? `，打算投入 ${v.capacityMin} 分钟` : ''}</p>
      </>
    );
  }
  return (
    <>
      <p>{v.task}</p>
      <ul className="pv-list">{v.changes.map((c, i) => <li key={i}>{c.field}：<s>{String(c.from ?? '无')}</s> → <b>{String(c.to ?? '无')}</b></li>)}</ul>
    </>
  );
}

function ProposalCard({ p, chatId }: { p: Proposal; chatId: string }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (accept: boolean) => {
    setBusy(true);
    const r = await api.chat.decide({ chatId, proposalId: p.id, accept });
    setBusy(false);
    if (!r.ok && r.error) toast(r.error);
  };
  return (
    <div className={`proposal ${p.status}`} data-testid="proposal">
      <div className="proposal-head">
        <Icon name="spark" size={15} />
        <b>{p.title}</b>
        {p.status === 'pending' && <Badge tone="warn">等你确认</Badge>}
        {p.status === 'accepted' && <Badge tone="ok">已写入</Badge>}
        {p.status === 'rejected' && <Badge tone="muted">没有采用</Badge>}
        {p.status === 'failed' && <Badge tone="warn">写入失败</Badge>}
      </div>
      <div className="proposal-body"><Preview p={p} /></div>
      {p.status === 'failed' && <p className="err">{p.error}</p>}
      {p.status === 'pending' && (
        <div className="row proposal-actions">
          <button className="btn primary" disabled={busy} onClick={() => decide(true)}>确认写入</button>
          <button className="btn ghost" disabled={busy} onClick={() => decide(false)}>不要</button>
          <span className="muted small">确认前不会改动任何数据。</span>
        </div>
      )}
    </div>
  );
}

function ToolChip({ m, args }: { m: ChatMessage; args?: string }) {
  const [open, setOpen] = useState(false);
  let pretty = m.content;
  try { pretty = JSON.stringify(JSON.parse(m.content), null, 2); } catch { /* keep raw */ }
  return (
    <div className={`toolchip${m.failed ? ' failed' : ''}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-dot" />{m.label || m.name}{m.failed ? ' · 未成功' : ''}
        <span className={`caret${open ? ' open' : ''}`}><Icon name="chevron" size={12} /></span>
      </button>
      {open && <pre className="tool-detail">{args && args !== '{}' ? `参数 ${args}\n\n` : ''}{pretty.slice(0, 4000)}</pre>}
    </div>
  );
}

function Messages({ convo, live }: { convo: Conversation; live: { content: string; reasoning: string } | null }) {
  const calls = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of convo.messages) for (const c of m.toolCalls || []) map.set(c.id, c.arguments);
    return map;
  }, [convo.messages]);
  return (
    <>
      {convo.messages.map((m) => {
        if (m.role === 'user') return <div key={m.id} className="msg user"><div className="bubble">{m.content}</div></div>;
        if (m.role === 'tool') {
          const p = m.proposalId ? convo.proposals[m.proposalId] : null;
          return <div key={m.id} className="msg tool">{p ? <ProposalCard p={p} chatId={convo.id} /> : <ToolChip m={m} args={calls.get(m.toolCallId || '')} />}</div>;
        }
        if (!m.content && !m.error && !m.reasoning) return null; // a pure tool-call step
        return (
          <div key={m.id} className="msg assistant">
            {m.reasoning && <details className="reasoning"><summary>思考过程</summary><p>{m.reasoning}</p></details>}
            {m.content && <MD text={m.content} />}
            {m.stopped && <p className="muted small">已停止</p>}
            {m.error && <p className="err" data-testid="chat-error">{m.error}</p>}
          </div>
        );
      })}
      {live && (
        <div className="msg assistant live">
          {live.reasoning && !live.content && <details className="reasoning" open><summary>正在思考…</summary><p>{live.reasoning}</p></details>}
          {live.content ? <MD text={live.content} /> : !live.reasoning && <div className="typing"><i /><i /><i /></div>}
        </div>
      )}
    </>
  );
}

export function Chat() {
  const { go, takeChatDraft, toast } = useApp();
  const [list, setList] = useState<ChatMeta[]>([]);
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [live, setLive] = useState<{ content: string; reasoning: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const [profiles, setProfiles] = useState<ProfileList | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const box = useRef<HTMLTextAreaElement>(null);

  const refreshList = useCallback(() => api.chat.list().then(setList), []);
  const open = useCallback(async (id: string | null) => {
    current.current = id;
    setLive(null);
    if (!id) { setConvo(null); setRunning(false); return; }
    const c = await api.chat.load(id);
    if (current.current !== id) return;
    setConvo(c); setRunning(!!c?.running); stick.current = true;
    if (c?.running) setLive({ content: '', reasoning: '' });
  }, []);

  useEffect(() => {
    void api.ai.profiles().then(setProfiles);
    void api.chat.list().then((l) => { setList(l); });
    const d = takeChatDraft();
    if (d) { setText(d); requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(d.length, d.length); }); }
  }, [takeChatDraft]);

  useEffect(() => api.chat.onEvent((e: ChatEvent) => {
    if (e.type === 'title') { void refreshList(); }
    if (e.chatId !== current.current) return;
    if (e.type === 'start') { setRunning(true); setLive({ content: '', reasoning: '' }); }
    else if (e.type === 'delta') setLive((l) => ({ content: (l?.content || '') + (e.content || ''), reasoning: (l?.reasoning || '') + (e.reasoning || '') }));
    else if (e.type === 'message') {
      setConvo((c) => (c && !c.messages.some((m) => m.id === e.message.id) ? { ...c, messages: [...c.messages, e.message] } : c));
      if (e.message.role !== 'user') setLive((l) => (l ? { content: '', reasoning: '' } : l));
    } else if (e.type === 'proposal') setConvo((c) => (c ? { ...c, proposals: { ...c.proposals, [e.proposal.id]: e.proposal } } : c));
    else if (e.type === 'title') setConvo((c) => (c ? { ...c, title: e.title } : c));
    else if (e.type === 'done') { setRunning(false); setLive(null); void refreshList(); }
  }), [refreshList]);

  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [convo, live]);
  const onScroll = () => { const el = scroller.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };

  const active = profiles?.profiles.find((p) => p.id === profiles.activeId) || null;

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || running) return;
    if (!active) { toast('还没有配置模型，请先到设置里添加。'); go('settings'); return; }
    let id = current.current;
    if (!id) {
      const c = await api.chat.create();
      id = c.id; current.current = id;
      setConvo({ ...c, messages: [], proposals: {}, running: false });
      void refreshList();
    }
    setText(''); stick.current = true;
    const r = await api.chat.send({ chatId: id, text: body });
    if (!r.ok && r.needProfile) { toast(r.error || '请先配置模型'); go('settings'); }
    else if (!r.ok && r.error && current.current !== id) toast(r.error);
  };

  const remove = async (id: string) => {
    await api.chat.remove(id);
    setAsking(null);
    if (current.current === id) await open(null);
    void refreshList();
  };

  const empty = !convo || convo.messages.length === 0;
  return (
    <div className="chat">
      <aside className="chat-side">
        <button className="btn primary block" onClick={() => { void open(null); box.current?.focus(); }}><Icon name="plus" size={15} /> 新对话</button>
        <ul className="chat-list">
          {list.map((c) => (
            <li key={c.id} className={c.id === convo?.id ? 'on' : ''}>
              {asking === c.id ? <Confirm text="删除？" yes="删除" onYes={() => remove(c.id)} onNo={() => setAsking(null)} /> : (
                <>
                  <button type="button" className="chat-item" onClick={() => open(c.id)} title={c.title}>{c.title}</button>
                  <IconButton name="trash" label="删除对话" danger onClick={() => setAsking(c.id)} />
                </>
              )}
            </li>
          ))}
          {!list.length && <li className="muted small pad">对话会保存在这台电脑上。</li>}
        </ul>
      </aside>

      <section className="chat-main">
        <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
          <div className="chat-col">
            {empty && !live ? (
              <div className="chat-empty">
                <div className="brand big">T</div>
                <h2>想从哪里开始？</h2>
                <p className="muted">我可以读你的任务、目标和计时记录，帮你拆目标、排一周、做复盘。<br />所有改动都会先给你看，你确认后才写入。</p>
                {!active ? (
                  <button className="btn primary" onClick={() => go('settings')}>先去配置模型</button>
                ) : (
                  <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => { setText(s); box.current?.focus(); }}>{s}</button>)}</div>
                )}
              </div>
            ) : convo && <Messages convo={convo} live={live} />}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea ref={box} value={text} rows={Math.min(8, Math.max(1, text.split('\n').length))} maxLength={20000}
              placeholder="说说你想做什么…（Enter 发送，Shift+Enter 换行）" data-testid="chat-input"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <div className="composer-bar">
              {profiles && profiles.profiles.length > 0 ? (
                <select className="model" value={profiles.activeId || ''} aria-label="模型" disabled={running}
                  onChange={async (e) => { await api.ai.setActive(e.target.value); setProfiles(await api.ai.profiles()); }}>
                  {profiles.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : <button className="btn sm ghost" onClick={() => go('settings')}>配置模型</button>}
              {active && active.tools !== true && (
                <span className="muted small" title={active.toolsNote || '在设置里点“测试连接”可以检测'}>
                  {active.tools === false ? '此模型不支持工具调用：只能聊天，不能读取数据或提议修改' : '还没有测试连接：暂时只能纯聊天'}
                </span>
              )}
              <span className="grow" />
              {running
                ? <button className="btn" onClick={() => convo && api.chat.stop(convo.id)} data-testid="chat-stop"><Icon name="stop" size={13} fill /> 停止</button>
                : <button className="btn primary" disabled={!text.trim()} onClick={() => send()} data-testid="chat-send" aria-label="发送"><Icon name="send" size={15} /></button>}
            </div>
          </div>
          <p className="muted small center">AI 的回答可能有误。它不能修改计时记录，也不能替你把任务标记为完成。</p>
        </div>
      </section>
    </div>
  );
}
