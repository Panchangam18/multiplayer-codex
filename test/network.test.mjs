import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadIdentity } from '../src/identity.mjs';
import { MultiplayerService } from '../src/service.mjs';
import { connectPeer } from '../src/wire.mjs';
import { commitment } from '../src/identity.mjs';

class Bridge extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] } };
    if (method === 'thread/turns/list') return { data: [{ id: 'history', items: [{ id: 'history-message', type: 'agentMessage', text: 'Private before acceptance' }] }] };
    if (method === 'thread/resume') return { model: 'host-model', reasoningEffort: 'high' };
    if (method === 'turn/start') return { turn: { id: 'turn-one' } };
    throw new Error('Unexpected method');
  }
}

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(check(), 'Condition did not become true');
}

async function setup(context, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'multiplayer-test-'));
  const host = new MultiplayerService({ identity: loadIdentity(join(directory, 'host')), name: 'Madhavan', bridge: new Bridge(), ...options });
  const guest = new MultiplayerService({ identity: loadIdentity(join(directory, 'guest')), name: 'Alex', bridge: new Bridge(), ...options });
  context.after(async () => { await host.close(); await guest.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start({ host: '127.0.0.1', discovery: false });
  await guest.start({ host: '127.0.0.1', discovery: false });
  host.peers.set(guest.identity.id, { id: guest.identity.id, name: guest.name, address: '127.0.0.1', port: guest.port });
  return { host, guest };
}

test('real TLS: racing invitations reserve four guest places and decline releases capacity', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'multiplayer-capacity-'));
  const peers = Array.from({ length: 6 }, (_, index) => new MultiplayerService({
    identity: loadIdentity(join(directory, String(index))), name: `Person ${index}`, bridge: new Bridge(),
  }));
  context.after(async () => { for (const peer of peers) await peer.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const peer of peers) await peer.start({ host: '127.0.0.1', discovery: false });
  const [host, ...guests] = peers;
  for (const guest of guests) host.peers.set(guest.identity.id, { id: guest.identity.id, name: guest.name, address: '127.0.0.1', port: guest.port });
  const roomId = await host.share('shared-thread', 'Five people');
  const results = await Promise.allSettled(guests.map(guest => host.invite(roomId, guest.identity.id)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /full/);
  const invited = guests.filter((_, index) => results[index].status === 'fulfilled');
  const excluded = guests.find((_, index) => results[index].status === 'rejected');
  await until(() => invited.every(guest => guest.invitations.size === 1));
  const declining = invited.shift();
  declining.decline(declining.state().invitations[0].id);
  await until(() => host.outgoing.size === 3);
  await host.invite(roomId, excluded.identity.id);
  await until(() => excluded.invitations.size === 1);
  for (const guest of [...invited, excluded]) {
    const invitation = guest.state().invitations[0];
    guest.accept(invitation.id, invitation.code);
  }
  await until(() => host.rooms.get(roomId).members.size === 5);
  await assert.rejects(host.invite(roomId, declining.identity.id), /full/);
  assert.equal(declining.remoteRooms.size, 0);
});

test('real TLS: invitation reveals no history until acceptance, both users send, revoke blocks access', async context => {
  const { host, guest } = await setup(context);
  const roomId = await host.share('shared-thread', 'Build together');
  const invitationId = await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  assert.equal(guest.remoteRooms.size, 0);
  assert.ok(!JSON.stringify(guest.state()).includes('Private before acceptance'));
  assert.throws(() => guest.accept(invitationId, 'bad-code'), /do not match/);
  assert.equal(guest.state().invitations[0].code, host.state().outgoing[0].code);
  guest.accept(invitationId, guest.state().invitations[0].code);
  await until(() => guest.remoteRooms.size === 1);
  assert.match(JSON.stringify(guest.state()), /Private before acceptance/);
  await guest.send(roomId, 'Hello from Alex', 'guest-message-1');
  await until(() => host.bridge.calls.some(call => call.method === 'turn/start'));
  assert.equal(host.bridge.calls.find(call => call.method === 'turn/start').params.input[0].text, 'Hello from Alex');
  assert.equal(guest.bridge.calls.length, 0);
  host.bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'private-thread', itemId: 'secret', delta: 'DO NOT SHARE' } });
  host.bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'shared-thread', itemId: 'answer', delta: 'Hi Alex!' } });
  await until(() => JSON.stringify(guest.state()).includes('Hi Alex!'));
  assert.ok(!JSON.stringify(guest.state()).includes('DO NOT SHARE'));
  host.send(roomId, 'And Madhavan', 'host-message-1');
  assert.equal(host.rooms.get(roomId).queue.length, 1);
  host.revoke(roomId, guest.identity.id);
  await until(() => guest.remoteRooms.size === 0);
  assert.throws(() => guest.send(roomId, 'No access', 'guest-message-2'), /Disconnected/);
});

