'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Core } = require('../src/main/core');
const { streamChat, probe, normalizeBaseUrl, ProviderError } = require('../src/main/ai/provider');
const { Profiles } = require('../src/main/ai/profiles');
const { Chats } = require('../src/main/ai/chats');
const { ChatService, toApiMessages } = require('../src/main/ai/service');
const tools = require('../src/main/ai/tools');
const { readJson, writeJsonAtomic } = require('../src/main/persist');

// ------------------------------------------------------------- fake server

const sse = (chunks, { done = true } = {}) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : '');
const delta = (d, finish) => ({ choices: [{ index: 0, delta: d, finish_reason: finish || null }] });

/** A Response whose body arrives in small pieces, like a real stream. */
function streamResponse(text, { pieces = 7, status = 200 } = {}) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.max(1, Math.ceil(bytes.length / pieces));
  const body = new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** fetch stub driven by a queue of replies; records every request body. */
function fakeFetch(replies) {
  const requests = [];
  const fn = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra request');
    return typeof next === 'function' ? next(init) : next;
  };
  fn.requests = requests;
  return fn;
}

const textReply = (s) => streamResponse(sse([delta({ role: 'assistant', content: s.slice(0, 2) }), delta({ content: s.slice(2) }, 'stop')]));
const toolReply = (name, args, id = 'call_1') => streamResponse(sse([
  delta({ role: 'assistant', content: '', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(0, 5) } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(5) } }] }, 'tool_calls'),
]));

// ---------------------------------------------------------------- provider

test('base URL is normalized from the common ways people paste it', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://x.test/v1/chat/completions'), 'https://x.test/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.throws(() => normalizeBaseUrl(''), ProviderError);
});

test('streamChat assembles text split across network chunks and sends the key as a Bearer token', async () => {
  const fetch = fakeFetch([streamResponse(sse([delta({ role: 'assistant', content: '你' }), delta({ content: '好，' }), delta({ content: '世界' }, 'stop')]), { pieces: 23 })]);
  const seen = [];
  const r = await streamChat({ fetch, baseUrl: 'https://x.test/v1/', apiKey: 'sk-abc', model: 'm', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => seen.push(d.content) });
  assert.equal(r.content, '你好，世界');
  assert.equal(seen.join(''), '你好，世界');
  assert.equal(r.finishReason, 'stop');
  assert.equal(fetch.requests[0].url, 'https://x.test/v1/chat/completions');
  assert.equal(fetch.requests[0].headers.Authorization, 'Bearer sk-abc');
  assert.equal(fetch.requests[0].body.stream, true);
  assert.equal(fetch.requests[0].body.tools, undefined);
});

test('streamChat assembles tool calls from argument fragments, and keeps reasoning apart', async () => {
  const fetch = fakeFetch([streamResponse(sse([
    delta({ role: 'assistant', reasoning_content: '先想想' }),
    delta({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'list_tasks', arguments: '{"sco' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'pe":"today"}' } }, { index: 1, id: 'b', type: 'function', function: { name: 'get_overview', arguments: '' } }] }, 'tool_calls'),
  ]))]);
  const r = await streamChat({ fetch, baseUrl: 'https://x.test', apiKey: 'k', model: 'm', messages: [], tools: tools.definitions() });
  assert.equal(r.reasoning, '先想想');
  assert.equal(r.content, '');
  assert.deepEqual(r.toolCalls, [{ id: 'a', name: 'list_tasks', arguments: '{"scope":"today"}' }, { id: 'b', name: 'get_overview', arguments: '{}' }]);
  assert.equal(fetch.requests[0].body.tools.length, tools.TOOLS.length);
});

test('streamChat also accepts a plain JSON answer and a stream without [DONE]', async () => {
  const json = new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整段返回' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await streamChat({ fetch: fakeFetch([json]), baseUrl: 'https://x.test', apiKey: 'k', model: 'm', messages: [] })).content, '整段返回');
  const noDone = streamResponse(sse([delta({ content: '没有结束标记' })], { done: false }).trimEnd());
  assert.equal((await streamChat({ fetch: fakeFetch([noDone]), baseUrl: 'https://x.test', apiKey: 'k', model: 'm', messages: [] })).content, '没有结束标记');
});

