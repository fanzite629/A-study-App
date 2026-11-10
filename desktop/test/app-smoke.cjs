'use strict';
// End-to-end check of the main window in a real Electron process:
// timer -> record, goals, model profile, agent proposal -> confirm, week plan,
// review + AI draft. The "model" is a local OpenAI-compatible stub, so no
// network or real key is involved. Uses a throwaway data folder.
//
//   npm run test:app            (Linux CI: xvfb-run -a npm run test:app)

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(out, 'app-profile-'));
const KEY = 'sk-test-do-not-leak-9f3a7c21';
const checks = [];
const errors = [];
const requests = [];

// ------------------------------------------------------------ model stub

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i < chunks.length) { res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: chunks[i++], finish_reason: null }] }) + '\n\n'); setTimeout(tick, 15); }
    else { res.write('data: [DONE]\n\n'); res.end(); }
  };
  tick();
};
const say = (res, text) => sse(res, [{ role: 'assistant', content: '' }, ...text.match(/[\s\S]{1,6}/g).map((c) => ({ content: c }))]);
const callTool = (res, name, args) => {
  const s = JSON.stringify(args);
  sse(res, [
    { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name, arguments: '' } }] },
    ...s.match(/[\s\S]{1,40}/g).map((c) => ({ tool_calls: [{ index: 0, function: { arguments: c } }] })),
  ]);
};