test('real TLS: selected-chat images transfer in chunks and revoked or arbitrary file reads are denied', async context => {
  const { host, guest } = await setup(context);
  const directory = mkdtempSync(join(tmpdir(), 'multiplayer-image-network-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'clipboard.png');
  const image = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(420000)]);
  writeFileSync(path, image);
  const originalRequest = host.bridge.request.bind(host.bridge);
  host.bridge.request = (method, params) => method === 'thread/read' ? Promise.resolve({ thread: {
    id: params.threadId, status: { type: 'idle' }, turns: [{ id: 'image-turn', status: 'completed', items: [
      { id: 'image-user', type: 'userMessage', content: [{ type: 'text', text: 'Look' }, { type: 'localImage', path }] },
    ] }],
  } }) : originalRequest(method, params);
  const roomId = await host.share('shared-thread', 'Images');
  const room = host.rooms.get(roomId);
  await assert.rejects(host.requestRoom(room, guest.identity.id, 'multiplayer/image/read', { threadId: room.threadId, imageId: path, offset: 0 }), /access/);
  const invitationId = await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  guest.accept(invitationId, guest.state().invitations[0].code);
  await until(() => guest.remoteRooms.size === 1);
  const result = await guest.nativeRequest(roomId, 'thread/read', { threadId: room.threadId, includeTurns: true });
  const url = result.thread.turns[0].items[0].content[1].url;
  assert.equal(url, `data:image/png;base64,${image.toString('base64')}`);
  assert.ok(!JSON.stringify(result).includes(path));
  await assert.rejects(guest.nativeRequest(roomId, 'multiplayer/image/read', { threadId: room.threadId, imageId: path, offset: 0 }), /unavailable/);
  const events = [];
  guest.on('native-event', event => events.push(event));
  host.bridge.emit('notification', { method: 'item/completed', params: { threadId: room.threadId, turnId: 'image-turn', item: { id: 'live-image', type: 'userMessage', content: [{ type: 'localImage', path }] } } });
  host.bridge.emit('notification', { method: 'turn/completed', params: { threadId: room.threadId, turn: { id: 'image-turn', status: 'completed' } } });
  await until(() => events.length === 2);
  assert.equal(events[0].params.item.content[0].url, url);
  assert.equal(events[1].method, 'turn/completed');
  await host.nativeRequest(roomId, 'turn/start', { threadId: room.threadId, input: [{ type: 'localImage', path }] });
  assert.deepEqual(host.bridge.calls.at(-1).params.input, [{ type: 'localImage', path }]);
  host.bridge.emit('notification', { method: 'turn/completed', params: { threadId: room.threadId, turn: { id: 'turn-one', status: 'completed' } } });
  await assert.rejects(host.requestRoom(room, guest.identity.id, 'turn/start', { threadId: room.threadId, input: [{ type: 'localImage', path }] }), /supports text/);
  await guest.nativeRequest(roomId, 'turn/start', { threadId: room.threadId, input: [{ type: 'text', text: 'Guest photo' }, { type: 'localImage', path }], model: 'must-not-forward' });
  assert.deepEqual(host.bridge.calls.at(-1).params.input, [{ type: 'text', text: 'Guest photo', text_elements: [] }, { type: 'image', url }]);
  assert.equal(host.bridge.calls.at(-1).params.model, undefined);
  const id = room.images.assets.keys().next().value;
  host.revoke(roomId, guest.identity.id);
  await assert.rejects(host.requestRoom(room, guest.identity.id, 'multiplayer/image/read', { threadId: room.threadId, imageId: id, offset: 0 }), /access/);
});

