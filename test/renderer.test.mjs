import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(context, { rspack = false } = {}) {
  const dom = new JSDOM(read('./fixtures/desktop.html'), { url: 'https://codex.local/local/fixture-thread', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  context.after(() => { window.__multiplayerCodex?.cleanup(); window.close(); });
  window.performance.getEntriesByType = () => [];
  const composer = window.document.querySelector('[data-codex-composer-root]');
  composer.getClientRects = () => [{ width: 500, height: 100 }];
  composer.getBoundingClientRect = () => ({ left: 100, top: 500, width: 500, height: 100 });
  const actions = [];
  window.__multiplayerSend = value => actions.push(JSON.parse(value));
  window.eval(read('./fixtures/native-host.js'));
  window.eval(read('../renderer/profile.js'));
  window.__multiplayerFixtureExports = {
    proxy: new Proxy({}, { get: () => () => {}, set: () => { throw new Error('Cannot assign RPC stub properties'); } }),
    ...window.__multiplayerFixtureExports,
  };
  if (rspack) {
    const { bus, transport } = window.__multiplayerFixtureExports;
    const runtime = () => { throw new Error('Must reuse cached modules without executing factories'); };
    runtime.c = { TL6G: { exports: { O1: bus } }, SITX: { exports: { F: transport } } };
    window.__multiplayerFixtureExports = { __webpack_require__: runtime };
  }
  window.eval(read('../renderer/managed.js'));
  window.eval(read('../renderer/presence.js'));
  window.eval(read('../renderer/native.js'));
  window.eval(read('../renderer/multiplayer.js'));
  if (!window.__multiplayerCodex) window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await window.__multiplayerCodex.ready;
  return { window, actions, shadow: window.document.querySelector('#multiplayer-codex').shadowRoot };
}
const base = { self: { id: 'host', name: 'Madhavan Panchangam' }, rooms: [], peers: [], invitations: [], outgoing: [] };
const room = { id: 'room-one', threadId: 'fixture-thread', title: 'Build together', host: base.self,
  thread: { id: 'fixture-thread', name: 'Build together' },
  members: [base.self, { id: 'guest', name: 'Alex Smith' }], messages: [],
  authors: { turns: {}, items: { 'history-user': { id: 'guest', name: 'Alex Smith' } } } };
const reply = (window, action, result = {}) => window.__multiplayerCodex.receive({ type: 'result', value: { id: action.id, result } });

test('typing bubbles send no draft text, respect routes, and restore the host-controlled model selector', async context => {
  const { window, actions } = await setup(context);
  const composer = window.document.querySelector('[data-codex-composer-root]');
  const model = window.document.createElement('button');
  model.setAttribute('aria-label', 'Select model');
  model.textContent = 'Guest default';
  composer.append(model);
  const shared = { ...room, typing: ['host'], execution: { model: 'host-model', reasoningEffort: 'high' } };
  window.history.replaceState(null, '', '/local/room-one');
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, self: room.members[1], rooms: [shared] } });
  assert.match(window.document.querySelector('.multiplayer-live').textContent, /Madhavan Panchangam is typing/);
  assert.equal(model.getAttribute('data-multiplayer-model'), 'host-model · high · Host');
  assert.equal(model.getAttribute('aria-disabled'), 'true');
  const editor = composer.querySelector('textarea');
  editor.value = 'This draft must never be transmitted';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  const typing = actions.find(action => action.type === 'typing' && action.active);
  assert.equal(typing.roomId, room.id);
  assert.ok(!JSON.stringify(typing).includes(editor.value));
  window.history.replaceState(null, '', '/local/unrelated');
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, self: room.members[1], rooms: [shared] } });
  assert.equal(window.document.querySelector('.multiplayer-live'), null);
  assert.equal(model.getAttribute('aria-label'), 'Select model');
  assert.equal(model.hasAttribute('data-multiplayer-model'), false);
  assert.equal(model.textContent, 'Guest default');
  assert.equal(actions.filter(action => action.type === 'typing').at(-1).active, false);
});

