'use strict';
// Chat service: ties together the conversation store, the model profiles, the
// tool registry and the Core. Runs in the main process; no Electron imports
// (fetch and the stores are injected), so the whole agent loop is unit-tested.
//
// One user message = one "turn": the model is called, any tools it asks for
// are run, and the model is called again with the results, until it answers
// in plain text or the step limit is reached.
//
// Writes are never applied inside the loop. A write tool produces a proposal,
// the model is told "waiting for the user", and the turn carries on. The user
// accepts or rejects later with decide(); the model sees the up-to-date status
// of every proposal the next time it is called.

const { streamChat, probe, ProviderError } = require('./provider');
const tools = require('./tools');
const plan = require('../plan');
const { dateOfMs } = require('../core');
const { uid } = require('./chats');

const MAX_STEPS = 8;        // model calls per turn
const HISTORY_LIMIT = 60;   // stored messages sent back to the model

const RULES = [
  '你是「T计划」里的学习计划助手，帮用户把目标拆成目标树、安排周计划、回看学习记录。',
  '回答用简体中文，简短、具体、平和，不说教。',
  '',
  '必须遵守：',
  '1. 关于任务、计划、学习时长的事实只能来自工具返回的数据或下面的「当前数据」，不要猜测或编造数字。',
  '2. 「没有计时记录」只表示没有记录，不代表用户没有学习；不要推测原因，不要批评。',
  '3. 你不能修改计时记录，也不能把任务标记为完成，这些只由用户自己操作。',
];
const RULES_TOOLS = [
  '4. 所有修改都通过 propose_ 开头的工具提出。提议不会立即生效，用户在界面上确认后才写入；在看到“已确认”之前，不要说“已经添加/已经安排”。',
  '5. 做计划前先用读取工具了解现状。信息不足以拆解目标时，先问 1-3 个关键问题（截止时间、每周可用时间、当前基础），不要直接生成一大棵树。',
  '6. 目标树要小而可执行：每个末端目标配 1-3 个“打开就能做”的第一步。周计划的总时长参考最近几周实际记录的分钟数。',
  '7. 提出提议后，用一两句话说明你的考虑，然后等用户决定。',
];
const RULES_NOTOOLS = [
  '4. 当前模型没有启用工具调用，你无法读取更多数据，也无法提出可一键写入的提议。需要修改计划时，把建议写成清晰的清单，由用户自己在界面上添加。',
];

function systemPrompt(core, now, withTools) {
  const o = tools.overview(core, now);
  const lines = [...RULES, ...(withTools ? RULES_TOOLS : RULES_NOTOOLS), '', '当前数据：', JSON.stringify(o)];
  if (!withTools) {
    // Without tools the model cannot look anything up, so hand it a digest.
    const S = core.S, ws = o.week_start;
    const wf = plan.weekFacts(S, ws);
    lines.push('', '本周：', JSON.stringify({
      plan: wf.plan ? { focus: wf.plan.focus, capacity_minutes: wf.plan.capacityMin } : null,
      planned_tasks: plan.weekView(S, ws).tasks.slice(0, 40).map((t) => ({ title: t.title, date: t.date, est_minutes: t.est, done: t.done })),
      recorded_per_day: wf.perDay, recorded_by_task: wf.tasks.slice(0, 20).map((r) => ({ title: r.title, minutes: r.minutes })),
    }));
    const tree = JSON.stringify(tools.trimTree(plan.goalTree(S)));
    lines.push('', '目标树：', tree.length > 6000 ? tree.slice(0, 6000) + '…' : tree);
  }
  return lines.join('\n');
}

function proposalStatusText(p) {
  if (!p) return JSON.stringify({ status: 'unknown', message: '这份提议的记录已丢失。' });
  if (p.status === 'accepted') return JSON.stringify({ status: 'accepted', message: '用户已确认，已写入。', result: p.result || null });
  if (p.status === 'rejected') return JSON.stringify({ status: 'rejected', message: '用户拒绝了这份提议，没有写入。' });
  if (p.status === 'failed') return JSON.stringify({ status: 'failed', message: '用户确认了，但写入失败：' + (p.error || '') });
  return JSON.stringify({ status: 'pending', message: '已提交给用户，等待确认。尚未写入，不要当作已生效。' });
}

/**
 * Convert stored messages to the API format. Guarantees the structure the
 * API requires: every assistant tool call is followed by exactly one tool
 * message, and nothing dangles after an interrupted turn.
 */