test('HTTP errors become readable messages with a kind', async () => {
  const mk = (status, body) => fakeFetch([new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })]);
  const call = (fetch) => streamChat({ fetch, baseUrl: 'https://x.test', apiKey: 'k', model: 'm', messages: [] });
  await assert.rejects(call(mk(401, { error: { message: 'Invalid API key' } })), (e) => e.kind === 'auth' && /密钥/.test(e.message) && /Invalid API key/.test(e.message));
  await assert.rejects(call(mk(404, { error: { message: 'model not found' } })), (e) => e.kind === 'notfound');
  await assert.rejects(call(mk(429, {})), (e) => e.kind === 'rate');
  await assert.rejects(call(mk(503, {})), (e) => e.kind === 'server');
  await assert.rejects(call(async () => { throw new Error('ECONNREFUSED'); }), (e) => e.kind === 'network');
});

test('probe reports whether the model can chat and whether it calls tools', async () => {
  const base = { baseUrl: 'https://x.test', apiKey: 'k', model: 'm' };
  assert.deepEqual(await probe({ ...base, fetch: fakeFetch([textReply('可以'), toolReply('ping', {})]) }), { ok: true, tools: true, reply: '可以' });
  const noCall = await probe({ ...base, fetch: fakeFetch([textReply('可以'), textReply('我不会用工具')]) });
  assert.equal(noCall.ok, true); assert.equal(noCall.tools, false); assert.match(noCall.toolsNote, /没有按要求/);
  const refused = await probe({ ...base, fetch: fakeFetch([textReply('可以'), new Response('{"error":{"message":"tools unsupported"}}', { status: 400 })]) });
  assert.equal(refused.ok, true); assert.equal(refused.tools, false); assert.match(refused.toolsNote, /tools unsupported/);
  const dead = await probe({ ...base, fetch: fakeFetch([new Response('{}', { status: 401 })]) });
  assert.equal(dead.ok, false); assert.equal(dead.kind, 'auth');
});

// ---------------------------------------------------------------- profiles

