import { runtime, dom } from '../test/fixtures/native-runtime.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(runtime('Xxxx').o('server-turn', 7), 'server-turn');
assert.equal(runtime('Xxxx').o(null, 7), 'turn-index-7');
assert.equal(runtime('SKhr').j6('server-turn', 'user-message-0'), 'server-turn:user-message-0');
const { TF: RpcTarget, AX: RpcStub } = runtime('Fkn8');
const calls = [], requests = [], notices = [], routes = [];
let releaseHistory;
const historyReady = new Promise(resolve => { releaseHistory = resolve; });
const connectionAtom = {}, routerAtom = {}, scopeType = {};
runtime.c.l00C = { exports: { M4: connectionAtom } };
runtime.c.Dgwo = { exports: { p: routerAtom } };
runtime.c.OWtl = { exports: { u: scopeType } };
class Lease extends RpcTarget { unsubscribe() {} }
class OrdinaryCoordinator extends RpcTarget {
  sendMessage(options) { calls.push(['ordinary-send', options]); return { status: 'sent' }; }
  clearQueuedMessages(id) { calls.push(['ordinary-clear', id]); }
}
class Original extends RpcTarget {
  async subscribe(options) {
    calls.push(['subscribe', options.type, options.field]);
    if (options.field === 'threadSummaryIds') await options.listener({ all: ['ordinary'], topLevel: ['ordinary'] });
    else if (options.type === 'host') await options.listener([]);
    return new Lease();
  }
  async resumeConversation(id) { calls.push(['resumeConversation', id]); return { status: 'ready' }; }
  async sendRequest(method, params) { calls.push([method, params]); return {}; }
  getTurnCoordinator() { return new OrdinaryCoordinator(); }
  markConversationsAsRead(ids) { calls.push(['ordinary-read', ids]); return []; }
}
const original = new RpcStub(new Original());
const router = { forHost: () => original };
let connection = { status: 'connected', client: { hostId: 'local', rpc: original } };
let watching;
const scope = { scope: scopeType, get: atom => atom === connectionAtom ? connection : router,
  set: (atom, key, value) => { assert.equal(atom, connectionAtom); connection = value; },
  watch: callback => { watching = callback; callback({ get: scope.get }); return () => { watching = null; }; } };
window.__multiplayerFixtureScope = scope;
Function(readFileSync(new URL('../renderer/managed.js', import.meta.url), 'utf8'))();
const hostId = 'host-thread', alias = 'guest-alias';
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const thread = { id: hostId, name: 'Shared test', preview: '', cwd: '/shared', createdAt: 1, updatedAt: 1,
  modelProvider: 'openai', source: 'vscode', status: { type: 'idle' }, turns: [{ id: 'turn-one', status: 'completed', items: [
    { id: 'user-one', type: 'userMessage', content: [{ type: 'text', text: 'Hello', text_elements: [] }, { type: 'image', url: imageUrl }] },
    { id: 'agent-one', type: 'agentMessage', text: 'Hi there' },
  ] }] };
const adapter = window.__createMultiplayerManaged({ runtime,
  action: async (type, value) => {
    assert.equal(type, 'native-request');
    requests.push(value);
    if (value.method === 'thread/read') { await historyReady; return { thread }; }
    if (value.method === 'thread/queue/list') return { messages: [] };
    assert.equal(value.method, 'turn/start');
    return { turn: { id: 'new-turn' } };
  },
  send: message => notices.push(message), toast: message => { throw new Error(message); }, navigate: path => routes.push(path) });
const facade = router.forHost('local');
assert.equal(connection.client.rpc, facade);
await facade.resumeConversation('ordinary');
assert.deepEqual(calls.find(call => call[0] === 'resumeConversation'), ['resumeConversation', 'ordinary']);
const state = { self: { id: 'guest' }, rooms: [{ id: alias, threadId: hostId, host: { id: 'host' }, members: [{ id: 'guest' }, { id: 'host' }], active: false,
  execution: { model: 'host-model', reasoningEffort: 'high' } }] };