test('typing is membership-scoped metadata and host model follows the accepted room', async context => {
  const { host, guest } = await setup(context);
  const roomId = await host.share('shared-thread', 'Build together');
  const invitationId = await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  assert.equal(guest.state().rooms.length, 0);
  guest.accept(invitationId, guest.state().invitations[0].code);
  await until(() => guest.remoteRooms.size === 1);
  assert.deepEqual(guest.state().rooms[0].execution, { model: 'host-model', reasoningEffort: 'high' });
  guest.setTyping(roomId, true);
  await until(() => host.rooms.get(roomId).snapshot().typing.includes(guest.identity.id));
  assert.equal(host.bridge.calls.filter(call => call.method === 'turn/start').length, 0);
  guest.setTyping(roomId, false);
  await until(() => host.rooms.get(roomId).snapshot().typing.length === 0);
  host.setTyping(roomId, true);
  await until(() => guest.state().rooms[0].typing.includes(host.identity.id));
  host.revoke(roomId, guest.identity.id);
  await until(() => guest.remoteRooms.size === 0);
  guest.setTyping(roomId, true);
  assert.ok(!host.rooms.get(roomId).snapshot().typing.includes(guest.identity.id));
});

test('real TLS: changed certificate identity is rejected', async context => {
  const { host, guest } = await setup(context);
  await assert.rejects(connectPeer({ id: host.identity.id, address: '127.0.0.1', port: guest.port }, host.identity), /identity changed/);
});

test('real TLS: an unavailable advertised address falls back without weakening certificate pinning', async context => {
  const { host, guest } = await setup(context);
  const wire = await connectPeer({ id: guest.identity.id, address: '127.0.0.2', addresses: ['127.0.0.1'], port: guest.port }, host.identity);
  assert.equal(wire.peerId, guest.identity.id);
  wire.close();
  await assert.rejects(connectPeer({ id: host.identity.id, address: '127.0.0.1', addresses: ['127.0.0.2'], port: guest.port }, host.identity), /identity changed/);
});

test('unaccepted invitations expire and declining does not expose the chat', async context => {
  const { host, guest } = await setup(context, { invitationTTL: 200 });
  const roomId = await host.share('shared-thread', 'Build together');
  const invitationId = await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  await until(() => guest.invitations.size === 0);
  assert.throws(() => guest.accept(invitationId, 'anything'), /expired/);
  assert.equal(guest.remoteRooms.size, 0);
  await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  guest.decline(guest.state().invitations[0].id);
  await until(() => host.outgoing.size === 0);
  assert.equal(host.rooms.get(roomId).members.size, 1);
});

test('pairing commitment must be revealed correctly before displaying an invitation', async context => {
  const { host, guest } = await setup(context);
  const wire = await connectPeer({ id: guest.identity.id, address: '127.0.0.1', port: guest.port }, host.identity);
  context.after(() => wire.close());
  wire.send({ type: 'invite', id: 'invitation-one', roomId: 'room-one', name: 'Host', title: 'Shared', commitment: commitment('a'.repeat(64)) });
  await new Promise(resolve => wire.once('message', message => { assert.equal(message.type, 'challenge'); resolve(); }));
  assert.equal(guest.invitations.size, 0);
  wire.send({ type: 'reveal', id: 'invitation-one', nonce: 'b'.repeat(64) });
  await until(() => wire.closed);
  assert.equal(guest.invitations.size, 0);
  assert.equal(guest.remoteRooms.size, 0);
});

