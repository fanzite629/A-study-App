'use strict';
// Client for any "OpenAI-compatible" chat endpoint: POST {baseUrl}/chat/completions.
// No Electron imports: `fetch` is injected (the app passes Electron's net.fetch
// so the system proxy is respected; tests pass a fake).
//
// Compatibility notes, kept deliberately conservative:
//   * Only fields every compatible server accepts are sent (model, messages,
//     stream, tools). No vendor-specific options.
//   * Some servers stream an extra `reasoning_content` delta. It is surfaced
//     for display but never sent back in later requests.
//   * "Compatible" does not guarantee tool calling. probeTools() checks it.

class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'error', detail = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;      // 'auth' | 'notfound' | 'rate' | 'bad' | 'server' | 'network' | 'aborted' | 'error'
    this.detail = detail;  // raw message from the server, if any
  }
}

/** Accepts a base URL with or without a trailing slash or the full endpoint. */
function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new ProviderError('请填写接口地址（Base URL）', { kind: 'bad' });
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new ProviderError('接口地址不是有效的网址', { kind: 'bad' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ProviderError('接口地址必须以 http 或 https 开头', { kind: 'bad' });
  let path = parsed.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return parsed.origin + path;
}

function explain(status, detail) {
  const tail = detail ? `（${String(detail).slice(0, 300)}）` : '';
  if (status === 401 || status === 403) return ['auth', '密钥无效或没有权限' + tail];
  if (status === 404) return ['notfound', '接口地址或模型名不正确' + tail];
  if (status === 402) return ['rate', '账户余额不足' + tail];
  if (status === 429) return ['rate', '请求太频繁或额度已用完' + tail];
  if (status === 400 || status === 422) return ['bad', '服务器拒绝了这次请求' + tail];
  if (status >= 500) return ['server', `模型服务暂时出错（${status}）` + tail];
  return ['error', `请求失败（${status}）` + tail];
}

async function readError(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let detail = body.slice(0, 500);
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error.code)) || j.message || j.detail || detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not JSON */ }
  const [kind, message] = explain(res.status, detail);
  return new ProviderError(message, { status: res.status, kind, detail });
}

function mergeToolCallDelta(calls, d) {
  const i = Number.isInteger(d.index) ? d.index : calls.length ? calls.length - 1 : 0;
  const c = calls[i] || (calls[i] = { id: '', name: '', arguments: '' });
  if (d.id) c.id = d.id;
  if (d.function && d.function.name) c.name += d.function.name;
  if (d.function && typeof d.function.arguments === 'string') c.arguments += d.function.arguments;
}

function applyChunk(acc, j, onDelta) {
  if (j.error) throw new ProviderError(explain(0, j.error.message || JSON.stringify(j.error))[1], { kind: 'server', detail: j.error.message });
  if (j.usage) acc.usage = j.usage;
  const ch = j.choices && j.choices[0];
  if (!ch) return;
  const d = ch.delta || ch.message || {};
  if (typeof d.content === 'string' && d.content) { acc.content += d.content; if (onDelta) onDelta({ content: d.content }); }
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
    acc.reasoning += d.reasoning_content;
    if (onDelta) onDelta({ reasoning: d.reasoning_content });
  }
  for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) mergeToolCallDelta(acc.toolCalls, t);
  if (ch.finish_reason) acc.finishReason = ch.finish_reason;
}

/**
 * One model call, streamed. Resolves with the assembled message:
 *   { content, reasoning, toolCalls: [{id,name,arguments}], finishReason, usage }
 *
 * @param {object} o
 * @param {Function} o.fetch
 * @param {string} o.baseUrl   normalized or raw base URL
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {object[]} o.messages
 * @param {object[]} [o.tools]
 * @param {AbortSignal} [o.signal]
 * @param {(d: {content?: string, reasoning?: string}) => void} [o.onDelta]
 */
async function streamChat(o) {
  const url = normalizeBaseUrl(o.baseUrl) + '/chat/completions';
  if (!o.model) throw new ProviderError('请填写模型名', { kind: 'bad' });
  const body = { model: o.model, messages: o.messages, stream: true };
  if (o.tools && o.tools.length) body.tools = o.tools;
  if (o.maxTokens) body.max_tokens = o.maxTokens;

  let res;
  try {
    res = await o.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(o.apiKey ? { Authorization: 'Bearer ' + o.apiKey } : {}) },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (e) {
    if (o.signal && o.signal.aborted) throw new ProviderError('已停止', { kind: 'aborted' });
    throw new ProviderError('连接不上模型服务，请检查网络和接口地址', { kind: 'network', detail: String(e && e.message || e) });
  }
  if (!res.ok) throw await readError(res);

  const acc = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
  const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');

  // A few servers ignore `stream` and answer with one JSON document.
  if (type.includes('application/json')) {
    let j;
    try { j = await res.json(); } catch { throw new ProviderError('模型服务返回了无法解析的内容', { kind: 'server' }); }
    applyChunk(acc, j, o.onDelta);
    return finish(acc);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;
  const line = (raw) => {
    const s = raw.replace(/\r$/, '');
    if (!s.startsWith('data:')) return;       // comments, event: lines, blanks
    const data = s.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { ended = true; return; }
    let j;
    try { j = JSON.parse(data); } catch { return; } // keep-alive noise
    applyChunk(acc, j, o.onDelta);
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0 && !ended) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    if (!ended && buf.trim()) line(buf);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (o.signal && o.signal.aborted) {
      const err = new ProviderError('已停止', { kind: 'aborted' });
      err.partial = finish(acc);
      throw err;
    }
    throw new ProviderError('回答传输中断，请重试', { kind: 'network', detail: String(e && e.message || e) });
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
  }
  return finish(acc);
}

function finish(acc) {
  acc.toolCalls = acc.toolCalls.filter((c) => c && c.name).map((c, i) => ({ id: c.id || 'call_' + i, name: c.name, arguments: c.arguments || '{}' }));
  return acc;
}

/**
 * Check a profile: can it chat, and does it call tools?
 * Returns { ok, tools: true | false, reply?, error?, toolsNote? }.
 */
async function probe({ fetch, baseUrl, apiKey, model, signal }) {
  let reply;
  try {
    const r = await streamChat({ fetch, baseUrl, apiKey, model, signal, maxTokens: 64, messages: [{ role: 'user', content: '连通测试：请只回复“可以”。' }] });
    reply = (r.content || r.reasoning || '').trim().slice(0, 80);
  } catch (e) {
    return { ok: false, tools: false, error: e.message, kind: e.kind || 'error' };
  }
  try {
    const r = await streamChat({
      fetch, baseUrl, apiKey, model, signal, maxTokens: 256,
      messages: [{ role: 'user', content: '这是工具调用测试。请调用 ping 工具，不要直接回答。' }],
      tools: [{ type: 'function', function: { name: 'ping', description: '连通测试用。被要求时调用它。', parameters: { type: 'object', properties: {}, required: [] } } }],
    });
    if (r.toolCalls.some((c) => c.name === 'ping')) return { ok: true, tools: true, reply };
    return { ok: true, tools: false, reply, toolsNote: '模型没有按要求调用工具' };
  } catch (e) {
    return { ok: true, tools: false, reply, toolsNote: '带工具的请求被拒绝：' + e.message };
  }
}

module.exports = { streamChat, probe, normalizeBaseUrl, ProviderError };