adapter.update(state);
adapter.event({ roomId: alias, method: 'thread/status/changed', params: { threadId: hostId, status: { type: 'idle' } } });
releaseHistory();
await new Promise(resolve => setTimeout(resolve, 30));
assert.deepEqual(routes, [`/local/${alias}`]);
assert.equal((await facade.resumeConversation({ conversationId: alias })).status, 'ready');
const conversation = await facade.getConversation(alias);
assert.equal(conversation.id, alias);
assert.equal(conversation.turns.length, 1);
assert.ok(conversation.turns[0].params.input.some(part => part.type === 'image' && part.url === imageUrl));
const activeLease = await facade.retainActiveConversation(alias);
const followUp = await facade.getFollowUpContext(alias, true);
assert.equal(followUp.latestCollaborationMode.settings.model, 'host-model');
assert.equal(followUp.latestCollaborationMode.settings.reasoning_effort, 'high');
assert.equal(followUp.resumeState, 'resumed');
await facade.markConversationAsUnread(alias);
assert.equal(await facade.getThreadHasUnreadTurn(alias), true);
await facade.markConversationAsRead(alias);
assert.equal(await facade.getThreadHasUnreadTurn(alias), false);
assert.equal((await facade.getConversation(alias)).hasUnreadTurn, false);
adapter.viewed(alias);
await facade.recordUnreadMessage(alias);
assert.equal(await facade.getThreadHasUnreadTurn(alias), false);
adapter.viewed(null);
await facade.recordUnreadMessage(alias);
assert.equal(await facade.getThreadHasUnreadTurn(alias), true);
adapter.viewed(alias);
assert.equal(await facade.getThreadHasUnreadTurn(alias), false);
adapter.viewed(null);
await facade.markConversationAsUnread(alias);
assert.deepEqual(await facade.markConversationsAsRead([alias, 'ordinary']), []);
assert.equal(await facade.getThreadHasUnreadTurn(alias), false);
assert.deepEqual(calls.find(call => call[0] === 'ordinary-read'), ['ordinary-read', ['ordinary']]);
assert.equal(calls.filter(call => call[0] === 'resumeConversation').length, 1);
const values = [];
const subscription = await facade.subscribe({ type: 'host', key: { hostId: 'local' }, field: 'threadSummaryIds', listener: value => values.push(value) });
await new Promise(resolve => setTimeout(resolve, 20));
assert.deepEqual(values.at(-1).all, [alias, 'ordinary']);
const transcriptValues = [];
const transcriptLease = await facade.subscribe({ type: 'conversation', key: { hostId: 'local', threadId: alias }, listener: value => transcriptValues.push(value) });
assert.ok(JSON.stringify(transcriptValues).includes('Hi there'));
for (const field of ['resumeState', 'summary', 'listState', 'metadata']) {
  const updates = [];
  const lease = await facade.subscribe({ type: 'thread', key: { hostId: 'local', threadId: alias }, field, listener: value => updates.push(value) });
  assert.equal(updates.length, 1, field);
  lease[Symbol.dispose]();
}
await facade.getTurnCoordinator().sendMessage({ conversationId: 'ordinary', message: { text: 'Unshared' } });
await facade.getTurnCoordinator().clearQueuedMessages('ordinary');
assert.equal(calls.filter(call => call[0] === 'ordinary-send').length, 1);
assert.equal(calls.filter(call => call[0] === 'ordinary-clear').length, 1);
await assert.rejects(async () => await facade.getTurnCoordinator().clearQueuedMessages(alias), /unavailable/);
await assert.rejects(async () => await facade.archiveConversation({ request: { threadId: alias } }), /unavailable/);
await assert.rejects(async () => await facade.getTurnCoordinator().sendMessage({ conversationId: alias, message: { text: 'Attachment', context: { fileAttachments: ['file'] } } }), /unavailable/);
const result = await facade.getTurnCoordinator().sendMessage({ conversationId: alias, message: { id: 'native-message-id', text: 'Collaborative hello', context: { prompt: 'Collaborative hello' } } }, () => {}, () => {}, () => {}, () => {});
assert.equal(result.status, 'sent');
assert.equal(requests.at(-1).params.threadId, hostId);
assert.equal(requests.at(-1).params.clientUserMessageId, 'native-message-id');
await facade.getTurnCoordinator().sendMessage({ conversationId: alias, message: { id: 'native-image-id', text: 'Photo', context: { prompt: 'Photo', imageAttachments: [{ src: 'preview', localPath: '/guest/clipboard.png' }] } } }, () => {}, () => {}, () => {}, () => {});
assert.deepEqual(requests.at(-1).params.input, [{ type: 'text', text: 'Photo', text_elements: [] }, { type: 'localImage', path: '/guest/clipboard.png' }]);
assert.equal(requests.at(-1).params.clientUserMessageId, 'native-image-id');
adapter.event({ roomId: alias, method: 'turn/started', params: { threadId: hostId, turn: { id: 'new-turn', status: 'inProgress', items: [] } } });
adapter.viewed(alias);
adapter.event({ roomId: alias, method: 'item/started', params: { threadId: hostId, turnId: 'new-turn', item: { id: 'new-agent', type: 'agentMessage', text: '' } } });
adapter.event({ roomId: alias, method: 'item/agentMessage/delta', params: { threadId: hostId, turnId: 'new-turn', itemId: 'new-agent', delta: 'Streamed answer' } });
adapter.event({ roomId: alias, method: 'item/completed', params: { threadId: hostId, turnId: 'new-turn', item: { id: 'new-agent', type: 'agentMessage', text: 'Streamed answer' } } });
adapter.event({ roomId: alias, method: 'turn/completed', params: { threadId: hostId, turn: { id: 'new-turn', status: 'completed', items: [] } } });
assert.equal(await facade.getThreadHasUnreadTurn(alias), false);
assert.ok(JSON.stringify(await facade.getConversation(alias)).includes('Streamed answer'));
await new Promise(resolve => setTimeout(resolve, 40));
assert.ok(JSON.stringify(transcriptValues).includes('Streamed answer'));
await facade.startTurnWithOutcome({ request: { threadId: alias, input: [{ type: 'text', text: 'Nested send', text_elements: [] }] } });
assert.equal(requests.at(-1).params.threadId, hostId);
adapter.update({ ...state, rooms: [] });
await assert.rejects(async () => await facade.resumeConversation(alias), /disconnected/);
await assert.rejects(async () => await facade.startTurn({ request: { threadId: alias, input: [{ type: 'text', text: 'After revocation' }] } }), /disconnected/);
assert.ok(!JSON.stringify(calls).includes(alias), 'Guest identifiers must never reach the local main-process service');
transcriptLease[Symbol.dispose]();
activeLease[Symbol.dispose]();
subscription[Symbol.dispose]();
adapter.cleanup();
assert.equal(router.forHost('local'), original);
assert.equal(connection.client.rpc, original);
assert.equal(watching, null);
original[Symbol.dispose]();
dom.window.close();
console.log('Actual native-manager adapter smoke passed');
