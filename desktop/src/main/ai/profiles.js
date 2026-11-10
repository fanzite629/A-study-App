'use strict';
// Model connection profiles: name, base URL, model name and an API key.
// The key is stored only in encrypted form (the app injects Electron
// safeStorage, which uses Windows DPAPI). Decrypted keys never leave the main
// process: list() returns a hint, get() is for the provider call only.

const { normalizeBaseUrl } = require('./provider');

const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

class Profiles {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.read
   * @param {(data: object) => void} deps.write
   * @param {{available: () => boolean, encrypt: (s: string) => string, decrypt: (s: string) => string}} deps.codec
   */
  constructor(deps) {
    this.read = deps.read;
    this.write = deps.write;
    this.codec = deps.codec;
    const raw = this.read() || {};
    this.data = { activeId: raw.activeId || null, profiles: Array.isArray(raw.profiles) ? raw.profiles : [] };
  }

  save_() { this.write(this.data); }
  find(id) { return this.data.profiles.find((p) => p.id === id) || null; }

  publicView(p) {
    return {
      id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!p.key, keyHint: p.keyHint || '',
      tools: p.tools === undefined ? null : p.tools, toolsNote: p.toolsNote || '', testedAt: p.testedAt || null,
    };
  }

  list() { return { activeId: this.data.activeId, profiles: this.data.profiles.map((p) => this.publicView(p)), encryption: this.codec.available() }; }

  /** Create or update. `apiKey` undefined keeps the stored key; '' clears it. */
  save(input) {
    const name = text(input.name, 40);
    const model = text(input.model, 120);
    let baseUrl;
    try { baseUrl = normalizeBaseUrl(input.baseUrl); } catch (e) { return { ok: false, error: e.message }; }
    if (!model) return { ok: false, error: '请填写模型名' };
    let p = input.id ? this.find(input.id) : null;
    if (input.id && !p) return { ok: false, error: '找不到这组配置' };
    const changed = !p || p.baseUrl !== baseUrl || p.model !== model;
    if (!p) { p = { id: uid(), key: null, keyHint: '' }; this.data.profiles.push(p); }
    if (typeof input.apiKey === 'string') {
      const key = input.apiKey.trim();
      if (!key) { p.key = null; p.keyHint = ''; }
      else {
        if (!this.codec.available()) {
          if (!input.id) this.data.profiles.pop();
          return { ok: false, error: '系统加密不可用，无法安全保存密钥' };
        }
        p.key = this.codec.encrypt(key);
        p.keyHint = key.length > 8 ? '…' + key.slice(-4) : '已保存';
      }
    }
    p.name = name || model;
    p.baseUrl = baseUrl;
    p.model = model;
    if (changed) { p.tools = null; p.toolsNote = ''; p.testedAt = null; } // old test result no longer applies
    if (input.tools === true || input.tools === false) p.tools = input.tools; // manual override
    if (!this.data.activeId) this.data.activeId = p.id;
    this.save_();
    return { ok: true, profile: this.publicView(p) };
  }

  remove(id) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.data.profiles[0] ? this.data.profiles[0].id : null;
    this.save_();
    return { ok: true };
  }

  setActive(id) {
    if (!this.find(id)) return { ok: false, error: '找不到这组配置' };
    this.data.activeId = id;
    this.save_();
    return { ok: true };
  }

  recordTest(id, result) {
    const p = this.find(id);
    if (!p) return;
    if (result.ok) { p.tools = !!result.tools; p.toolsNote = result.toolsNote || ''; }
    p.testedAt = Date.now();
    this.save_();
  }

  /** Full connection details including the decrypted key. Main process only. */
  get(id) {
    const p = this.find(id || this.data.activeId);
    if (!p) return null;
    let apiKey = '';
    if (p.key) { try { apiKey = this.codec.decrypt(p.key); } catch { apiKey = ''; } }
    return { id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey, tools: p.tools === true };
  }
}

module.exports = { Profiles };