test('typing uses a right-aligned dots bubble with a larger pastel-ringed native avatar', async context => {
  const { window } = await setup(context);
  const member = { ...room.members[1], avatar: { initials: 'AX', background: '#123456', color: '#ffffff' } };
  const shared = { ...room, members: [base.self, member], typing: ['guest'] };
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [shared] } });
  update();
  const surface = window.document.querySelector('.multiplayer-live');
  const bubble = surface.querySelector('.multiplayer-typing');
  let avatar = bubble.querySelector('.multiplayer-typing-avatar');
  assert.equal(window.getComputedStyle(surface).alignItems, 'flex-end');
  assert.equal(surface.style.left, '100px');
  assert.equal(surface.style.width, '500px');
  assert.equal(bubble.querySelectorAll('.multiplayer-dots i').length, 3);
  assert.equal(window.getComputedStyle(bubble.querySelector('.multiplayer-typing-label')).clipPath, 'inset(50%)');
  assert.equal(avatar.title, 'Alex Smith');
  assert.equal(window.getComputedStyle(avatar).width, '28px');
  assert.equal(window.getComputedStyle(avatar).right, '-14px');
  assert.equal(window.getComputedStyle(avatar).bottom, '-14px');
  assert.equal(avatar.style.borderColor, window.document.querySelector('.multiplayer-message-avatar').style.borderColor);
  assert.ok(['#a8c7fa', '#b5dbc2', '#d3bbed', '#f0cab0', '#edbfd3', '#add8df'].includes(window.__multiplayerParticipantColor(member)));
  member.avatar = { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' };
  update();
  avatar = surface.querySelector('.multiplayer-typing-avatar');
  assert.equal(avatar.querySelector('img').src, member.avatar.image);
  assert.equal(avatar.style.position, 'absolute');
  shared.typing = [];
  shared.messages = [{ status: 'sending', author: member }];
  update();
  assert.match(surface.textContent, /Alex Smith is sending/);
  shared.messages = [];
  update();
  assert.equal(surface.isConnected, false);
  shared.typing = ['guest'];
  update();
  window.__multiplayerCodex.cleanup();
  assert.equal(surface.isConnected, false);
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(surface.isConnected, false);
});

test('invite shows connecting immediately, puts failures inside the sheet, permits retry, and closes with Done', async context => {
  const { window, shadow, actions } = await setup(context);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, peers: [room.members[1]], rooms: [{ ...room, members: [base.self] }] } });
  window.document.querySelector('[data-app-action-sidebar-thread-row]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  shadow.querySelector('.person').click();
  assert.match(shadow.querySelector('.person').textContent, /Connecting/);
  assert.equal(shadow.querySelector('.person').disabled, true);
  shadow.querySelector('.person').click();
  assert.equal(actions.filter(action => action.type === 'invite').length, 1);
  const action = actions.find(action => action.type === 'invite');
  window.__multiplayerCodex.receive({ type: 'result', value: { id: action.id, error: 'Could not reach this computer. Check Wi-Fi.' } });
  await tick();
  assert.match(shadow.querySelector('.sheet-body .sheet-notice').textContent, /Check Wi-Fi/);
  assert.equal(shadow.querySelector('.toast'), null);
  assert.equal(shadow.querySelector('.person').disabled, false);
  shadow.querySelector('.person').click();
  const retry = actions.filter(action => action.type === 'invite').at(-1);
  reply(window, retry);
  await tick();
  assert.equal(shadow.querySelector('.sheet-notice'), null);
  assert.equal([...shadow.querySelectorAll('button')].some(button => button.textContent === 'Cancel'), false);
  [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Done').click();
  assert.equal(shadow.querySelector('[role="dialog"]'), null);
});