test('a guest retains a rejected prompt until the host acknowledges acceptance', async context => {
  const { host, guest } = await setup(context);
  const roomId = await host.share('shared-thread', 'Build together');
  await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  const invitation = guest.state().invitations[0];
  guest.accept(invitation.id, invitation.code);
  await until(() => guest.remoteRooms.size === 1);
  await assert.rejects(guest.send(roomId, 'x'.repeat(24_001), 'too-long-message'), /under 24,000/);
  assert.equal(host.bridge.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('native RPC grants only invited-thread reads and plain prompts, never guest policy overrides', async context => {
  const { host, guest } = await setup(context);
  const roomId = await host.share('shared-thread', 'Build together');
  await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  const invitation = guest.state().invitations[0];
  guest.accept(invitation.id, invitation.code);
  await until(() => guest.remoteRooms.size === 1);
  await assert.rejects(guest.nativeRequest(roomId, 'thread/read', { threadId: 'private-thread' }), /only grants access/);
  await assert.rejects(guest.nativeRequest(roomId, 'command/exec', { threadId: 'shared-thread', command: 'bad' }), /not available/);
  await guest.nativeRequest(roomId, 'thread/resume', { threadId: 'shared-thread', excludeTurns: true, approvalPolicy: 'never', history: ['bad'], path: '/private' });
  assert.deepEqual(host.bridge.calls.at(-1).params, { threadId: 'shared-thread', excludeTurns: true });
  const result = await guest.nativeRequest(roomId, 'turn/start', { threadId: 'shared-thread', input: [{ type: 'text', text: 'Exactly this.' }], clientUserMessageId: 'native-message-id', approvalPolicy: 'never', cwd: '/private', model: 'guest-override' });
  assert.equal(result.turn.id, 'turn-one');
  assert.deepEqual(host.bridge.calls.at(-1).params, { threadId: 'shared-thread', clientUserMessageId: 'native-message-id', input: [{ type: 'text', text: 'Exactly this.', text_elements: [] }] });
  await assert.rejects(guest.nativeRequest(roomId, 'turn/start', { threadId: 'shared-thread', input: [{ type: 'text', text: 'Too soon' }] }), /working/);
  const events = [];
  guest.on('native-event', event => events.push(event));
  host.bridge.emit('notification', { method: 'item/completed', params: { threadId: 'shared-thread', turnId: 'turn-one', item: { type: 'userMessage', id: 'user-one', content: [{ type: 'text', text: 'Exactly this.' }] } } });
  host.bridge.emit('notification', { method: 'item/completed', params: { threadId: 'private-thread', item: { type: 'agentMessage', id: 'secret', text: 'DO NOT SHARE' } } });
  await until(() => events.length === 1);
  assert.equal(events[0].params.item.id, 'user-one');
  assert.equal(guest.state().rooms[0].authors.items['user-one'].id, guest.identity.id);
  assert.equal(guest.bridge.calls.length, 0);
});

test('nearby profiles expose only display metadata, then avatars follow invitations and membership', async context => {
  const { host, guest } = await setup(context);
  const avatar = { initials: 'PA', background: 'rgb(52, 70, 92)', color: '#fff',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' };
  host.setProfile({ name: 'panchangam18', avatar, email: 'private', token: 'private' });
  guest.setProfile({ name: 'alex18', avatar: { initials: 'AL', background: '#123456' } });
  const peer = { id: host.identity.id, name: 'Old name', address: '127.0.0.1', port: host.port };
  guest.peers.set(peer.id, peer);
  await guest.fetchProfile(peer);
  assert.equal(peer.name, 'panchangam18');
  assert.deepEqual(peer.avatar, avatar);
  assert.equal(JSON.stringify(peer).includes('private'), false);
  assert.equal(guest.remoteRooms.size, 0);
  assert.equal(guest.invitations.size, 0);
  assert.equal(host.bridge.calls.length, 0);
  const roomId = await host.share('shared-thread', 'Build together');
  await host.invite(roomId, guest.identity.id);
  await until(() => guest.invitations.size === 1);
  const invitation = guest.state().invitations[0];
  assert.equal(invitation.name, 'panchangam18');
  assert.deepEqual(invitation.avatar, avatar);
  guest.accept(invitation.id, invitation.code);
  await until(() => guest.remoteRooms.size === 1);
  assert.equal(host.rooms.get(roomId).members.get(guest.identity.id).avatar.initials, 'AL');
  guest.setProfile({ name: 'updated-alex', avatar: { initials: 'AX' } });
  await until(() => host.rooms.get(roomId).members.get(guest.identity.id).name === 'updated-alex');
  host.setProfile(null);
  assert.equal(host.name, 'Madhavan');
  assert.equal(host.profileSource, 'fallback');
});
