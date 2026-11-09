import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Room } from '../src/rooms.mjs';

export class FakeBridge extends EventEmitter {
  constructor() { super(); this.calls = []; this.turn = 0; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] } };
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'completed', items: [
      { id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'Original private history' }] },
      { id: 'old-agent', type: 'agentMessage', text: 'Original response' },
    ] }] };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turn}` } };
    throw new Error(`Unknown method ${method}`);
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
test('five-person limit includes host, permits profile updates, and frees removed places', () => {
  const room = makeRoom();
  for (let index = 1; index <= 4; index++) room.join({ id: `guest-${index}`, name: `Guest ${index}` });
  assert.equal(room.snapshot().maxMembers, 5);
  assert.throws(() => room.join({ id: 'sixth', name: 'Sixth' }), /full/);
  room.join({ id: 'guest-1', name: 'Updated' });
  assert.equal(room.members.size, 5);
  room.remove('guest-2');
  room.join({ id: 'sixth', name: 'Sixth' });
  assert.equal(room.members.size, 5);
  room.close();
});
function makeRoom(bridge = new FakeBridge()) {
  return new Room({ threadId: 'thread-one', title: 'Build together', host: { id: 'host', name: 'Madhavan' }, bridge });
}

test('typing expires, clears on submit/removal, and never contains draft text', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const room = makeRoom();
  room.join({ id: 'guest', name: 'Alex' });
  room.setTyping('guest', true);
  assert.deepEqual(room.snapshot().typing, ['guest']);
  context.mock.timers.tick(5001);
  assert.deepEqual(room.snapshot().typing, []);
  room.setTyping('guest', true);
  await room.submit('guest', { id: 'typing-send', text: 'Submitted only now' });
  assert.deepEqual(room.snapshot().typing, []);
  room.setTyping('guest', true);
  room.remove('guest');
  assert.deepEqual(room.snapshot().typing, []);
  assert.throws(() => room.setTyping('guest', true), /access/);
  room.close();
});

test('two people share one ordered thread with server-owned authors', async () => {
  const room = makeRoom();
  await room.initialize();
  room.join({ id: 'guest', name: 'Alex' });
  room.submit('host', { id: 'message-1', text: 'First' });
  room.submit('guest', { id: 'message-2', text: 'Second', author: { name: 'Madhavan' } });
  room.submit('guest', { id: 'message-2', text: 'Second' });
  await tick();
  assert.equal(room.bridge.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(room.queue.length, 1);
  assert.equal(room.messages.at(-1).author.name, 'Alex');
  room.notification('turn/completed', { threadId: room.threadId, turn: { id: 'turn-1', status: 'completed' } });
  await tick();
  const turns = room.bridge.calls.filter(call => call.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.ok(turns.every(call => call.params.threadId === room.threadId));
  assert.equal(turns[1].params.input[0].text, 'Second');
  assert.equal(room.messages.filter(message => message.role === 'user').length, 3);
});

test('a completion notification before the RPC reply cannot stall the queue', async () => {
  const bridge = new FakeBridge();
  const original = bridge.request.bind(bridge);
  const room = makeRoom(bridge);
  bridge.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') room.notification('turn/completed', { threadId: room.threadId, turn: result.turn });
    return result;
  };
  room.submit('host', { id: 'message-1', text: 'One' });
  room.submit('host', { id: 'message-2', text: 'Two' });
  await tick();
  assert.equal(bridge.turn, 2);
  assert.equal(room.active, null);
});

test('unrelated thread events do not leak and streaming output converges', () => {
  const room = makeRoom();
  room.notification('item/agentMessage/delta', { threadId: 'private', itemId: 'secret', delta: 'private' });
  assert.equal(room.messages.length, 0);
  room.notification('item/agentMessage/delta', { threadId: room.threadId, turnId: 'turn', itemId: 'answer', delta: 'Hello' });
  room.notification('item/agentMessage/delta', { threadId: room.threadId, turnId: 'turn', itemId: 'answer', delta: ' team' });
  room.notification('item/completed', { threadId: room.threadId, turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Hello team!' } });
  assert.equal(room.messages.length, 1);
  assert.equal(room.messages[0].text, 'Hello team!');
});

test('revocation cancels queued work and rejects further prompts', async () => {
  const room = makeRoom();
  room.join({ id: 'guest', name: 'Alex' });
  room.submit('host', { id: 'message-1', text: 'Working' });
  room.submit('guest', { id: 'message-2', text: 'Queued' });
  room.remove('guest');
  await tick();
  assert.equal(room.queue.length, 0);
  assert.equal(room.messages.at(-1).status, 'cancelled');
  assert.throws(() => room.submit('guest', { id: 'message-3', text: 'Forbidden' }), /access/);
  room.close();
  assert.throws(() => room.submit('host', { id: 'message-4', text: 'Late' }), /access/);
});

test('turn errors stop queued work instead of retrying an uncertain request', async () => {
  const room = makeRoom({ request: async () => { throw new Error('Timed out'); } });
  room.submit('host', { id: 'message-1', text: 'One' });
  room.submit('host', { id: 'message-2', text: 'Two' });
  await tick();
  assert.equal(room.messages[0].status, 'failed');
  assert.equal(room.messages[1].status, 'cancelled');
  assert.equal(room.queue.length, 0);
});

test('existing author attribution survives reloading, and new shares wait for idle', async () => {
  const bridge = new FakeBridge();
  const room = new Room({ threadId: 'thread-one', host: { id: 'host', name: 'Madhavan' }, bridge,
    attribution: { 'old-turn': { id: 'guest', name: 'Alex' } } });
  await room.initialize();
  assert.equal(room.messages[0].author.name, 'Alex');
  bridge.request = async () => ({ thread: { id: 'thread-one', status: { type: 'active' } } });
  await assert.rejects(makeRoom(bridge).initialize(), /current turn/);
});