test('unrecognized host-managed builds fail closed instead of opening a guest alias locally', async context => {
  await assert.rejects(setup(context, { rspack: true }), /Unsupported Codex build: missing native module/);
});

test('right-click extends original native menu; double-click still renames', async context => {
  const { window, actions, shadow } = await setup(context);
  window.__multiplayerCodex.receive({ type: 'state', value: base });
  const row = window.document.querySelector('[data-app-action-sidebar-thread-row]');
  row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(window.fixtureRenamed, 1);
  assert.equal(actions.filter(action => action.type === 'share').length, 0);
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();
  const menu = window.fixtureMenus[0];
  assert.deepEqual(Array.from(menu, item => item.label), ['Rename', 'Multiplayer', 'Share chat', 'Archive']);
  assert.equal(menu[3].enabled, false);
  assert.match(menu[1].icon, /^data:image\/svg\+xml;utf8,/);
  const icon = new window.DOMParser().parseFromString(decodeURIComponent(menu[1].icon.split(',')[1]), 'image/svg+xml');
  assert.equal(icon.querySelector('parsererror'), null);
  assert.equal(icon.documentElement.getAttribute('viewBox'), '0 0 20 20');
  const request = actions.find(action => action.type === 'share');
  assert.equal(request.threadId, 'fixture-thread');
  assert.match(shadow.textContent, /No People Found/);
  assert.match(shadow.textContent, /As Madhavan Panchangam/);
  reply(window, request, { roomId: 'room-one' });
  window.fixtureMenuChoice = 'rename';
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  assert.equal(window.fixtureRenamed, 2);
  window.fixtureMenuChoice = 'share-thread';
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  assert.equal(window.fixtureShared, true);
});

test('menus without Share retain their items and append Multiplayer with its icon', async context => {
  const { window } = await setup(context);
  const row = window.document.querySelector('[data-app-action-sidebar-thread-row]');
  const existing = [{ id: 'rename', label: 'Rename' }];
  row.__reactFiber$fixture.return.memoizedProps.getItems = () => existing;
  window.fixtureMenuChoice = 'rename';
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  assert.deepEqual(Array.from(window.fixtureMenus[0], item => item.id), ['rename', 'multiplayer-separator', 'multiplayer-share']);
  assert.equal(existing.length, 1);
  assert.match(window.fixtureMenus[0].at(-1).icon, /^data:image\/svg\+xml;utf8,/);
});

test('share sheet is unbranded and disables new invitations at five including pending places', async context => {
  const { window, shadow } = await setup(context);
  const guests = Array.from({ length: 5 }, (_, index) => ({ id: `peer-${index}`, name: `Person ${index}` }));
  const shared = { ...room, maxMembers: 5, members: [base.self, ...guests.slice(0, 3)] };
  const state = { ...base, peers: guests, rooms: [shared], outgoing: [{ roomId: room.id, peerId: guests[3].id, status: 'waiting', name: guests[3].name, code: '123456' }] };
  window.__multiplayerCodex.receive({ type: 'state', value: state });
  window.document.querySelector('[data-app-action-sidebar-thread-row]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  assert.equal(shadow.querySelector('.identity-mark,.chat-preview'), null);
  assert.equal(shadow.querySelectorAll('.person').length, 2);
  assert.equal(shadow.querySelectorAll('.member').length, 3);
  assert.match(shadow.querySelector('.capacity').textContent, /4 \/ 5 people.*1 invited/);
  assert.equal(shadow.querySelector('[data-peer-id="peer-4"]').disabled, true);
  assert.match(shadow.querySelector('[data-peer-id="peer-4"]').textContent, /Chat full/);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...state, outgoing: [] } });
  assert.equal(shadow.querySelector('[data-peer-id="peer-4"]').disabled, false);
});