const codec = { available: () => true, encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
function memProfiles(c = codec) { let disk = null; const p = new Profiles({ read: () => disk, write: (d) => { disk = JSON.parse(JSON.stringify(d)); }, codec: c }); return { p, get disk() { return disk; } }; }

test('profiles: the key is stored encrypted and never returned by list()', () => {
  const m = memProfiles();
  const r = m.p.save({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKey: 'sk-secret-123456' });
  assert.equal(r.ok, true);
  const raw = JSON.stringify(m.disk);
  assert.equal(raw.includes('sk-secret-123456'), false);
  const listed = m.p.list();
  assert.equal(JSON.stringify(listed).includes('sk-secret'), false);
  assert.equal(listed.profiles[0].keyHint, '…3456');
  assert.equal(listed.profiles[0].hasKey, true);
  assert.equal(listed.activeId, r.profile.id);
  assert.equal(m.p.get().apiKey, 'sk-secret-123456');
  assert.equal(m.p.get().baseUrl, 'https://api.deepseek.com');
});

test('profiles: editing without a key keeps it; changing the model clears the old test result', () => {
  const m = memProfiles();
  const id = m.p.save({ name: 'A', baseUrl: 'https://x.test', model: 'm1', apiKey: 'sk-aaaaaaaaaa' }).profile.id;
  m.p.recordTest(id, { ok: true, tools: true });
  assert.equal(m.p.get(id).tools, true);
  m.p.save({ id, name: 'A2', baseUrl: 'https://x.test', model: 'm1' });
  assert.equal(m.p.get(id).apiKey, 'sk-aaaaaaaaaa');
  assert.equal(m.p.get(id).tools, true);
  m.p.save({ id, name: 'A2', baseUrl: 'https://x.test', model: 'm2' });
  assert.equal(m.p.get(id).tools, false);
  assert.equal(m.p.list().profiles[0].tools, null);
  m.p.remove(id);
  assert.equal(m.p.list().activeId, null);
});

test('profiles: refuses to save a key when encryption is unavailable', () => {
  const m = memProfiles({ ...codec, available: () => false });
  const r = m.p.save({ name: 'A', baseUrl: 'https://x.test', model: 'm', apiKey: 'sk-1' });
  assert.equal(r.ok, false);
  assert.equal(m.p.list().profiles.length, 0);
});

// ------------------------------------------------------------ chat service

function setup(replies, { toolsOn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tplan-chats-'));
  let now = new Date(2026, 10, 4, 9, 0, 0).getTime();
  let disk = null;
  const core = new Core({ now: () => now, setTimer: () => 0, clearTimer: () => {}, read: () => disk, write: (s) => { disk = JSON.parse(JSON.stringify(s)); } });
  core.load();
  const chats = new Chats({ dir, readJson, writeJson: writeJsonAtomic });
  const { p: profiles } = memProfiles();
  const id = profiles.save({ name: 'T', baseUrl: 'https://x.test/v1', model: 'test-model', apiKey: 'sk-test-000000' }).profile.id;
  profiles.recordTest(id, { ok: true, tools: toolsOn });
  const fetch = fakeFetch(replies);
  const events = [];
  const service = new ChatService({ core, chats, profiles, fetch, now: () => now, emit: (e) => events.push(e) });
  return { core, chats, profiles, fetch, events, service, dir, chat: chats.create() };
}

test('a plain question: one request, the answer is stored and streamed', async () => {
  const s = setup([textReply('先做五分钟就好。')]);
  const r = await s.service.send({ chatId: s.chat.id, text: '今天从哪开始？' });
  assert.equal(r.ok, true);
  const convo = s.chats.load(s.chat.id);
  assert.deepEqual(convo.messages.map((m) => [m.role, m.content]), [['user', '今天从哪开始？'], ['assistant', '先做五分钟就好。']]);
  assert.equal(convo.title, '今天从哪开始？');
  assert.equal(s.events.filter((e) => e.type === 'delta').map((e) => e.content).join(''), '先做五分钟就好。');
  assert.deepEqual(s.events.map((e) => e.type).filter((t) => t !== 'delta'), ['message', 'title', 'start', 'message', 'done']);
  const req = s.fetch.requests[0].body;
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /2026-11-04/);
  assert.equal(req.model, 'test-model');
});

test('a read tool runs immediately and its result goes back to the model', async () => {
  const s = setup([toolReply('list_tasks', { scope: 'open' }), textReply('你有一个未完成的任务。')]);
  s.core.dispatch({ type: 'task.add', payload: { title: '极限 20 题' } });
  await s.service.send({ chatId: s.chat.id, text: '我有哪些任务？' });
  assert.equal(s.fetch.requests.length, 2);
  const second = s.fetch.requests[1].body.messages;
  assert.deepEqual(second.slice(1).map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(second[2].tool_calls[0].function.name, 'list_tasks');
  assert.equal(second[3].tool_call_id, 'call_1');
  assert.match(second[3].content, /极限 20 题/);
  assert.equal(s.chats.load(s.chat.id).messages.at(-1).content, '你有一个未完成的任务。');
});

test('a write tool only creates a proposal; nothing changes until the user accepts', async () => {
  const tree = { title: '英语六级', children: [{ title: '听力', tasks: [{ title: '精听一篇', est_minutes: 20 }] }] };
  const s = setup([toolReply('propose_goal_tree', { tree }), textReply('我拟了一棵目标树，请你看看。'), textReply('好的，已经建好了。')]);
  await s.service.send({ chatId: s.chat.id, text: '帮我拆六级' });
  assert.equal(s.core.S.goals.length, 0);
  assert.equal(s.core.S.tasks.length, 0);
  let convo = s.chats.load(s.chat.id);
  const proposal = Object.values(convo.proposals)[0];
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.command.type, 'goal.applyDraft');
  assert.equal(proposal.command.payload.origin, 'agent');
  assert.equal(proposal.preview.kind, 'goalTree');
  assert.match(s.fetch.requests[1].body.messages.at(-1).content, /pending/);

  const d = s.service.decide({ chatId: s.chat.id, proposalId: proposal.id, accept: true });
  assert.equal(d.ok, true);
  assert.equal(s.core.S.goals.length, 2);
  assert.equal(s.core.S.tasks[0].est, 20);
  assert.ok(s.core.S.goals.every((g) => g.origin === 'agent'));
  assert.equal(s.service.decide({ chatId: s.chat.id, proposalId: proposal.id, accept: true }).ok, false); // applied once only
  assert.equal(s.core.S.goals.length, 2);

  // The next request shows the model the up-to-date status of that proposal.
  await s.service.send({ chatId: s.chat.id, text: '我点了确认' });
  const toolMsg = s.fetch.requests[2].body.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /accepted/);
});

