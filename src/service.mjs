import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Room, displayName, threadID, MAX_MEMBERS } from './rooms.mjs';
import { listen, connectPeer } from './wire.mjs';
import { pairingCode, commitment } from './identity.mjs';
import { cleanAvatar, cleanProfile } from './profile.mjs';
import { expandImages, uploadInputImages } from './images.mjs';
import { NearbyDiscovery, peerAddresses } from './discovery.mjs';

export class MultiplayerService extends EventEmitter {
  constructor({ identity, name, bridge, directory, invitationTTL = 120_000 }) {
    super();
    this.identity = identity;
    this.name = displayName(name);
    this.fallbackName = this.name;
    this.profileSource = 'fallback';
    this.bridge = bridge;
    this.directory = directory;
    this.invitationTTL = invitationTTL;
    this.peers = new Map();
    this.rooms = new Map();
    this.remoteRooms = new Map();
    this.invitations = new Map();
    this.connections = new Set();
    this.outgoing = new Map();
    this.sharing = new Map();
    this.networkGeneration = 0;
    this.attribution = {};
    try { this.attribution = JSON.parse(readFileSync(join(directory, 'authors.json'), 'utf8')); } catch {}
    bridge.on('notification', ({ method, params }) => {
      for (const room of this.rooms.values()) room.notification(method, params);
    });
    bridge.on('approval', ({ threadId }) => {
      for (const room of this.rooms.values()) if (room.threadId === threadId) {
        this.publish(room, { type: 'notice', text: 'Codex needs the host’s approval. Open the original chat to respond.' });
      }
    });
    const reset = () => {
      for (const room of this.rooms.values()) room.close();
      for (const wire of this.connections) wire.close();
      this.notice('Codex disconnected. Reconnect and share again.');
    };
    bridge.on('disconnected', reset);
    bridge.on('reset', reset);
  }

  state() {
    return { self: { id: this.identity.id, name: this.name, avatar: this.avatar, profileSource: this.profileSource }, peers: [...this.peers.values()],
      rooms: [...this.rooms.values()].filter(room => !room.closed).map(room => room.snapshot()).concat([...this.remoteRooms.values()].map(value => value.snapshot)),
      invitations: [...this.invitations.values()].map(({ id, name, avatar, title, code, expiresAt }) => ({ id, name, avatar, title, code, expiresAt })),
      outgoing: [...this.outgoing.values()].map(({ id, name, code, status, roomId, peerId }) => ({ id, name, code, status, roomId, peerId })) };
  }

  changed() { this.emit('state', this.state()); }
  notice(text) { this.emit('notice', text); }

  setProfile(value) {
    const profile = cleanProfile(value, this.fallbackName);
    this.profileProbe = Object.fromEntries(['buttons', 'spans', 'shortText', 'images', 'canvases', 'imageWidth', 'httpsImage', 'dataImage', 'blobImage', 'copyFailed', 'retryFailed'].filter(key => Number.isSafeInteger(value?.probe?.[key]) && value.probe[key] >= 0 && value.probe[key] <= 10000).map(key => [key, value.probe[key]]));
    this.name = profile.name;
    this.avatar = profile.avatar;
    this.profileSource = value?.name ? 'codex' : 'fallback';
    for (const room of this.rooms.values()) if (!room.closed) {
      Object.assign(room.host, profile);
      Object.assign(room.members.get(this.identity.id), profile);
      room.changed();
    }
    for (const remote of this.remoteRooms.values()) remote.wire.send({ type: 'profile-update', ...profile });
    this.discovery?.updateProfile();
    this.changed();
    this.emit('profile');
  }

  discoveryProfile() {
    return { id: this.identity.id, name: this.name, version: '2', profileRevision: String(Date.now()),
      initials: this.avatar?.initials || '', background: this.avatar?.background || '', color: this.avatar?.color || '' };
  }