const TREE = {
  title: '通过英语六级', note: '12 月考试',
  children: [
    { title: '听力', tasks: [{ title: '精听一篇真题短文', est_minutes: 20 }] },
    { title: '阅读', tasks: [{ title: '做一篇仔细阅读并对答案', est_minutes: 25 }], children: [{ title: '长难句', tasks: [{ title: '拆 3 个长难句', est_minutes: 15 }] }] },
  ],
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    requests.push({ url: req.url, auth: req.headers.authorization, body: j });
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid API key"}}'); return; }
    const last = j.messages[j.messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : '';
    if (text.includes('连通测试')) return say(res, '可以');
    if (text.includes('ping 工具')) return callTool(res, 'ping', {});
    if (text.includes('复盘草稿')) return say(res, '**做了什么**\n\n- 记录了一段专注。\n\n**下一步**\n\n1. 明天先做五分钟。');
    if (last.role === 'tool' && last.content.includes('pending')) return say(res, '我拟了一棵目标树，放在上面的卡片里。你确认后才会写入。');
    if (last.role === 'tool') return callTool(res, 'propose_goal_tree', { tree: TREE });
    if (text.includes('六级') && j.tools) return callTool(res, 'get_overview', {});
    return say(res, '好的。');
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name) => { checks.push(name); console.log('  ✓ ' + name); };

(async () => {
  let app;
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const linux = process.platform === 'linux';
    app = await electron.launch({
      args: [root, '--main', '--test-data=' + data, ...(linux ? ['--no-sandbox'] : [])],
      env, timeout: 120000,
    });
    let win;
    for (let i = 0; i < 100 && !win; i++) {
      for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'T计划' && await w.evaluate(() => !!(window.tplan && window.tplan.chat)).catch(() => false)) win = w;
      if (!win) await sleep(200);
    }
    assert.ok(win, '主窗口没有打开');
    win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await win.setViewportSize({ width: 1180, height: 800 }).catch(() => {});
    const state = () => win.evaluate(() => window.tplan.get().then((s) => s.state));
    const nav = (p) => win.locator(`[data-nav=${p}]`).click();
    const shot = (n) => win.screenshot({ path: path.join(out, n) });

    // ---- today: task -> main task -> timer -> record
    await win.waitForSelector('h1:has-text("今天")');
    await win.getByPlaceholder('添加今天的任务，回车保存').fill('高数 · 极限第 13 题');
    await win.keyboard.press('Enter');
    const row = win.locator('[data-task="高数 · 极限第 13 题"]');
    await row.waitFor();
    await row.hover();
    await row.getByLabel('设为今天的主任务').click();
    await win.getByRole('heading', { name: '高数 · 极限第 13 题' }).waitFor();
    await win.getByRole('button', { name: '先做 5 分钟' }).click();
    await win.waitForFunction(() => /^04:5\d$/.test(document.querySelector('[data-testid=clock]')?.textContent || ''));
    let S = await state();
    assert.equal(S.active.phase, 'running');
    assert.equal(S.schema, 2);
    ok('今天页：添加任务、设为主任务、开始 5 分钟倒计时');
    await shot('app-01-today-timer.png');

    await win.getByRole('button', { name: '暂停' }).click();
    await win.getByRole('button', { name: '继续' }).waitFor();
    await win.getByRole('button', { name: '结束并记录' }).click();
    await win.locator('.session').first().waitFor();
    S = await state();
    assert.equal(S.active, null);
    assert.equal(S.sessions.length, 1);
    assert.ok(S.sessions[0].durationMs > 0);
    await win.getByRole('button', { name: '还要继续' }).click();
    await win.getByPlaceholder('下次从哪里继续？（可以留空）').fill('从夹逼定理那一步开始');
    await win.getByRole('button', { name: '保存' }).click();
    await win.waitForFunction(() => window.tplan.get().then((s) => s.state.tasks[0].next === '从夹逼定理那一步开始'));
    ok('计时结束自动生成一条记录，并保存下一步');

    // ---- the pet shares the same core
    const pet = app.windows().find((w) => w !== win);
    if (pet) {
      const mainTitle = await pet.evaluate(() => window.__petInfo ? true : false).catch(() => false);
      assert.equal(mainTitle, true);
      ok('桌宠窗口与主窗口同时运行');
    }

    // ---- goals: manual
    await nav('goals');
    await win.getByRole('button', { name: '新目标' }).click();
    await win.getByPlaceholder('目标名称，回车保存').fill('考研数学');
    await win.keyboard.press('Enter');
    await win.locator('[data-goal="考研数学"]').waitFor();
    ok('目标页：手动新建目标');

    // ---- settings: profile, encrypted key, probe
    await nav('settings');
    await win.locator('[data-testid=add-profile]').click();
    await win.locator('input[name=name]').fill('本地测试模型');
    await win.locator('input[name=baseUrl]').fill(base + '/chat/completions');
    await win.locator('input[name=model]').fill('stub-model');
    await win.locator('input[name=apiKey]').fill(KEY);
    await win.getByRole('button', { name: '保存并测试' }).click();
    await win.locator('[data-testid=probe-ok]').waitFor({ timeout: 20000 });
    assert.match(await win.locator('[data-testid=probe-ok]').textContent(), /Agent 功能可用/);
    const stored = fs.readFileSync(path.join(data, 'ai-profiles.json'), 'utf8');
    assert.equal(stored.includes(KEY), false, '密钥以明文出现在配置文件里');
    assert.equal(JSON.parse(stored).profiles[0].baseUrl, base);
    const listed = await win.evaluate(() => window.tplan.ai.profiles());
    assert.equal(JSON.stringify(listed).includes(KEY), false, '密钥被传回了界面');
    assert.equal(listed.profiles[0].tools, true);
    ok('设置页：保存配置、密钥加密落盘且不回传界面、连通与工具调用检测');
    await shot('app-02-settings.png');

    // ---- chat: agent reads, proposes, user confirms
    await nav('chat');
    await win.locator('[data-testid=chat-input]').fill('我想通过六级，帮我拆成目标树');
    await win.locator('[data-testid=chat-send]').click();
    const card = win.locator('[data-testid=proposal]');
    await card.waitFor({ timeout: 20000 });
    await win.getByText('我拟了一棵目标树').waitFor({ timeout: 20000 });
    await win.locator('[data-testid=chat-send]').waitFor();
    S = await state();
    assert.equal(S.goals.length, 1, '提议在确认前就写入了');
    assert.match(await card.textContent(), /等你确认[\s\S]*通过英语六级[\s\S]*长难句[\s\S]*确认写入/);
    ok('聊天页：Agent 先读取数据，再给出目标树提议；确认前数据未变');
    await shot('app-03-chat-proposal.png');

    await card.getByRole('button', { name: '确认写入' }).click();
    await card.getByText('已写入').waitFor();
    S = await state();
    assert.equal(S.goals.length, 5);
    assert.equal(S.goals.filter((g) => g.origin === 'agent').length, 4);
    assert.equal(S.tasks.filter((t) => t.origin === 'agent').length, 3);
    assert.equal(S.sessions.length, 1);
    const turn = requests.filter((r) => r.body.tools && r.body.messages.some((m) => m.role === 'user' && String(m.content).includes('六级')));
    assert.equal(turn.length, 3);
    assert.match(turn[0].body.messages[0].content, /学习计划助手/);
    ok('确认后一次性写入 4 个目标和 3 个任务，均标记为 AI 建议；计时记录未被改动');

    await nav('goals');
    await win.locator('[data-goal="通过英语六级"]').waitFor();
    await win.getByText('精听一篇真题短文').waitFor();
    await shot('app-04-goals.png');

    // ---- week
    await nav('week');
    const focus = win.locator('[data-testid=week-focus]');
    await focus.fill('把极限这一章做完');
    await focus.blur();
    await win.waitForFunction(() => window.tplan.get().then((s) => Object.values(s.state.weeks)[0]?.focus === '把极限这一章做完'));
    await win.locator('[data-col=undecided] .wadd').click();
    await win.locator('[data-col=undecided] .quickadd').fill('整理错题');
    await win.keyboard.press('Enter');
    await win.locator('[data-col=undecided] [data-task="整理错题"]').waitFor();
    ok('周计划页：保存本周重点，添加“本周未定”的任务');
    await shot('app-05-week.png');

    // ---- review
    await nav('review');
    await win.locator('[data-testid=facts] .fact').first().waitFor();
    assert.match(await win.locator('[data-testid=facts]').textContent(), /高数 · 极限第 13 题/);
    await win.locator('[data-testid=reflection]').fill('开头比想象的容易。');
    await win.getByRole('button', { name: '保存', exact: true }).click();
    await win.locator('[data-testid=draft-btn]').click();
    await win.locator('.ai-draft .md').waitFor({ timeout: 20000 });
    S = await state();
    const rev = S.reviews.find((r) => r.scope === 'day');
    assert.equal(rev.reflection, '开头比想象的容易。');
    assert.match(rev.aiDraft.text, /做了什么/);
    assert.equal(rev.aiDraft.model, 'stub-model');
    assert.match(requests[requests.length - 1].body.messages[1].content, /开头比想象的容易/);
    ok('复盘页：事实来自记录，反思与 AI 草稿分开保存');
    await shot('app-06-review.png');

    // ---- persistence
    assert.equal(fs.readdirSync(path.join(data, 'chats')).filter((f) => f.endsWith('.jsonl')).length, 1);
    await app.close(); app = null;
    const disk = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.equal(disk.goals.length, 5);
    assert.equal(disk.schema, 2);
    assert.equal(JSON.stringify(disk).includes('我想通过六级'), false, '聊天内容混进了 state.json');
    ok('退出后数据落盘；聊天记录单独保存，不在 state.json 里');

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'app-report.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), platform: process.platform, checks, errors }, null, 2));
    console.log(JSON.stringify({ ok: true, checks: checks.length, errors }, null, 2));
  } catch (e) {
    console.error(e);
    console.error('page errors:', errors);
    fs.writeFileSync(path.join(out, 'app-report.json'), JSON.stringify({ ok: false, checks, errors, error: String(e && e.stack || e) }, null, 2));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    server.close();
  }
})();