test('reads only the native footer identity and reuses its exact initials and colors', async context => {
  const { window, shadow } = await setup(context);
  const button = window.document.createElement('button');
  const initial = window.document.createElement('span');
  initial.textContent = 'PA';
  initial.style.cssText = 'background:rgb(52,70,92);color:rgb(255,255,255)';
  button.append(initial);
  button.__reactFiber$fixture = { return: { memoizedProps: { sidebarFooter: { profileIdentity: {
    username: 'panchangam18', displayName: 'Different display name', profileImageUrl: 'https://private.invalid/avatar?token=never-forward', email: 'never-forward@example.com',
  } } } } };
  window.document.querySelector('aside').append(button);
  const profile = window.__readMultiplayerProfile();
  assert.equal(profile.name, 'panchangam18');
  assert.equal(profile.avatar.initials, 'PA');
  assert.equal(profile.avatar.background, 'rgb(52, 70, 92)');
  assert.equal(JSON.stringify(profile).includes('never-forward'), false);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, self: { id: 'host', ...profile }, invitations: [{ id: 'invite', title: 'Chat', name: 'Alex', code: '123456' }] } });
  const avatar = shadow.querySelector('.sheet-header .avatar');
  assert.ok(avatar.textContent.startsWith('PA'));
  assert.equal(avatar.style.background, 'rgb(52, 70, 92)');
  button.remove();
  assert.equal(window.__readMultiplayerProfile(), null);
});

test('native modern avatar colors survive transfer without becoming the generated fallback', async context => {
  const { window } = await setup(context);
  const footer = window.document.querySelector('aside');
  const unrelated = window.document.createElement('button');
  const button = window.document.createElement('button');
  button.innerHTML = '<span class="text-avatar-foreground"><svg><text>MA</text></svg></span>';
  const initial = button.firstElementChild;
  const identity = { return: { memoizedProps: { sidebarFooter: { profileIdentity: { username: 'actual-username' } } } } };
  unrelated.__reactFiber$fixture = identity;
  button.__reactFiber$fixture = identity;
  footer.append(unrelated, button);
  const computedStyle = window.getComputedStyle;
  window.getComputedStyle = node => node === initial ? { color: 'rgb(255, 255, 255)', backgroundColor: 'color(srgb 0.2 0.4 0.6)' } : computedStyle(node);
  window.CSS = { supports: () => true };
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, getImageData: () => ({ data: [51, 102, 153, 255] }) });
  const profile = window.__readMultiplayerProfile();
  assert.equal(profile.avatar.initials, 'MA');
  assert.equal(profile.avatar.background, 'rgb(51, 102, 153)');
  const transferred = JSON.parse(JSON.stringify(profile));
  const avatar = window.document.createElement('span');
  window.__applyMultiplayerAvatar(avatar, transferred);
  assert.equal(avatar.textContent, 'MA');
  assert.equal(avatar.style.background, 'rgb(51, 102, 153)');
  assert.equal(avatar.style.color, 'rgb(255, 255, 255)');
  assert.equal(window.__multiplayerParticipantColor({ id: 'stable-peer', name: 'Old' }), window.__multiplayerParticipantColor({ id: 'stable-peer', name: 'New' }));
});

test('copies the actual profile photo after an anonymous CORS retry without sharing its URL', async context => {
  const { window } = await setup(context);
  const button = window.document.createElement('button');
  const image = window.document.createElement('img');
  image.src = 'https://avatar.example/profile.png';
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 64 } });
  button.append(image);
  button.__reactFiber$fixture = { memoizedProps: { sidebarFooter: { profileIdentity: { username: 'photo-user' } } } };
  window.document.querySelector('aside').append(button);
  let retry;
  window.Image = class { constructor() { retry = this; } };
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage(source) { if (source === image) throw new window.DOMException('Tainted canvas', 'SecurityError'); } });
  window.HTMLCanvasElement.prototype.toDataURL = () => png;
  assert.equal(window.__readMultiplayerProfile().avatar.image, undefined);
  assert.equal(retry.crossOrigin, 'anonymous');
  assert.equal(retry.referrerPolicy, 'no-referrer');
  assert.equal(retry.src, image.src);
  retry.onload();
  const profile = window.__readMultiplayerProfile();
  assert.equal(profile.avatar.image, png);
  assert.ok(!JSON.stringify(profile).includes('avatar.example'));
  const badge = window.document.createElement('span');
  window.__applyMultiplayerAvatar(badge, profile);
  assert.equal(badge.querySelector('img').src, png);
});