  async fetchProfile(peer) {
    let wire;
    try {
      wire = await connectPeer(peer, this.identity);
      if (!this.track(wire)) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { wire.close(); resolve(); }, 3000);
        wire.once('close', () => { clearTimeout(timer); resolve(); });
        wire.once('message', message => {
          if (message.type === 'profile' && this.peers.get(peer.id) === peer) {
            Object.assign(peer, cleanProfile(message, peer.name));
            this.changed();
          }
          wire.close();
        });
        wire.send({ type: 'profile-request' });
      });
    } catch {} finally { wire?.close(); }
  }

  async start({ host, port, discovery = true } = {}) {
    this.server = await listen(this.identity, wire => this.incoming(wire), host, port);
    this.server.maxConnections = 32;
    this.port = this.server.address().port;
    if (discovery) {
      this.discovery = new NearbyDiscovery({ id: this.identity.id, port: this.port, profile: () => this.discoveryProfile(),
        onPeer: service => {
          const { id, name } = service.txt;
          const addresses = peerAddresses(service);
          const peer = { id, name: displayName(name), address: addresses[0], addresses, port: service.port,
            avatar: this.peers.get(id)?.avatar || cleanAvatar(service.txt) };
          this.peers.set(id, peer);
          this.changed();
          void this.fetchProfile(peer);
        },
        onDown: id => { this.peers.delete(id); this.changed(); },
        onReset: () => {
          this.networkGeneration++;
          this.peers.clear();
          for (const wire of this.connections) wire.close();
          this.notice('Network changed. Finding nearby computers again. Invite again to resume sharing.');
          this.changed();
        },
        onError: error => this.notice(`Nearby discovery: ${error.message}`),
      });
      this.discovery.start();
    }
    return this.port;
  }

  track(wire) {
    if (this.closing || this.connections.size >= 24) { wire.close(); return false; }
    this.connections.add(wire);
    wire.on('close', () => this.connections.delete(wire));
    return true;
  }

  incoming(wire) {
    if (!this.track(wire)) return;
    let invitation;
    let remote;
    const timer = setTimeout(() => wire.close(), this.invitationTTL);
    timer.unref();
    wire.on('message', message => {
      try {
        if (!invitation) {
          if (message.type === 'profile-request') {
            wire.send({ type: 'profile', name: this.name, avatar: this.avatar });
            wire.socket.end();
            return;
          }
          if (message.type !== 'invite' || !threadID(message.id) || !threadID(message.roomId) || !/^[a-f0-9]{64}$/.test(message.commitment || '')) throw new Error('Invalid invitation.');
          if (this.invitations.has(message.id) || this.remoteRooms.has(message.roomId)) throw new Error('Duplicate invitation.');
          invitation = { id: message.id, roomId: message.roomId, wire, ...cleanProfile(message), title: displayName(message.title),
            commitment: message.commitment, guestNonce: randomBytes(32).toString('hex'), expiresAt: Date.now() + this.invitationTTL };
          wire.send({ type: 'challenge', id: invitation.id, nonce: invitation.guestNonce });
          return;
        }
        if (message.type === 'reveal' && !invitation.code) {
          if (message.id !== invitation.id || !/^[a-f0-9]{64}$/.test(message.nonce || '') || commitment(message.nonce) !== invitation.commitment) throw new Error('Invalid pairing commitment.');
          invitation.code = pairingCode(this.identity.id, wire.peerId, invitation.id, message.nonce, invitation.guestNonce);
          this.invitations.set(invitation.id, invitation);
          this.changed();
          return;
        }
        if (!invitation.accepted) return;
        if (message.type === 'snapshot' && message.room?.id === invitation.roomId) {
          if (message.room.host?.id !== wire.peerId || !Array.isArray(message.room.messages) || !Array.isArray(message.room.members)) throw new Error('Invalid room.');
          message.room.host = { id: wire.peerId, ...cleanProfile(message.room.host) };
          message.room.members = message.room.members.map(member => ({ id: member.id, role: member.role, online: member.online, ...cleanProfile(member) }));
          remote ||= { wire, pending: new Map(), images: new Map(), events: Promise.resolve() };
          remote.snapshot = message.room;
          this.remoteRooms.set(invitation.roomId, remote);
          this.changed();
        } else if (message.type === 'native-event' && remote && message.params?.threadId === remote.snapshot.threadId) {
          remote.events = remote.events.then(async () => {
            const params = await this.expandRemoteImages(invitation.roomId, message.params);
            if (this.remoteRooms.get(invitation.roomId) === remote) this.emit('native-event', { roomId: invitation.roomId, method: message.method, params });
          }).catch(error => this.notice(`Shared image/event: ${error.message}`));
        } else if (['prompt-result', 'native-result'].includes(message.type) && remote) {
          const pending = remote.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            remote.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
          }
        } else if (message.type === 'ended') {
          this.remoteRooms.delete(invitation.roomId);
          this.notice(message.reason || 'The host ended sharing.');
          wire.close();
        } else if (message.type === 'notice') this.notice(String(message.text).slice(0, 500));
      } catch { wire.close(); }
    });
    wire.on('close', () => {
      clearTimeout(timer);
      if (invitation) this.invitations.delete(invitation.id);
      if (remote) {
        for (const pending of remote.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected. Check the chat before resending your message.')); }
        this.remoteRooms.delete(invitation.roomId);
        this.notice('Disconnected from the host. Ask them to invite you again.');
      }
      this.changed();
    });
    wire.acceptTimer = timer;
  }

  async share(threadId, title) {
    if (!threadID(threadId)) throw new Error('Choose a local Codex conversation.');
    if (this.sharing.has(threadId)) return this.sharing.get(threadId);
    const pending = this.createRoom(threadId, title);
    this.sharing.set(threadId, pending);
    try { return await pending; } finally { this.sharing.delete(threadId); }
  }

  async createRoom(threadId, title) {
    const existing = [...this.rooms.values()].find(room => room.threadId === threadId && !room.closed);
    if (existing) return existing.id;
    const room = new Room({ threadId, title, host: { id: this.identity.id, name: this.name, avatar: this.avatar }, bridge: this.bridge,
      attribution: this.attribution[threadId] || {}, persist: authors => {
        this.attribution[threadId] = authors;
        if (!this.directory) return;
        const path = join(this.directory, 'authors.json');
        writeFileSync(`${path}.tmp`, JSON.stringify(this.attribution), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      } });
    await room.initialize();
    this.rooms.set(room.id, room);
    room.on('change', snapshot => {
      this.publish(room, { type: 'snapshot', room: snapshot });
      this.changed();
    });
    room.on('problem', text => { this.publish(room, { type: 'notice', text }); this.notice(text); });
    let events = Promise.resolve();
    room.on('native-event', event => {
      events = events.then(async () => {
        const params = await room.images.pack(event.params, () => this.publish(room, { type: 'notice', text: 'An image is unavailable on the host or exceeds the 16 MiB sharing limit.' }));
        if (!room.closed) this.publish(room, { type: 'native-event', method: event.method, params });
      }).catch(error => this.notice(`Shared image/event: ${error.message}`));
    });
    this.changed();
    return room.id;
  }

  publish(room, message) {
    for (const outgoing of this.outgoing.values()) {
      if (outgoing.roomId === room.id && outgoing.status === 'joined') outgoing.wire.send(message);
    }
  }

  async invite(roomId, peerId) {
    const generation = this.networkGeneration;
    const room = this.rooms.get(roomId);
    const peer = this.peers.get(peerId);
    if (!room || room.closed || !peer) throw new Error('This chat or nearby computer is no longer available.');
    const available = () => {
      if (room.closed) throw new Error('Sharing ended.');
      if (this.closing || generation !== this.networkGeneration) throw new Error('Network changed. Wait for the computer to reappear, then invite again.');
      const invitations = [...this.outgoing.values()].filter(value => value.roomId === roomId);
      if (room.members.has(peerId) || invitations.some(value => value.peerId === peerId)) throw new Error('Already invited to this chat.');
      const waiting = invitations.filter(value => value.status === 'waiting' && !room.members.has(value.peerId)).length;
      if (room.members.size + waiting >= MAX_MEMBERS) throw new Error(`This chat is full (${MAX_MEMBERS} people including the host). Pending invitations reserve a place.`);
    };
    available();
    let wire;
    try { wire = await connectPeer(peer, this.identity); }
    catch (error) {
      if (error.message.includes('identity changed')) throw error;
      throw new Error('Could not reach this computer. Check that both Macs are on the same Wi-Fi with Multiplayer Codex open. Guest or public Wi-Fi may block connections between devices. Try again after discovery refreshes.');
    }
    try { available(); } catch (error) { wire.close(); throw error; }
    if (!this.track(wire)) throw new Error('Too many connections.');
    const id = randomUUID();
    const outgoing = { id, roomId, wire, peerId, name: peer.name, hostNonce: randomBytes(32).toString('hex'), code: '…', status: 'waiting' };
    this.outgoing.set(id, outgoing);
    const timer = setTimeout(() => { if (outgoing.status === 'waiting') wire.close(); }, this.invitationTTL);
    timer.unref();
    wire.on('message', message => {
      try {
        if (message.type === 'challenge' && message.id === id && !outgoing.guestNonce) {
          if (!/^[a-f0-9]{64}$/.test(message.nonce || '')) { wire.close(); return; }
          outgoing.guestNonce = message.nonce;
          outgoing.code = pairingCode(this.identity.id, peerId, id, outgoing.hostNonce, outgoing.guestNonce);
          wire.send({ type: 'reveal', id, nonce: outgoing.hostNonce });
          this.changed();
        } else if (message.type === 'accept' && message.id === id && outgoing.guestNonce && outgoing.status === 'waiting' && !room.closed) {
          room.join({ id: peer.id, ...cleanProfile(message) });
          outgoing.status = 'joined';
          clearTimeout(timer);
          wire.send({ type: 'snapshot', room: room.snapshot() });
          this.changed();
        } else if (message.type === 'profile-update' && outgoing.status === 'joined' && !room.closed) {
          room.join({ id: peer.id, ...cleanProfile(message) });
        } else if (message.type === 'typing' && outgoing.status === 'joined') {
          if (message.active !== false && Date.now() - (outgoing.lastTyping || 0) < 750) return;
          outgoing.lastTyping = Date.now();
          room.setTyping(peer.id, message.active === true);
        } else if (message.type === 'decline') wire.close();
        else if (message.type === 'prompt' && outgoing.status === 'joined') {
          try {
            Promise.resolve(room.submit(peer.id, message)).then(
              result => wire.send({ type: 'prompt-result', id: message.id, result }),
              error => wire.send({ type: 'prompt-result', id: message.id, error: error.message }));
          } catch (error) { wire.send({ type: 'prompt-result', id: message.id, error: error.message }); }
        }
        else if (message.type === 'native-request' && outgoing.status === 'joined') {
          if ((outgoing.inflight || 0) >= 32) throw new Error('Too many pending requests.');
          outgoing.inflight = (outgoing.inflight || 0) + 1;
          this.requestRoom(room, peer.id, message.method, message.params, message.id).then(
            result => { if (outgoing.status === 'joined' && !room.closed) wire.send({ type: 'native-result', id: message.id, result }); },
            error => wire.send({ type: 'native-result', id: message.id, error: error.message })
          ).finally(() => { outgoing.inflight--; });
        }
        else if (message.type === 'leave') wire.close();
      } catch (error) { wire.send({ type: 'notice', text: error.message }); }
    });
    wire.on('close', () => {
      clearTimeout(timer);
      this.outgoing.delete(id);
      if (room.members.has(peer.id)) room.remove(peer.id);
      this.changed();
    });
    wire.send({ type: 'invite', id, roomId, name: this.name, avatar: this.avatar, title: room.title, commitment: commitment(outgoing.hostNonce) });
    this.changed();
    return id;
  }

  accept(id, code) {
    const invitation = this.invitations.get(id);
    if (!invitation || invitation.expiresAt < Date.now()) throw new Error('This invitation expired.');
    if (invitation.code !== code) throw new Error('Pairing codes do not match.');
    invitation.accepted = true;
    clearTimeout(invitation.wire.acceptTimer);
    this.invitations.delete(id);
    invitation.wire.send({ type: 'accept', id, name: this.name, avatar: this.avatar });
    this.changed();
  }

  decline(id) {
    const invitation = this.invitations.get(id);
    invitation?.wire.send({ type: 'decline' });
    invitation?.wire.close();
    this.invitations.delete(id);
    this.changed();
  }

  send(roomId, text, id) {
    const local = this.rooms.get(roomId);
    if (local) return local.submit(this.identity.id, { text, id });
    const remote = this.remoteRooms.get(roomId);
    if (!remote || remote.wire.closed) throw new Error('Disconnected. Your message was not sent.');
    if (remote.pending.has(id)) throw new Error('This message is already being sent.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remote.pending.delete(id); reject(new Error('No acknowledgement. Check the chat before resending.')); }, 30_000);
      remote.pending.set(id, { resolve, reject, timer });
      if (!remote.wire.send({ type: 'prompt', text, id })) {
        clearTimeout(timer);
        remote.pending.delete(id);
        reject(new Error('Disconnected. Your message was not sent.'));
      }
    });
  }

  setTyping(roomId, active) {
    const room = this.rooms.get(roomId);
    if (room) return room.setTyping(this.identity.id, active === true);
    const remote = this.remoteRooms.get(roomId);
    if (!remote || remote.wire.closed) return;
    remote.wire.send({ type: 'typing', active: active === true });
  }

  async requestRoom(room, memberId, method, params = {}, id = randomUUID()) {
    if (room.closed || !room.members.has(memberId)) throw new Error('You no longer have access to this chat.');
    if (params.threadId !== room.threadId) throw new Error('This connection only grants access to the invited chat.');
    if (method === 'multiplayer/image/read') return room.images.read(params.imageId, params.offset);
    if (method === 'multiplayer/image/upload') return room.images.upload(memberId, params);
    if (method === 'turn/start') {
      if (room.active || room.starting) throw new Error('Codex is working. Wait for this turn to finish before sending.');
      const host = memberId === this.identity.id;
      if (!Array.isArray(params.input) || !params.input.length || params.input.some(part => !(part.type === 'text' && typeof part.text === 'string')
        && !(host && part.type === 'localImage' && typeof part.path === 'string')
        && !(part.type === 'image' && typeof part.url === 'string'))) {
        throw new Error('Multiplayer currently supports text messages. Send attachments outside the shared session.');
      }
      const input = host ? params.input : params.input.map(part => room.images.input(part));
      const result = await room.submit(memberId, { id, text: input.filter(part => part.type === 'text').map(part => part.text).join('\n'), params: { ...params, input } });
      if (room.closed || !room.members.has(memberId)) throw new Error('Sharing ended.');
      return host ? result : room.images.pack(result);
    }
    const reads = {
      'thread/read': ['includeTurns'],
      'thread/resume': ['excludeTurns'],
      'thread/turns/list': ['cursor', 'limit', 'sortDirection', 'itemsView'],
      'thread/items/list': ['turnId', 'cursor', 'limit', 'sortDirection'],
      'thread/timeline/list': ['cursor', 'limit'],
      'thread/queue/list': [],
      'thread/goal/get': [],
    };
    if (!Object.hasOwn(reads, method)) throw new Error(method === 'turn/steer'
      ? 'Wait for the current turn to finish before sending in a shared chat.'
      : 'This action is not available in multiplayer. The host can end sharing to use it.');
    const safe = { threadId: room.threadId };
    for (const key of reads[method]) if (params[key] !== undefined) safe[key] = params[key];
    if ('limit' in safe) safe.limit = Math.max(1, Math.min(100, Number(safe.limit) || 20));
    const result = await this.bridge.request(method, safe);
    if (room.closed || !room.members.has(memberId)) throw new Error('Sharing ended.');
    const shared = memberId === this.identity.id ? result : await room.images.pack(result,
      () => this.publish(room, { type: 'notice', text: 'An image is unavailable on the host or exceeds the 16 MiB sharing limit.' }));
    if (room.closed || !room.members.has(memberId)) throw new Error('Sharing ended.');
    return shared;
  }

  expandRemoteImages(roomId, value) {
    const remote = this.remoteRooms.get(roomId);
    if (!remote || remote.wire.closed) throw new Error('Sharing ended.');
    return expandImages(value, remote.images, (imageId, offset) => this.nativeRequest(roomId, 'multiplayer/image/read', {
      threadId: remote.snapshot.threadId, imageId, offset,
    }));
  }

  nativeRequest(roomId, method, params, id = randomUUID()) {
    const local = this.rooms.get(roomId);
    if (local) return this.requestRoom(local, this.identity.id, method, params, id);
    const remote = this.remoteRooms.get(roomId);
    if (!remote || remote.wire.closed) throw new Error('Disconnected. Your message was not sent.');
    if (method === 'turn/start' && Array.isArray(params.input) && params.input.some(part => part.type !== 'text')) {
      return uploadInputImages(params.input, chunk => this.nativeRequest(roomId, 'multiplayer/image/upload', { threadId: remote.snapshot.threadId, ...chunk }))
        .then(input => this.remoteRequest(roomId, method, { ...params, input }, id));
    }
    return this.remoteRequest(roomId, method, params, id);
  }

  remoteRequest(roomId, method, params, id) {
    const remote = this.remoteRooms.get(roomId);
    if (!remote || remote.wire.closed) throw new Error('Disconnected. Your message was not sent.');
    if (remote.pending.size >= 32 || remote.pending.has(id)) throw new Error('Too many pending requests.');
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remote.pending.delete(id); reject(new Error('The host did not respond. Check the chat before resending.')); }, 30_000);
      remote.pending.set(id, { resolve, reject, timer });
      if (!remote.wire.send({ type: 'native-request', id, method, params })) {
        clearTimeout(timer);
        remote.pending.delete(id);
        reject(new Error('Disconnected. Your message was not sent.'));
      }
    });
    return method === 'multiplayer/image/read' ? response : response.then(value => this.expandRemoteImages(roomId, value));
  }

  revoke(roomId, memberId) {
    const room = this.rooms.get(roomId);
    if (!room || room.closed) throw new Error('Only the host can remove someone.');
    for (const outgoing of this.outgoing.values()) if (outgoing.roomId === roomId && outgoing.wire.peerId === memberId) {
      outgoing.wire.send({ type: 'ended', reason: 'The host removed you from this chat.' });
      outgoing.status = 'revoked';
      outgoing.wire.close();
    }
    room.remove(memberId);
  }

  end(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.publish(room, { type: 'ended', reason: 'The host ended sharing.' });
      room.close();
      for (const outgoing of this.outgoing.values()) if (outgoing.roomId === roomId) outgoing.wire.close();
    } else {
      const remote = this.remoteRooms.get(roomId);
      remote?.wire.send({ type: 'leave' });
      remote?.wire.close();
      this.remoteRooms.delete(roomId);
    }
    this.changed();
  }

  async close() {
    this.closing = true;
    this.discovery?.stop();
    for (const room of this.rooms.values()) this.end(room.id);
    for (const wire of this.connections) wire.close();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}