function toApiMessages(stored, proposals) {
  let list = stored.slice(-HISTORY_LIMIT);
  const firstUser = list.findIndex((m) => m.role === 'user');
  list = firstUser < 0 ? [] : list.slice(firstUser);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'user') { out.push({ role: 'user', content: m.content }); continue; }
    if (m.role !== 'assistant') continue; // tool messages are consumed below
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    if (!calls.length) { if (m.content) out.push({ role: 'assistant', content: m.content }); continue; }
    out.push({
      role: 'assistant', content: m.content || '',
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    const results = new Map();
    for (let j = i + 1; j < list.length && list[j].role === 'tool'; j++) results.set(list[j].toolCallId, list[j]);
    for (const c of calls) {
      const r = results.get(c.id);
      const content = !r ? JSON.stringify({ error: '这次工具调用没有执行（对话被中断）。' })
        : r.proposalId ? proposalStatusText(proposals[r.proposalId]) : r.content;
      out.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  return out;
}

const titleFrom = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话';

class ChatService {
  /**
   * @param {object} deps
   * @param {import('../core').Core} deps.core
   * @param {import('./chats').Chats} deps.chats
   * @param {import('./profiles').Profiles} deps.profiles
   * @param {Function} deps.fetch
   * @param {() => number} [deps.now]
   * @param {(event: object) => void} [deps.emit]  streamed to the chat window
   */
  constructor(deps) {
    this.core = deps.core;
    this.chats = deps.chats;
    this.profiles = deps.profiles;
    this.fetch = deps.fetch;
    this.now = deps.now || Date.now;
    this.emit = deps.emit || (() => {});
    this.running = new Map(); // chatId -> AbortController
  }

  isRunning(chatId) { return this.running.has(chatId); }

  stop(chatId) {
    const c = this.running.get(chatId);
    if (c) c.abort();
    return { ok: true };
  }

  async testProfile(id) {
    const p = this.profiles.get(id);
    if (!p) return { ok: false, error: '找不到这组配置' };
    if (!p.apiKey) return { ok: false, error: '这组配置还没有保存密钥' };
    const r = await probe({ fetch: this.fetch, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model });
    this.profiles.recordTest(p.id, r);
    return r;
  }

  /** Send one user message and run the turn. Resolves when the turn ends. */
  async send({ chatId, text, profileId }) {
    const content = String(text || '').trim().slice(0, 20000);
    if (!content) return { ok: false, error: '消息是空的' };
    const meta = this.chats.meta(chatId);
    if (!meta) return { ok: false, error: '找不到这个会话' };
    if (this.running.has(chatId)) return { ok: false, error: '上一条消息还在回答中' };
    const profile = this.profiles.get(profileId);
    if (!profile) return { ok: false, error: '还没有配置模型。请先到「设置」里添加接口地址、密钥和模型名。', needProfile: true };
    if (!profile.apiKey) return { ok: false, error: '这组模型配置没有保存密钥。', needProfile: true };

    const convo = this.chats.load(chatId);
    const first = !convo.messages.some((m) => m.role === 'user');
    const userMsg = this.chats.addMessage(chatId, { role: 'user', content });
    this.emit({ chatId, type: 'message', message: userMsg });
    if (first) {
      const c = this.chats.rename(chatId, titleFrom(content));
      this.emit({ chatId, type: 'title', title: c.title });
    }

    const ctrl = new AbortController();
    this.running.set(chatId, ctrl);
    this.emit({ chatId, type: 'start' });
    try {
      await this.runTurn(chatId, profile, ctrl.signal);
      this.emit({ chatId, type: 'done' });
      return { ok: true };
    } catch (e) {
      const aborted = e instanceof ProviderError && e.kind === 'aborted';
      if (aborted) { this.emit({ chatId, type: 'done', stopped: true }); return { ok: true, stopped: true }; }
      const message = e instanceof ProviderError ? e.message : '出错了：' + String(e && e.message || e);
      const err = this.chats.addMessage(chatId, { role: 'assistant', content: '', error: message, model: profile.model });
      this.emit({ chatId, type: 'message', message: err });
      this.emit({ chatId, type: 'done', error: message });
      return { ok: false, error: message };
    } finally {
      this.running.delete(chatId);
    }
  }

  async runTurn(chatId, profile, signal) {
    const withTools = profile.tools === true;
    for (let step = 0; step < MAX_STEPS; step++) {
      const convo = this.chats.load(chatId);
      const messages = [
        { role: 'system', content: systemPrompt(this.core, this.now(), withTools) },
        ...toApiMessages(convo.messages, convo.proposals),
      ];
      let reply;
      try {
        reply = await streamChat({
          fetch: this.fetch, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, signal, messages,
          tools: withTools ? tools.definitions() : undefined,
          onDelta: (d) => this.emit({ chatId, type: 'delta', ...d }),
        });
      } catch (e) {
        // Keep whatever text had already arrived when the user pressed stop.
        if (e instanceof ProviderError && e.kind === 'aborted' && e.partial && e.partial.content) {
          const m = this.chats.addMessage(chatId, { role: 'assistant', content: e.partial.content, model: profile.model, stopped: true });
          this.emit({ chatId, type: 'message', message: m });
        }
        throw e;
      }

      const calls = withTools ? reply.toolCalls : [];
      const assistant = this.chats.addMessage(chatId, {
        role: 'assistant', content: reply.content, model: profile.model,
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      this.emit({ chatId, type: 'message', message: assistant });
      if (!calls.length) return;

      for (const c of calls) {
        const r = tools.call(c.name, c.arguments, { core: this.core, now: this.now() });
        const info = tools.describe(c.name);
        if (r.kind === 'proposal') {
          const proposal = this.chats.putProposal(chatId, { id: uid('pr'), ...r.draft, status: 'pending', at: this.now(), result: null, error: null });
          const tm = this.chats.addMessage(chatId, { role: 'tool', toolCallId: c.id, name: c.name, label: info.label, content: '', proposalId: proposal.id });
          this.emit({ chatId, type: 'proposal', proposal });
          this.emit({ chatId, type: 'message', message: tm });
        } else {
          const tm = this.chats.addMessage(chatId, { role: 'tool', toolCallId: c.id, name: c.name, label: info.label, content: r.content, ...(r.kind === 'error' ? { failed: true } : {}) });
          this.emit({ chatId, type: 'message', message: tm });
        }
      }
      if (signal.aborted) throw new ProviderError('已停止', { kind: 'aborted' });
    }
    const m = this.chats.addMessage(chatId, { role: 'assistant', content: '这一轮已经查了很多次数据，先停在这里。需要的话请告诉我接着做什么。' });
    this.emit({ chatId, type: 'message', message: m });
  }

  /** The user's decision on a proposal. Accepting runs the stored command once. */
  decide({ chatId, proposalId, accept }) {
    const convo = this.chats.load(chatId);
    const p = convo && convo.proposals[proposalId];
    if (!p) return { ok: false, error: '找不到这份提议' };
    if (p.status !== 'pending') return { ok: false, error: '这份提议已经处理过了', proposal: p };
    const next = { ...p, decidedAt: this.now() };
    if (!accept) next.status = 'rejected';
    else {
      const r = this.core.dispatch(p.command);
      if (r.ok) { next.status = 'accepted'; const { ok, ...rest } = r; next.result = rest; }
      else { next.status = 'failed'; next.error = r.error; }
    }
    this.chats.putProposal(chatId, next);
    this.emit({ chatId, type: 'proposal', proposal: next });
    return { ok: next.status !== 'failed', proposal: next, error: next.error || undefined };
  }

  /**
   * Ask the model for a review draft built only from the recorded facts. The
   * draft is stored in its own field, labelled with the model, next to (never
   * instead of) the user's own reflection.
   */
  async draftReview({ scope, key, profileId }) {
    const profile = this.profiles.get(profileId);
    if (!profile || !profile.apiKey) return { ok: false, error: '还没有可用的模型配置。请先到「设置」里添加。', needProfile: true };
    const q = this.core.query(scope === 'week' ? 'week.facts' : 'day.facts', scope === 'week' ? { weekStart: key } : { date: key });
    if (!q.ok || !q.data) return { ok: false, error: '复盘的日期不正确' };
    const f = q.data;
    const facts = {
      range: scope === 'week' ? `${f.key} 起的一周` : f.key,
      recorded_minutes: f.minutes, sessions: f.count,
      by_task: f.tasks.map((r) => ({ title: r.title, minutes: r.minutes, sessions: r.count, done: r.done, next_step: r.next, notes: r.notes })),
      ...(scope === 'week' ? { per_day: f.perDay, by_goal: f.goals, week_focus: f.plan ? f.plan.focus : '', planned_minutes: f.plannedMinutes } : {}),
      planned_tasks: f.planned, planned_done: f.plannedDone,
      planned_without_timer_record: f.noRecord.map((t) => t.title),
      user_reflection: f.review ? f.review.reflection : '',
    };
    const prompt = [
      `请根据下面的记录，为用户写一份${scope === 'week' ? '本周' : '当天'}学习复盘草稿。`,
      '要求：',
      '- 只使用记录里的事实，数字必须与记录一致，不要编造。',
      '- 「没有计时记录」只说明没有记录，不要写成没学习、拖延或偷懒，也不要推测原因。',
      '- 结构：① 做了什么（事实）② 值得保留的做法 ③ 下一步建议（最多三条，具体到能直接开始）。',
      '- 如果用户写了反思（user_reflection），要回应它，但不要替用户下结论。',
      '- 没有任何记录时，如实说明，并只给一条很小的起步建议。',
      '- 300 字以内，用简体中文，语气平和。',
      '',
      '记录：',
      JSON.stringify(facts),
    ].join('\n');
    let reply;
    try {
      reply = await streamChat({
        fetch: this.fetch, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model,
        messages: [{ role: 'system', content: RULES.join('\n') }, { role: 'user', content: prompt }],
      });
    } catch (e) {
      return { ok: false, error: e instanceof ProviderError ? e.message : String(e && e.message || e) };
    }
    const body = (reply.content || '').trim();
    if (!body) return { ok: false, error: '模型没有返回内容' };
    return this.core.dispatch({ type: 'review.setDraft', payload: { scope, key: f.key, text: body, model: profile.model } });
  }
}

module.exports = { ChatService, toApiMessages, systemPrompt, proposalStatusText, MAX_STEPS };