test('decorates existing bubbles and sidebar without replacing or hiding native composer', async context => {
  const { window, shadow } = await setup(context);
  const composer = window.fixtureComposerNode;
  const bubble = window.document.querySelector('[data-local-conversation-user-anchor]');
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [room] } });
  assert.equal(window.document.querySelector('#native-composer'), composer);
  assert.equal(composer.style.visibility, '');
  assert.equal(Boolean(composer.inert), false);
  assert.equal(shadow.querySelector('textarea, .chat, .timeline, .dock'), null);
  assert.equal(window.document.querySelector('.multiplayer-initial').textContent, 'AS');
  assert.equal(bubble.getAttribute('data-multiplayer-author'), 'Alex Smith');
  assert.ok(bubble.textContent.startsWith('Let’s make onboarding feel a little more human.'));
  const avatar = bubble.querySelector('.multiplayer-message-avatar');
  assert.equal(avatar.textContent, 'AS');
  assert.equal(avatar.style.position, 'absolute');
  assert.equal(avatar.getAttribute('aria-label'), 'Alex Smith · Sent this message');
  window.__multiplayerCodex.cleanup();
  assert.equal(bubble.hasAttribute('data-multiplayer-author'), false);
  assert.equal(window.document.querySelector('.multiplayer-presence'), null);
  assert.equal(window.document.querySelector('.multiplayer-message-avatar'), null);
  assert.equal(window.document.querySelector('#native-composer'), composer);
});

test('avatar overlays the native bubble corner without a label, highlight, or layout expansion', async context => {
  const { window } = await setup(context);
  const anchor = window.document.querySelector('[data-local-conversation-user-anchor]');
  const bubble = anchor.querySelector('[data-user-message-bubble]');
  anchor.getBoundingClientRect = () => ({ left: 100, top: 200, right: 900, bottom: 500 });
  let bounds = { left: 800, top: 210, right: 880, bottom: 250 };
  bubble.getBoundingClientRect = () => bounds;
  const nativeBubble = bubble.outerHTML;
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [room] } });
  update();
  const avatar = anchor.querySelector('.multiplayer-message-avatar');
  assert.equal(avatar.parentElement, anchor);
  assert.equal(avatar.style.left, '766px');
  assert.equal(avatar.style.top, '36px');
  assert.equal(window.getComputedStyle(avatar).width, '28px');
  assert.equal(avatar.title, 'Alex Smith');
  assert.equal(bubble.outerHTML, nativeBubble);
  assert.ok(!anchor.textContent.includes('Alex Smith'));
  const styling = [...window.document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const rule = styling.find(rule => rule.selectorText === '[data-multiplayer-author]');
  assert.equal(rule.style.cssText, 'position: relative;');
  assert.ok(!styling.some(rule => rule.selectorText === '[data-multiplayer-author]::before'));
  bounds = { ...bounds, right: 820, bottom: 280 };
  window.dispatchEvent(new window.Event('resize'));
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  assert.equal(avatar.style.left, '706px');
  assert.equal(avatar.style.top, '66px');
  window.__multiplayerCodex.cleanup();
  assert.equal(bubble.outerHTML, nativeBubble);
  assert.equal(anchor.querySelector('.multiplayer-message-avatar'), null);
});

