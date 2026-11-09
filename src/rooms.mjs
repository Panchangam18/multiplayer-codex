import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SharedImages } from './images.mjs';

export const threadID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const MAX_MEMBERS = 5;
export const displayName = value => String(value || 'Someone').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 60) || 'Someone';

export class Room extends EventEmitter {
  constructor({ threadId, title, host, bridge, attribution = {}, persist = () => {} }) {
    super();
    this.id = randomUUID();
    this.threadId = threadId;
    this.title = displayName(title || 'Shared conversation');
    this.host = host;
    this.bridge = bridge;
    this.members = new Map([[host.id, { ...host, role: 'host', online: true }]]);
    this.messages = [];
    this.queue = [];
    this.active = null;
    this.starting = false;
    this.closed = false;
    this.attribution = attribution;
    this.persist = persist;
    this.seen = new Set();
    this.requests = new Map();
    this.itemAuthors = {};
    this.revision = 0;
    this.paused = null;
    this.typing = new Map();
    this.execution = null;
    this.images = new SharedImages();
  }

  snapshot() {
    let remaining = 250_000;
    const recent = [];
    for (const message of this.messages.slice(-500).reverse()) {
      remaining -= JSON.stringify(message).length;
      if (remaining < 0) break;
      recent.unshift(message);
    }
    return { id: this.id, title: this.title, threadId: this.threadId, host: this.host,
      members: [...this.members.values()], maxMembers: MAX_MEMBERS, messages: recent, thread: this.thread,
      authors: { turns: this.attribution, items: this.itemAuthors },
      typing: [...this.typing.keys()], execution: this.execution,
      queueLength: this.queue.length, active: this.active, closed: this.closed, paused: this.paused, revision: this.revision };
  }

  changed() { this.revision++; this.emit('change', this.snapshot()); }

