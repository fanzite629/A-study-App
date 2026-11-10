import { useEffect, useState } from 'react';
import { api, type ProbeResult, type Profile, type ProfileList } from '../api';
import { useApp } from '../store';
import { Badge, Confirm, Icon } from '../components/ui';

interface Form { id?: string; name: string; baseUrl: string; model: string; apiKey: string; }
const BLANK: Form = { name: '', baseUrl: '', model: '', apiKey: '' };

function toolsLabel(p: Profile) {
  if (p.tools === true) return <Badge tone="ok">支持工具调用</Badge>;
  if (p.tools === false) return <Badge tone="warn">仅聊天</Badge>;
  return <Badge tone="muted">未测试</Badge>;
}

export function Settings() {
  const { app, S, run, toast } = useApp();
  const [list, setList] = useState<ProfileList | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const reload = () => api.ai.profiles().then(setList);
  useEffect(() => { void reload(); }, []);

  const test = async (id: string) => {
    setTesting(id);
    const r = await api.ai.testProfile(id);
    setTesting(null);
    setResults((m) => ({ ...m, [id]: r }));
    void reload();
  };

  const save = async () => {
    if (!form) return;
    const r = await api.ai.saveProfile({
      id: form.id, name: form.name, baseUrl: form.baseUrl, model: form.model,
      ...(form.apiKey || !form.id ? { apiKey: form.apiKey } : {}),
    });
    if (!r.ok) { toast(r.error || '保存失败'); return; }
    setForm(null);
    await reload();
    if (r.profile && r.profile.hasKey) void test(r.profile.id); // check the connection straight away
  };

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <div className="page">
      <header className="page-head"><div><h1>设置</h1><p className="muted">T计划 {app.version}</p></div></header>

      <section className="card">
        <div className="card-head">
          <h3>模型接入</h3>
          {!form && <button className="btn sm" onClick={() => setForm({ ...BLANK })} data-testid="add-profile"><Icon name="plus" size={14} /> 添加配置</button>}
        </div>
        <p className="muted pad">
          支持任何 OpenAI 兼容格式的接口：填接口地址、密钥和模型名即可。密钥用系统加密后只保存在这台电脑上，界面读不回来；请求直接从本机发往你填写的地址。
        </p>
        {list && !list.encryption && <p className="err pad">当前系统的加密存储不可用，无法保存密钥。</p>}

        {list?.profiles.map((p) => {
          const r = results[p.id];
          return (
            <div key={p.id} className={`profile${list.activeId === p.id ? ' active' : ''}`} data-profile={p.name}>
              <div className="profile-main">
                <div className="profile-name">
                  <b>{p.name}</b>{list.activeId === p.id && <Badge tone="ok">当前使用</Badge>}{toolsLabel(p)}
                </div>
                <div className="muted small">{p.baseUrl} · {p.model} · 密钥 {p.hasKey ? p.keyHint : '未保存'}</div>
                {testing === p.id && <div className="muted small">正在测试连接…</div>}
                {r && testing !== p.id && (r.ok
                  ? <div className="ok small" data-testid="probe-ok">连接成功{r.reply ? `，模型回复：“${r.reply}”` : ''}。{r.tools ? 'Agent 功能可用。' : `工具调用不可用${r.toolsNote ? `（${r.toolsNote}）` : ''}，只能纯聊天。`}</div>
                  : <div className="err small" data-testid="probe-fail">连接失败：{r.error}</div>)}
                {!r && p.tools === false && p.toolsNote && <div className="muted small">工具调用不可用：{p.toolsNote}</div>}
              </div>
              {asking === p.id ? (
                <Confirm text="删除这组配置？" yes="删除" onYes={async () => { await api.ai.removeProfile(p.id); setAsking(null); void reload(); }} onNo={() => setAsking(null)} />
              ) : (
                <div className="row">
                  {list.activeId !== p.id && <button className="btn sm" onClick={async () => { await api.ai.setActive(p.id); void reload(); }}>使用</button>}
                  <button className="btn sm" disabled={!p.hasKey || testing === p.id} onClick={() => test(p.id)}>测试连接</button>
                  <button className="btn sm ghost" onClick={() => setForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '' })}>修改</button>
                  <button className="btn sm ghost" onClick={() => setAsking(p.id)}>删除</button>
                </div>
              )}
            </div>
          );
        })}
        {list && !list.profiles.length && !form && <p className="muted pad">还没有配置。添加一组之后就可以在“聊天”里使用了。</p>}

        {form && (
          <form className="profile-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="field"><span>名称</span>
              <input className="input" value={form.name} maxLength={40} placeholder="自己认得出就行，例如 DeepSeek" onChange={set('name')} name="name" /></label>
            <label className="field"><span>接口地址（Base URL）</span>
              <input className="input" value={form.baseUrl} placeholder="例如 https://api.deepseek.com" onChange={set('baseUrl')} name="baseUrl" required /></label>
            <label className="field"><span>模型名</span>
              <input className="input" value={form.model} maxLength={120} placeholder="服务商文档里的模型名" onChange={set('model')} name="model" required /></label>
            <label className="field"><span>API 密钥{form.id ? '（留空表示不修改）' : ''}</span>
              <input className="input" type="password" autoComplete="off" value={form.apiKey} placeholder="sk-…" onChange={set('apiKey')} name="apiKey" /></label>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setForm(null)}>取消</button>
              <button type="submit" className="btn primary">保存并测试</button>
            </div>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>桌宠与提醒</h3></div>
        <div className="setting">
          <div><b>显示桌宠</b><p className="muted small">隐藏后计时照常进行。</p></div>
          <button className="btn sm" onClick={() => api.action(app.pet.visible ? 'hide-pet' : 'show-pet')}>{app.pet.visible ? '隐藏' : '显示'}</button>
        </div>
        <div className="setting">
          <div><b>安静模式</b><p className="muted small">不主动提醒，时间到只做轻提示。</p></div>
          <button className="btn sm" onClick={() => api.action('set-mode', { key: 'quiet', value: !app.pet.quiet })}>{app.pet.quiet ? '关闭' : '开启'}</button>
        </div>
        <div className="setting">
          <div><b>晚间回看提醒</b><p className="muted small">每天一次，提醒看一眼当天的记录。</p></div>
          <div className="row">
            <input className="input narrow" type="time" value={S.settings.reviewTime || '21:00'} onChange={(e) => run('settings.update', { reviewTime: e.target.value })} />
            <button className="btn sm" onClick={() => run('settings.update', { eveningReview: !S.settings.eveningReview })}>{S.settings.eveningReview ? '关闭' : '开启'}</button>
          </div>
        </div>
        <div className="setting">
          <div><b>找回桌宠</b><p className="muted small">把桌宠移回主屏幕右下角。</p></div>
          <button className="btn sm" onClick={() => api.action('find-pet')}>找回</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>数据</h3></div>
        <p className="muted pad">任务、计划、记录和对话都保存在这台电脑上：<code>{app.dataDir}</code></p>
        <div className="row pad">
          <button className="btn sm" onClick={async () => { const r = await api.exportData(); if (r.ok) toast('已导出备份'); else if (r.error) toast(r.error); }}>导出备份</button>
          <button className="btn sm" onClick={async () => { const r = await api.importData(); if (r.ok) toast('已导入'); else if (r.error) toast(r.error); }}>从备份导入…</button>
          <button className="btn sm ghost" onClick={() => api.action('open-data-dir')}>打开数据文件夹</button>
          <button className="btn sm ghost" onClick={() => api.action('open-console')}>开发控制台</button>
        </div>
      </section>
    </div>
  );
}