test('message avatars reuse native identity, remain stable, and never decorate own messages', async context => {
  const { window } = await setup(context);
  const bubble = window.document.querySelector('[data-local-conversation-user-anchor]');
  const member = { ...room.members[1], avatar: { initials: 'AX', background: '#123456', color: '#ffffff' } };
  const shared = { ...room, members: [base.self, member] };
  const update = rooms => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms } });
  update([shared]);
  const avatar = bubble.querySelector('.multiplayer-message-avatar');
  assert.equal(avatar.textContent, 'AX');
  assert.equal(avatar.style.background, 'rgb(18, 52, 86)');
  update([shared]);
  assert.equal(bubble.querySelector('.multiplayer-message-avatar'), avatar);
  update([{ ...shared, authors: { items: { 'history-user': base.self } } }]);
  assert.equal(bubble.querySelector('.multiplayer-message-avatar'), null);
  assert.equal(bubble.hasAttribute('data-multiplayer-author'), false);
  update([{ ...shared, members: [base.self] }]);
  assert.equal(bubble.querySelector('.multiplayer-message-avatar').textContent, 'AS');
  update([]);
  assert.equal(bubble.querySelector('.multiplayer-message-avatar'), null);
  assert.equal(bubble.textContent, 'Let’s make onboarding feel a little more human.');
});

test('message attribution skips partial native props and reads the anchor React children', async context => {
  const { window } = await setup(context);
  const anchor = window.document.querySelector('[data-local-conversation-user-anchor]');
  const fullProps = anchor.__reactFiber$fixture.memoizedProps.children.props.children[0].props;
  const partial = { item: fullProps.item };
  anchor.__reactFiber$fixture = { memoizedProps: partial };
  const child = window.document.createElement('span');
  child.__reactFiber$fixture = { memoizedProps: partial, return: { memoizedProps: fullProps } };
  anchor.append(child);
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [room] } });
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  child.remove();
  anchor.__reactFiber$fixture = { memoizedProps: { children: { props: { children: [{ props: fullProps }] } } } };
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  const nativeMarkup = anchor.innerHTML.replace(/<span class="multiplayer-message-avatar".*?<\/span>/, '');
  window.__multiplayerCodex.cleanup();
  assert.equal(anchor.innerHTML, nativeMarkup);
  assert.equal(anchor.hasAttribute('data-multiplayer-author'), false);
  assert.equal(window.document.querySelector('[class^="multiplayer-"]'), null);
});

test('primary messages without item IDs use the native turn identity, including composite tool keys', async context => {
  const { window } = await setup(context);
  const anchor = window.document.querySelector('[data-local-conversation-user-anchor]');
  const props = { item: { type: 'user-message', message: 'Unchanged' }, conversationId: room.threadId };
  const shared = { ...room, authors: { items: {}, turns: { 'server-turn': room.members[1] } } };
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [shared] } });
  anchor.__reactFiber$fixture = { memoizedProps: { children: { props } }, return: { memoizedProps: { conversationId: room.threadId, turnId: 'server-turn' } } };
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  anchor.__reactFiber$fixture = { memoizedProps: { children: { props: { ...props, toolActivityTurnKey: `${room.threadId}\0server-turn` } } } };
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  shared.authors.turns['server-turn'] = base.self;
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar'), null);
});

test('native search keys resolve primary message senders only within their shared conversation', async context => {
  const { window, actions } = await setup(context);
  const anchor = window.document.querySelector('[data-local-conversation-user-anchor]');
  const props = { item: { type: 'user-message' }, conversationId: room.threadId };
  anchor.setAttribute('data-content-search-unit-key', 'server-turn:user-message-0');
  anchor.__reactFiber$fixture = { memoizedProps: { children: { props } } };
  const shared = { ...room, authors: { items: {}, turns: { 'server-turn': room.members[1] } } };
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [shared] } });
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  assert.equal(actions.filter(action => action.type === 'decoration-diagnostics').at(-1).summary.turnMatches, 1);
  props.conversationId = 'unshared-fork-with-the-same-turn';
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar'), null);
  props.conversationId = room.threadId;
  anchor.setAttribute('data-content-search-unit-key', 'server-turn-other:user-message-0');
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar'), null);
  anchor.__reactFiber$fixture = { memoizedProps: { conversationId: room.threadId, turn: { turnId: 'server-turn' } } };
  update();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  window.__multiplayerCodex.cleanup();
  assert.equal(anchor.querySelector('.multiplayer-message-avatar'), null);
  assert.equal(anchor.hasAttribute('data-multiplayer-author'), false);
});

