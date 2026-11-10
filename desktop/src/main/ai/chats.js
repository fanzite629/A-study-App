'use strict';
// Conversation storage. Each conversation is its own append-only JSONL file
// under <userData>/chats, so chat history never bloats state.json (which is
// rewritten on every change and every heartbeat).
//
// Line kinds:
//   {k:'msg', msg}            a user / assistant / tool message
//   {k:'proposal', proposal}  a write the agent proposed; a later line with
//                             the same id replaces the earlier one (status change)
// The index (titles, timestamps) lives in chats/index.json.

const fs = require('node:fs');
const path = require('node:path');

const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ID_RE = /^c_[a-z0-9]+$/;

class Chats {
  /** @param {{dir: string, writeJson: (file: string, v: any) => void, readJson: (file: string, fallback: any) => any}} deps */
  constructor(deps) {
    this.dir = deps.dir;
    this.writeJson = deps.writeJson;
    this.readJson = deps.readJson;
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    const raw = this.readJson(this.indexFile, []);
    this.index = Array.isArray(raw) ? raw.filter((c) => c && ID_RE.test(c.id)) : [];
  }

  file(id) {
    if (!ID_RE.test(String(id))) throw new Error('会话编号不正确');
    return path.join(this.dir, id + '.jsonl');
  }
  meta(id) { return this.index.find((c) => c.id === id) || null; }
  saveIndex() { this.writeJson(this.indexFile, this.index); }

  list() { return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt); }

  create(title) {
    const now = Date.now();
    const c = { id: uid('c'), title: title || '新对话', createdAt: now, updatedAt: now };
    this.index.push(c);
    fs.writeFileSync(this.file(c.id), '');
    this.saveIndex();
    return c;
  }

  rename(id, title) {
    const c = this.meta(id);
    if (!c) return null;
    c.title = String(title || '').trim().slice(0, 60) || c.title;
    this.saveIndex();
    return c;
  }

  remove(id) {
    if (!this.meta(id)) return false;
    this.index = this.index.filter((c) => c.id !== id);
    try { fs.unlinkSync(this.file(id)); } catch { /* already gone */ }
    this.saveIndex();
    return true;
  }

  append(id, line) {
    const c = this.meta(id);
    if (!c) throw new Error('找不到这个会话');
    fs.appendFileSync(this.file(id), JSON.stringify(line) + '\n');
    c.updatedAt = Date.now();
    this.saveIndex();
  }

  addMessage(id, msg) {
    const m = { id: uid('m'), at: Date.now(), ...msg };
    this.append(id, { k: 'msg', msg: m });
    return m;
  }

  putProposal(id, proposal) { this.append(id, { k: 'proposal', proposal }); return proposal; }

  /** Replay the file: messages in order, proposals at their latest status. */
  load(id) {
    const c = this.meta(id);
    if (!c) return null;
    let raw = '';
    try { raw = fs.readFileSync(this.file(id), 'utf8'); } catch { /* empty */ }
    const messages = [];
    const proposals = {};
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      let j;
      try { j = JSON.parse(ln); } catch { continue; } // a torn last line is skipped, not fatal
      if (j.k === 'msg' && j.msg) messages.push(j.msg);
      else if (j.k === 'proposal' && j.proposal) proposals[j.proposal.id] = j.proposal;
    }
    return { ...c, messages, proposals };
  }
}

module.exports = { Chats, uid };
