'use strict';
// Tool registry for the in-app agent. Adding a capability = adding one entry.
//
// Two kinds of tool:
//   read   runs immediately and returns facts computed by the Core.
//   write  never changes anything by itself. It builds ONE Core command plus a
//          preview; the user sees it as a proposal card and decides. The
//          command is dry-run first so the model hears about mistakes at once.
//
// There is deliberately no tool that creates, edits or deletes a session, and
// none that marks a task done: timer records and completion stay the user's.

const plan = require('../plan');
const { petView, dateOfMs } = require('../core');

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const str = { type: 'string' };
const dateProp = (d) => ({ type: 'string', description: d + '，格式 YYYY-MM-DD' });

const taskRow = (t) => ({
  id: t.id, title: t.title, date: t.date || null, at: t.at || null, est_minutes: t.est, done: !!t.done,
  goal_id: t.goalId || null, next_step: t.next || null, week: t.week || null,
});

function trimTree(nodes) {
  return nodes.map((g) => ({
    id: g.id, title: g.title, ...(g.note ? { note: g.note } : {}), status: g.status, made_by: g.origin,
    recorded_minutes: g.minutes, tasks_done: g.taskDone, tasks_total: g.taskCount,
    tasks: g.tasks.map((t) => ({ id: t.id, title: t.title, done: t.done, date: t.date, recorded_minutes: t.minutes })),
    children: trimTree(g.children),
  }));
}

function overview(core, now) {
  const S = core.S;
  const today = dateOfMs(now);
  const v = petView(S, now);
  const d = new Date(now);
  const recent = plan.recentWeeklyMinutes(S, today, 4);
  return {
    today, weekday: WEEKDAY[d.getDay()], time: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
    week_start: plan.weekStartOf(today),
    timer: v.active ? { title: v.active.title, phase: v.active.phase, mode: v.active.mode } : null,
    main_task_today: v.mainTask ? { id: v.mainTask.id, title: v.mainTask.title, next_step: v.mainTask.next } : null,
    today_recorded: { minutes: v.today.minutes, sessions: v.today.count },
    open_tasks: S.tasks.filter((t) => !t.done).length,
    goals: S.goals.length,
    recent_weeks_recorded_minutes: recent.weeks,
    average_recorded_minutes_per_week: recent.average,
  };
}