test('server-received user messages without primary anchors get avatars, but agent and unattributed items do not', async context => {
  const { window } = await setup(context);
  const bubble = window.document.querySelector('[data-local-conversation-user-anchor]');
  bubble.removeAttribute('data-local-conversation-user-anchor');
  bubble.setAttribute('data-content-search-unit-key', 'shared-turn:remote-user');
  const props = { conversationId: room.threadId, item: { type: 'user-message', searchItemId: 'remote-user', steeringStatus: 'accepted' } };
  const turnFiber = { memoizedProps: { conversationId: room.threadId, turnId: 'shared-turn' } };
  bubble.__reactFiber$fixture = { memoizedProps: { children: { props } }, return: turnFiber };
  const agent = window.document.querySelector('.native-agent');
  agent.setAttribute('data-content-search-unit-key', 'shared-turn:agent-answer');
  agent.__reactFiber$fixture = { memoizedProps: { children: { props: { conversationId: room.threadId, item: { type: 'assistant-message' } } } }, return: turnFiber };
  const shared = { ...room, authors: { items: { 'remote-user': room.members[1] }, turns: { 'shared-turn': room.members[1] } } };
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [shared] } });
  update();
  assert.equal(bubble.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  assert.equal(agent.querySelector('.multiplayer-message-avatar'), null);
  props.item.searchItemId = 'unattributed-message-in-the-same-turn';
  update();
  assert.equal(bubble.querySelector('.multiplayer-message-avatar'), null);
  props.item.searchItemId = 'remote-user';
  props.conversationId = 'unshared-chat';
  update();
  assert.equal(bubble.querySelector('.multiplayer-message-avatar'), null);
  props.conversationId = room.threadId;
  update();
  assert.equal(bubble.querySelector('.multiplayer-message-avatar')?.textContent, 'AS');
  const originalMarkup = bubble.innerHTML.replace(/<span class="multiplayer-message-avatar".*?<\/span>/, '');
  window.__multiplayerCodex.cleanup();
  assert.equal(bubble.innerHTML, originalMarkup);
  assert.equal(bubble.hasAttribute('data-multiplayer-author'), false);
});

test('typing follows native composer scope without URL navigation and ignores hidden or new-chat composers', async context => {
  const { window, actions } = await setup(context);
  const composer = window.document.querySelector('[data-codex-composer-root]');
  const handle = { get() {}, value: { kind: 'local', conversationId: room.threadId } };
  composer.__reactFiber$scope = { memoizedState: { memoizedState: { current: handle } } };
  window.history.replaceState(null, '', '/');
  const shared = { ...room, typing: ['guest'] };
  const update = () => window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [shared] } });
  update();
  const surface = window.document.querySelector('.multiplayer-live');
  assert.match(surface.textContent, /Alex Smith is typing/);
  assert.equal(surface.parentElement, window.document.body);
  assert.equal(surface.style.position, 'fixed');
  assert.equal(surface.style.left, '100px');
  const editor = window.document.createElement('div');
  editor.setAttribute('contenteditable', 'plaintext-only');
  composer.append(editor);
  editor.dispatchEvent(new window.Event('beforeinput', { bubbles: true }));
  editor.textContent = 'Private draft';
  await tick();
  assert.equal(actions.filter(action => action.type === 'typing').at(-1).active, true);
  assert.equal(actions.filter(action => action.type === 'typing').at(-1).roomId, room.id);
  handle.value = { kind: 'new' };
  window.history.replaceState(null, '', `/local/${room.threadId}`);
  update();
  assert.equal(window.document.querySelector('.multiplayer-live'), null);
  assert.equal(actions.filter(action => action.type === 'typing').at(-1).active, false);
  handle.value = { kind: 'local', conversationId: room.threadId };
  composer.hidden = true;
  const previous = actions.length;
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  update();
  assert.equal(actions.length, previous);
  assert.equal(window.document.querySelector('.multiplayer-live'), null);
});