test('rejecting a proposal changes nothing and is reported to the model', async () => {
  const s = setup([toolReply('propose_tasks', { tasks: [{ title: '背 30 个单词', date: '2026-11-05' }] }), textReply('提议好了。'), textReply('明白。')]);
  await s.service.send({ chatId: s.chat.id, text: '加个任务' });
  const proposal = Object.values(s.chats.load(s.chat.id).proposals)[0];
  assert.equal(s.service.decide({ chatId: s.chat.id, proposalId: proposal.id, accept: false }).proposal.status, 'rejected');
  assert.equal(s.core.S.tasks.length, 0);
  await s.service.send({ chatId: s.chat.id, text: '不要了' });
  assert.match(s.fetch.requests[2].body.messages.find((m) => m.role === 'tool').content, /rejected/);
});

test('an invalid proposal is returned to the model as an error, not shown to the user', async () => {
  const s = setup([toolReply('propose_week_plan', { week_start: '2026-11-04', add: [{ title: '越界', date: '2026-12-25' }] }), textReply('我改一下。')]);
  await s.service.send({ chatId: s.chat.id, text: '排一下本周' });
  const convo = s.chats.load(s.chat.id);
  assert.deepEqual(Object.keys(convo.proposals), []);
  assert.match(s.fetch.requests[1].body.messages.at(-1).content, /无法执行/);
  assert.equal(convo.messages.find((m) => m.role === 'tool').failed, true);
});

test('no agent tool can touch sessions or mark tasks done', () => {
  const names = tools.TOOLS.map((t) => t.name);
  const commands = new Set();
  const core = new Core({ read: () => null, write: () => {}, setTimer: () => 0, clearTimer: () => {} });
  core.load();
  const t = core.dispatch({ type: 'task.add', payload: { title: 'x' } }).taskId;
  const samples = {
    propose_tasks: { tasks: [{ title: 'a' }] }, propose_goal_tree: { tree: { title: 'g' } },
    propose_week_plan: { week_start: '2026-11-04' }, propose_task_update: { task_id: t, title: 'y' },
  };
  for (const tool of tools.TOOLS.filter((x) => x.kind === 'write')) {
    const r = tools.call(tool.name, JSON.stringify(samples[tool.name]), { core, now: Date.now() });
    assert.equal(r.kind, 'proposal', tool.name);
    commands.add(r.draft.command.type);
  }
  assert.deepEqual([...commands].sort(), ['goal.applyDraft', 'task.addMany', 'task.update', 'week.applyDraft']);
  assert.equal(names.some((n) => /session|timer|done/.test(n)), false);
  assert.equal(tools.call('propose_task_update', JSON.stringify({ task_id: t, done: true }), { core, now: Date.now() }).kind, 'error');
});

test('a profile without tool support sends no tools and gets a data digest instead', async () => {
  const s = setup([textReply('建议如下。')], { toolsOn: false });
  s.core.dispatch({ type: 'goal.add', payload: { title: '考研数学' } });
  await s.service.send({ chatId: s.chat.id, text: '帮我看看' });
  const req = s.fetch.requests[0].body;
  assert.equal(req.tools, undefined);
  assert.match(req.messages[0].content, /没有启用工具调用/);
  assert.match(req.messages[0].content, /考研数学/);
});