const TOOLS = [
  {
    name: 'get_overview', kind: 'read', label: '查看当前概况',
    description: '当前日期、本周起始日、是否在计时、今日主任务、今日已记录分钟数、最近四周每周记录的分钟数。做任何计划前先调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: (_a, ctx) => overview(ctx.core, ctx.now),
  },
  {
    name: 'list_tasks', kind: 'read', label: '查看任务',
    description: '列出任务。scope: today=今天, week=本周, later=未排日期, open=全部未完成, done=最近完成。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['today', 'week', 'later', 'open', 'done'] },
        goal_id: { type: 'string', description: '只看某个目标下的任务（可选）' },
        limit: { type: 'integer', description: '最多返回多少条，默认 40' },
      },
      required: ['scope'],
    },
    run(a, ctx) {
      const S = ctx.core.S, today = dateOfMs(ctx.now), ws = plan.weekStartOf(today);
      let list;
      if (a.scope === 'today') list = S.tasks.filter((t) => t.date === today);
      else if (a.scope === 'week') list = plan.tasksOfWeek(S, ws);
      else if (a.scope === 'later') list = S.tasks.filter((t) => !t.done && !t.date);
      else if (a.scope === 'done') list = S.tasks.filter((t) => t.done).sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0));
      else list = S.tasks.filter((t) => !t.done);
      if (a.goal_id) { const ids = plan.subtreeIds(S, a.goal_id); list = list.filter((t) => t.goalId && ids.has(t.goalId)); }
      const limit = Math.max(1, Math.min(100, Number(a.limit) || 40));
      return { total: list.length, tasks: list.slice(0, limit).map(taskRow) };
    },
  },
  {
    name: 'get_goal_tree', kind: 'read', label: '查看目标树',
    description: '完整的目标树：每个目标的下级目标、任务、已记录分钟数，以及节点是用户还是 AI 建的。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: (_a, ctx) => ({ goals: trimTree(plan.goalTree(ctx.core.S)) }),
  },
  {
    name: 'get_week', kind: 'read', label: '查看一周',
    description: '某一周的计划和事实：本周重点、每天安排的任务、每天实际记录的分钟数、按任务和目标汇总的时长。不传 week_start 表示本周。',
    parameters: { type: 'object', properties: { week_start: dateProp('该周内任意一天') }, required: [] },
    run(a, ctx) {
      const S = ctx.core.S;
      const ws = plan.weekStartOf(plan.isDate(a.week_start) ? a.week_start : dateOfMs(ctx.now));
      const f = plan.weekFacts(S, ws), v = plan.weekView(S, ws);
      return {
        week_start: ws, days: f.days,
        plan: f.plan ? { focus: f.plan.focus, capacity_minutes: f.plan.capacityMin, goal_ids: f.plan.goalIds, note: f.plan.note } : null,
        planned_tasks: v.tasks.map((t) => ({ id: t.id, title: t.title, date: t.date, est_minutes: t.est, done: t.done, goal_id: t.goalId })),
        planned_minutes: f.plannedMinutes,
        recorded: { minutes: f.minutes, sessions: f.count, per_day: f.perDay, by_task: f.tasks.map(({ notes, ...r }) => r), by_goal: f.goals },
        planned_without_timer_record: f.noRecord,
        user_reflection: f.review ? f.review.reflection : '',
      };
    },
  },
  {
    name: 'get_day', kind: 'read', label: '查看一天',
    description: '某一天的事实：记录了几段、多少分钟、按任务汇总、当天计划了但没有计时记录的任务、用户写的反思。',
    parameters: { type: 'object', properties: { date: dateProp('日期') }, required: ['date'] },
    run(a, ctx) {
      if (!plan.isDate(a.date)) throw new Error('date 必须是 YYYY-MM-DD');
      const f = plan.dayFacts(ctx.core.S, a.date);
      return {
        date: a.date, recorded: { minutes: f.minutes, sessions: f.count, by_task: f.tasks },
        planned: f.planned, planned_done: f.plannedDone, planned_without_timer_record: f.noRecord,
        user_reflection: f.review ? f.review.reflection : '',
      };
    },
  },
  {
    name: 'propose_tasks', kind: 'write', label: '提议添加任务',
    description: '提议添加一个或多个任务。不会直接写入，用户确认后才生效。date 省略表示放进“以后清单”。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: str, date: dateProp('哪一天做（可选）'), est_minutes: { type: 'integer' }, goal_id: { type: 'string', description: '关联的目标（可选）' } },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    build(a, ctx) {
      const tasks = (Array.isArray(a.tasks) ? a.tasks : []).map((t) => ({ title: t.title, date: t.date || null, est: t.est_minutes, goalId: t.goal_id || null }));
      return {
        title: `添加 ${tasks.length} 个任务`,
        command: { type: 'task.addMany', payload: { tasks, origin: 'agent' } },
        preview: { kind: 'tasks', tasks: tasks.map((t) => ({ ...t, goal: goalTitle(ctx.core.S, t.goalId) })) },
      };
    },
  },
  {
    name: 'propose_goal_tree', kind: 'write', label: '提议目标树',
    description: [
      '提议一棵目标树（或挂到已有目标下的一个分支）。不会直接写入，用户确认后才生效。',
      'tree 是一个节点：{title, note?, tasks?: [{title, est_minutes?}], children?: [同样结构的节点]}。',
      '最多 6 层。每个末端目标给 1-3 个“打开就能做”的第一步任务，不要一次列出几十个任务。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        parent_goal_id: { type: 'string', description: '挂到哪个已有目标下（可选，省略则为顶层目标）' },
        tree: {
          type: 'object',
          properties: {
            title: str, note: str,
            tasks: { type: 'array', items: { type: 'object', properties: { title: str, est_minutes: { type: 'integer' } }, required: ['title'] } },
            children: { type: 'array', items: { type: 'object' }, description: '下级目标，结构与 tree 相同' },
          },
          required: ['title'],
        },
      },
      required: ['tree'],
    },
    build(a, ctx) {
      const conv = (n) => (n && typeof n === 'object' ? {
        title: n.title, note: n.note || '',
        tasks: (Array.isArray(n.tasks) ? n.tasks : []).map((t) => (typeof t === 'string' ? { title: t } : { title: t && t.title, est: t && t.est_minutes })),
        children: (Array.isArray(n.children) ? n.children : []).map(conv),
      } : n);
      const tree = conv(a.tree);
      return {
        title: `建立目标树「${String((tree && tree.title) || '').slice(0, 40)}」`,
        command: { type: 'goal.applyDraft', payload: { tree, parentId: a.parent_goal_id || null, origin: 'agent' } },
        preview: { kind: 'goalTree', parent: goalTitle(ctx.core.S, a.parent_goal_id), tree },
      };
    },
  },
  {
    name: 'propose_week_plan', kind: 'write', label: '提议周计划',
    description: [
      '提议一周的计划。不会直接写入，用户确认后才生效。',
      'assign 把已有任务排到某一天；add 新建任务。date 必须在该周内，省略表示“本周内、哪天未定”。',
      '安排的总时长应参考 get_overview 里最近几周实际记录的分钟数，不要超出太多。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        week_start: dateProp('该周内任意一天'),
        focus: { type: 'string', description: '本周重点，一句话' },
        capacity_minutes: { type: 'integer', description: '本周打算投入的总分钟数（可选）' },
        goal_ids: { type: 'array', items: str, description: '本周重点目标（可选）' },
        assign: { type: 'array', items: { type: 'object', properties: { task_id: str, date: dateProp('哪一天') }, required: ['task_id'] } },
        add: {
          type: 'array',
          items: { type: 'object', properties: { title: str, date: dateProp('哪一天'), est_minutes: { type: 'integer' }, goal_id: str }, required: ['title'] },
        },
      },
      required: ['week_start'],
    },
    build(a, ctx) {
      const S = ctx.core.S;
      const ws = plan.isDate(a.week_start) ? plan.weekStartOf(a.week_start) : a.week_start;
      const assign = (Array.isArray(a.assign) ? a.assign : []).map((x) => ({ taskId: x.task_id, date: x.date || null }));
      const add = (Array.isArray(a.add) ? a.add : []).map((x) => ({ title: x.title, date: x.date || null, est: x.est_minutes, goalId: x.goal_id || null }));
      const payload = { weekStart: ws, assign, add, origin: 'agent' };
      if (a.focus !== undefined) payload.focus = a.focus;
      if (a.capacity_minutes !== undefined) payload.capacityMin = a.capacity_minutes;
      if (Array.isArray(a.goal_ids)) payload.goalIds = a.goal_ids;
      const items = [
        ...assign.map((x) => { const t = ctx.core.task(x.taskId); return { title: t ? t.title : x.taskId, date: x.date, est: t ? t.est : null, isNew: false }; }),
        ...add.map((x) => ({ title: x.title, date: x.date, est: x.est || 30, isNew: true })),
      ];
      return {
        title: `安排 ${ws} 这一周`,
        command: { type: 'week.applyDraft', payload },
        preview: {
          kind: 'week', weekStart: ws, days: plan.isDate(ws) ? plan.weekDays(ws) : [], focus: a.focus || '', capacityMin: a.capacity_minutes || null,
          goals: (payload.goalIds || []).map((id) => goalTitle(S, id)).filter(Boolean), items,
          totalMinutes: items.reduce((n, i) => n + (Number(i.est) || 0), 0),
        },
      };
    },
  },
  {
    name: 'propose_task_update', kind: 'write', label: '提议修改任务',
    description: '提议修改一个已有任务的标题、日期、预计时长或所属目标。不会直接写入，用户确认后才生效。不能用来标记完成。',
    parameters: {
      type: 'object',
      properties: {
        task_id: str, title: str,
        date: { type: ['string', 'null'], description: 'YYYY-MM-DD；null 表示放回以后清单' },
        est_minutes: { type: 'integer' },
        goal_id: { type: ['string', 'null'], description: '目标编号；null 表示取消关联' },
      },
      required: ['task_id'],
    },
    build(a, ctx) {
      const t = ctx.core.task(a.task_id);
      const payload = { taskId: a.task_id };
      const changes = [];
      if (a.title !== undefined) { payload.title = a.title; changes.push({ field: '标题', from: t && t.title, to: a.title }); }
      if (a.date !== undefined) { payload.date = a.date; changes.push({ field: '日期', from: (t && t.date) || '以后清单', to: a.date || '以后清单' }); }
      if (a.est_minutes !== undefined) { payload.est = a.est_minutes; changes.push({ field: '预计分钟', from: t && t.est, to: a.est_minutes }); }
      if (a.goal_id !== undefined) {
        payload.goalId = a.goal_id;
        changes.push({ field: '目标', from: goalTitle(ctx.core.S, t && t.goalId) || '无', to: goalTitle(ctx.core.S, a.goal_id) || '无' });
      }
      return {
        title: `修改任务「${String((t && t.title) || a.task_id).slice(0, 40)}」`,
        command: { type: 'task.update', payload },
        preview: { kind: 'taskUpdate', task: t ? t.title : a.task_id, changes },
        empty: !changes.length,
      };
    },
  },
];