test('only the focused visible guest chat is reported as viewed, including focus and visibility changes', async context => {
  const { window } = await setup(context);
  let focused = true;
  window.document.hasFocus = () => focused;
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, writable: true, value: 'visible' });
  const viewed = [];
  const presence = window.__createMultiplayerPresence({ send() {}, toast() {}, viewed: id => viewed.push(id) });
  window.history.replaceState(null, '', '/local/room-one');
  presence.update({ ...base, self: room.members[1], rooms: [room] });
  assert.equal(viewed.at(-1), room.id);
  focused = false;
  window.dispatchEvent(new window.Event('blur'));
  assert.equal(viewed.at(-1), null);
  focused = true;
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(viewed.at(-1), room.id);
  window.document.visibilityState = 'hidden';
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(viewed.at(-1), null);
  presence.cleanup();
});

test('native composer requests are routed to shared thread with unchanged text', async context => {
  const { window, actions } = await setup(context);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, rooms: [room] } });
  const result = window.fixtureRequest('turn/start', { threadId: 'fixture-thread', input: [{ type: 'text', text: 'My exact words' }] });
  const request = actions.find(action => action.type === 'native-request');
  assert.equal(request.roomId, room.id);
  assert.equal(request.params.input[0].text, 'My exact words');
  assert.equal(window.fixtureCalls.length, 0);
  reply(window, request, { turn: { id: 'native-turn' } });
  assert.equal((await result).turn.id, 'native-turn');
  await window.fixtureRequest('thread/read', { threadId: 'fixture-thread' });
  assert.equal(window.fixtureCalls.length, 1);
});

test('guest IDs are isolated and disconnected shared requests never execute locally', async context => {
  const { window, actions } = await setup(context);
  const guest = { ...base, self: { id: 'guest', name: 'Alex Smith' }, rooms: [room] };
  window.__multiplayerCodex.receive({ type: 'state', value: guest });
  const resume = actions.find(action => action.type === 'native-request');
  assert.equal(resume.params.threadId, 'fixture-thread');
  reply(window, resume, { thread: { id: 'fixture-thread', name: 'Shared', turns: [] } });
  await tick();
  const list = actions.filter(action => action.type === 'native-request').at(-1);
  reply(window, list, { data: [], nextCursor: null });
  await tick();
  assert.equal(window.fixtureActive, room.id);
  assert.equal(window.fixtureCalls.length, 0);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...guest, rooms: [] } });
  await assert.rejects(window.fixtureRequest('turn/start', { threadId: room.id, input: [] }), /disconnected/);
  assert.equal(window.fixtureCalls.length, 0);
  await window.fixtureRequest('thread/read', { threadId: 'fixture-thread' });
  assert.equal(window.fixtureCalls.length, 1);
});

test('invitation acceptance requires comparing pairing codes; names stay inert text', async context => {
  const { window, shadow, actions } = await setup(context);
  window.__multiplayerCodex.receive({ type: 'state', value: { ...base, invitations: [{ id: 'invite-one', title: '<img src=x onerror=alert(1)>', name: 'Alex', code: '123456' }] } });
  const accept = [...shadow.querySelectorAll('button')].find(node => node.textContent === 'Accept');
  assert.equal(accept.disabled, true);
  assert.equal(shadow.querySelector('img'), null);
  const checkbox = shadow.querySelector('input');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change'));
  accept.click();
  const request = actions.find(action => action.type === 'accept');
  assert.equal(request.code, '123456');
  reply(window, request);
});