test('a failed request is stored as an error message and the chat stays usable', async () => {
  const s = setup([new Response('{"error":{"message":"bad key"}}', { status: 401 }), textReply('现在好了。')]);
  const r = await s.service.send({ chatId: s.chat.id, text: '你好' });
  assert.equal(r.ok, false);
  assert.match(s.chats.load(s.chat.id).messages.at(-1).error, /密钥/);
  assert.equal(s.service.isRunning(s.chat.id), false);
  assert.equal((await s.service.send({ chatId: s.chat.id, text: '再试一次' })).ok, true);
  const sent = s.fetch.requests[1].body.messages.slice(1);
  assert.deepEqual(sent.map((m) => m.role), ['user', 'user']); // the error bubble is not sent to the model
});

test('stop keeps the text that already arrived', async () => {
  let ctrl;
  const hanging = (init) => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        ctrl = c;
        c.enqueue(enc.encode('data: ' + JSON.stringify(delta({ content: '写到一半' })) + '\n\n'));
        init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const s = setup([hanging]);
  const pending = s.service.send({ chatId: s.chat.id, text: '写长一点' });
  while (!s.events.some((e) => e.type === 'delta')) await new Promise((r) => setTimeout(r, 5));
  s.service.stop(s.chat.id);
  const r = await pending;
  assert.equal(r.stopped, true);
  const last = s.chats.load(s.chat.id).messages.at(-1);
  assert.equal(last.content, '写到一半');
  assert.equal(last.stopped, true);
  assert.ok(ctrl);
});

test('toApiMessages repairs an interrupted tool call so the history stays valid', () => {
  const stored = [
    { role: 'tool', toolCallId: 'orphan', content: 'x' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_overview', arguments: '{}' }, { id: 'c2', name: 'list_tasks', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: '{"a":1}' },
    { role: 'user', content: 'again' },
  ];
  const out = toApiMessages(stored, {});
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(out[2].content, '{"a":1}');
  assert.match(out[3].content, /没有执行/);
});

test('review draft is written from facts into the AI field only', async () => {
  const s = setup([textReply('今天记录了 25 分钟。')]);
  const t = s.core.dispatch({ type: 'task.add', payload: { title: '极限' } }).taskId;
  s.core.dispatch({ type: 'review.save', payload: { scope: 'day', key: '2026-11-04', reflection: '我自己写的' } });
  const r = await s.service.draftReview({ scope: 'day', key: '2026-11-04' });
  assert.equal(r.ok, true);
  const rev = s.core.S.reviews[0];
  assert.equal(rev.reflection, '我自己写的');
  assert.equal(rev.aiDraft.text, '今天记录了 25 分钟。');
  assert.equal(rev.aiDraft.model, 'test-model');
  const prompt = s.fetch.requests[0].body.messages[1].content;
  assert.match(prompt, /planned_without_timer_record/);
  assert.match(prompt, /我自己写的/);
  assert.equal(s.core.S.sessions.length, 0);
  assert.equal(s.core.task(t).done, false);
});

test('conversations survive a reload and a torn last line', () => {
  const s = setup([]);
  s.chats.addMessage(s.chat.id, { role: 'user', content: 'a' });
  fs.appendFileSync(path.join(s.dir, s.chat.id + '.jsonl'), '{"k":"msg","msg":{"role":"assi');
  const again = new Chats({ dir: s.dir, readJson, writeJson: writeJsonAtomic });
  assert.equal(again.list().length, 1);
  assert.deepEqual(again.load(s.chat.id).messages.map((m) => m.content), ['a']);
  assert.throws(() => again.file('../evil'), /会话编号/);
  assert.equal(again.remove(s.chat.id), true);
  assert.equal(fs.existsSync(path.join(s.dir, s.chat.id + '.jsonl')), false);
});