  async initialize() {
    const response = await this.bridge.request('thread/read', { threadId: this.threadId, includeTurns: false });
    const thread = response.thread;
    this.thread = thread && { ...thread, turns: [] };
    if (!thread || thread.id !== this.threadId) throw new Error('Codex returned a different conversation.');
    if (thread.status?.type === 'active' || thread.turns?.some(turn => turn.status === 'inProgress')) {
      throw new Error('Wait for this chat’s current turn to finish, then share it.');
    }
    let turns = thread.turns || [];
    if (!turns.length) {
      try {
        const page = await this.bridge.request('thread/turns/list', { threadId: this.threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
        turns = [...page.data].reverse();
      } catch (error) {
        if (!/unsupported|not found|unknown|invalid.*method/i.test(error.message)) throw error;
        const legacy = await this.bridge.request('thread/read', { threadId: this.threadId, includeTurns: true });
        turns = legacy.thread.turns || [];
      }
    }
    if (turns.some(turn => ['inProgress', 'in_progress'].includes(turn.status))) throw new Error('Wait for this chat’s current turn to finish, then share it.');
    for (const turn of turns) for (const item of turn.items || []) this.item(item, turn.id, false);
    const resumed = await this.bridge.request('thread/resume', { threadId: this.threadId, excludeTurns: true });
    this.updateExecution(resumed);
    this.changed();
  }

  updateExecution(value) {
    const model = value?.collaborationMode?.settings?.model || value?.model;
    if (typeof model !== 'string' || !/^[\w.:-]{1,100}$/.test(model)) return;
    const effort = value.collaborationMode?.settings?.reasoning_effort ?? value.reasoningEffort ?? value.effort ?? null;
    this.execution = { model, reasoningEffort: typeof effort === 'string' && /^[a-z-]{1,30}$/.test(effort) ? effort : null };
  }

  setTyping(memberId, active) {
    if (this.closed || !this.members.has(memberId)) throw new Error('You no longer have access to this chat.');
    const previous = this.typing.get(memberId);
    clearTimeout(previous);
    if (active === true) {
      const timer = setTimeout(() => { this.typing.delete(memberId); this.changed(); }, 5000);
      timer.unref?.();
      this.typing.set(memberId, timer);
    } else this.typing.delete(memberId);
    if (Boolean(previous) !== (active === true)) this.changed();
  }

  join(member) {
    if (this.closed) throw new Error('Sharing ended.');
    if (!this.members.has(member.id) && this.members.size >= MAX_MEMBERS) throw new Error(`This chat is full (${MAX_MEMBERS} people including the host).`);
    this.members.set(member.id, { id: member.id, name: displayName(member.name), avatar: member.avatar, role: 'guest', online: true });
    this.changed();
  }

  remove(memberId) {
    if (memberId === this.host.id) throw new Error('The host must end sharing.');
    clearTimeout(this.typing.get(memberId));
    this.typing.delete(memberId);
    this.members.delete(memberId);
    this.images.discardUploads(memberId);
    for (const entry of this.queue.filter(entry => entry.author.id === memberId)) {
      entry.status = 'cancelled';
      this.requests.get(entry.id)?.reject(new Error('You no longer have access to this chat.'));
    }
    this.queue = this.queue.filter(entry => entry.author.id !== memberId);
    this.changed();
  }

  submit(memberId, { text, id, params }) {
    if (this.closed || !this.members.has(memberId)) throw new Error('You no longer have access to this chat.');
    if (this.paused) throw new Error(this.paused);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid message ID.');
    if (this.seen.has(`${memberId}:${id}`)) return this.requests.get(`${memberId}:${id}`)?.promise;
    const hasImage = params?.input?.some(part => part.type === 'image' || (memberId === this.host.id && part.type === 'localImage'));
    if (typeof text !== 'string' || (!text.trim() && !hasImage) || text.length > 24_000) throw new Error('Write a message under 24,000 characters.');
    if (this.queue.length >= 32) throw new Error('The queue is full. Wait for Codex to catch up.');
    const member = this.members.get(memberId);
    const entry = { id: `${memberId}:${id}`, role: 'user', author: { id: member.id, name: member.name },
      text, status: 'queued', createdAt: Date.now() };
    const clientUserMessageId = params?.clientUserMessageId;
    const guestParams = typeof clientUserMessageId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(clientUserMessageId) ? { clientUserMessageId } : {};
    if (memberId !== this.host.id && params?.input) guestParams.input = params.input.map(part => {
      if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text, text_elements: [] };
      if (part.type === 'image' && typeof part.url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(part.url)) return { type: 'image', url: part.url };
      throw new Error('Guest images must be transferred before submission.');
    });
    const request = { params: memberId === this.host.id ? params : guestParams };
    this.seen.add(`${memberId}:${id}`);
    this.setTyping(memberId, false);
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    request.promise.catch(() => {});
    this.requests.set(entry.id, request);
    this.messages.push(entry);
    this.queue.push(entry);
    this.changed();
    void this.drain();
    return request.promise;
  }

  async drain() {
    if (this.active || this.starting || this.closed || !this.queue.length) return;
    this.starting = true;
    const entry = this.queue.shift();
    this.pendingEntry = entry;
    entry.status = 'sending';
    this.changed();
    try {
      const result = await this.bridge.request('turn/start', {
        ...this.requests.get(entry.id)?.params,
        threadId: this.threadId,
        input: this.requests.get(entry.id)?.params?.input || [{ type: 'text', text: entry.text, text_elements: [] }],
      });
      if (!result.turn?.id) throw new Error('Codex did not return a turn ID.');
      this.updateExecution(this.requests.get(entry.id)?.params);
      entry.turnId = result.turn.id;
      entry.status = 'sent';
      this.attribution[entry.turnId] = entry.author;
      this.persist(this.attribution);
      this.requests.get(entry.id)?.resolve(result);
      if (!this.completedTurns?.has(entry.turnId)) this.active = entry.turnId;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message;
      this.requests.get(entry.id)?.reject(error);
      this.paused = 'Sending paused because the last request failed or its outcome is unknown. Check the original chat, end sharing, and share again.';
      this.queue.forEach(queued => { queued.status = 'cancelled'; this.requests.get(queued.id)?.reject(error); });
      this.queue = [];
      this.emit('problem', error.message);
    } finally {
      this.pendingEntry = null;
      this.starting = false;
      this.changed();
      void this.drain();
    }
  }

  item(item, turnId, notify = true) {
    if (!item || !['userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) return;
    if (item.type === 'userMessage' && this.attribution[turnId]) this.itemAuthors[item.id] = this.attribution[turnId];
    if (item.type === 'userMessage' && (this.messages.some(entry => entry.turnId === turnId && entry.role === 'user') || this.pendingEntry)) return;
    const author = this.attribution[turnId] || { id: 'history', name: 'Earlier message' };
    let text = item.type === 'userMessage' ? (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      : item.text || item.command || item.tool || (item.type === 'fileChange' ? 'File changes' : 'Working');
    if (item.type === 'userMessage' && this.attribution[turnId]) text = text.replace(/^\[[^\n]* · Multiplayer\]\n/, '');
    const existing = this.messages.find(entry => entry.id === item.id);
    const entry = { id: item.id, turnId, role: item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'agent' : 'activity',
      author: item.type === 'userMessage' ? author : { id: 'codex', name: 'Codex' }, text: String(text).slice(0, 100_000), status: item.status || 'complete' };
    if (existing) Object.assign(existing, entry); else this.messages.push(entry);
    if (notify) this.changed();
  }

  notification(method, params) {
    if (this.closed || params.threadId !== this.threadId) return;
    if (params.item?.type === 'userMessage') {
      const author = this.pendingEntry?.author || this.attribution[params.turnId] || this.host;
      this.itemAuthors[params.item.id] = author;
      if (this.pendingEntry) {
        this.attribution[params.turnId] = author;
        this.persist(this.attribution);
      }
    }
    if (method === 'turn/started') this.active = params.turn.id;
    if (method === 'turn/completed') {
      (this.completedTurns ||= new Set()).add(params.turn.id);
      if (this.active === params.turn.id) this.active = null;
    }
    if (method === 'item/started' || method === 'item/completed') this.item(params.item, params.turnId, false);
    if (method === 'item/agentMessage/delta') {
      let entry = this.messages.find(message => message.id === params.itemId);
      if (!entry) {
        entry = { id: params.itemId, turnId: params.turnId, role: 'agent', author: { id: 'codex', name: 'Codex' }, text: '', status: 'streaming' };
        this.messages.push(entry);
      }
      entry.text = (entry.text + params.delta).slice(0, 100_000);
    }
    if (method === 'error') this.emit('problem', params.error?.message || 'Codex reported an error.');
    this.changed();
    this.emit('native-event', { method, params });
    if (method === 'turn/completed') void this.drain();
  }

  close() {
    this.closed = true;
    this.images.close();
    for (const timer of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
    this.queue.forEach(entry => { entry.status = 'cancelled'; this.requests.get(entry.id)?.reject(new Error('Sharing ended.')); });
    this.queue = [];
    this.changed();
  }
}