function goalTitle(S, id) { const g = id ? plan.goalById(S, id) : null; return g ? g.title : null; }

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool list in the OpenAI `tools` request format. */
function definitions() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function describe(name) { const t = byName.get(name); return t ? { name: t.name, kind: t.kind, label: t.label } : { name, kind: 'unknown', label: name }; }

/**
 * Execute one tool call from the model.
 * @returns {{kind:'result', content:string} | {kind:'error', content:string} |
 *           {kind:'proposal', draft:{tool:string,title:string,command:object,preview:object}}}
 */
function call(name, rawArgs, ctx) {
  const t = byName.get(name);
  if (!t) return { kind: 'error', content: JSON.stringify({ error: `没有名为 ${name} 的工具` }) };
  let args;
  try { args = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { return { kind: 'error', content: JSON.stringify({ error: '工具参数不是有效的 JSON' }) }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { kind: 'error', content: JSON.stringify({ error: '工具参数必须是一个对象' }) };
  try {
    if (t.kind === 'read') {
      let out = JSON.stringify(t.run(args, ctx));
      if (out.length > 16000) out = out.slice(0, 16000) + '…（内容过长，已截断；请用更小的范围再查）';
      return { kind: 'result', content: out };
    }
    const draft = t.build(args, ctx);
    if (draft.empty) return { kind: 'error', content: JSON.stringify({ error: '没有任何要修改的内容' }) };
    const dry = ctx.core.check(draft.command);
    if (!dry.ok) return { kind: 'error', content: JSON.stringify({ error: '这份提议无法执行：' + dry.error + '。请修正后重新提议。' }) };
    return { kind: 'proposal', draft: { tool: t.name, title: draft.title, command: draft.command, preview: draft.preview } };
  } catch (e) {
    return { kind: 'error', content: JSON.stringify({ error: String(e && e.message || e) }) };
  }
}

module.exports = { TOOLS, definitions, describe, call, overview, trimTree };
