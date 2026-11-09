import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadIdentity } from '../src/identity.mjs';
import { DesktopBridge } from '../src/desktop.mjs';
import { MultiplayerService } from '../src/service.mjs';
import { bindController } from '../src/controller.mjs';

const electron = process.env.MULTIPLAYER_ELECTRON || process.argv[2];
if (!electron) throw new Error('Pass an Electron executable. This test uses six isolated fixture windows, not installed Codex.');
const directory = mkdtempSync(join(tmpdir(), 'multiplayer-five-'));
const output = resolve('test-results/five-people');
mkdirSync(output, { recursive: true });
const children = [];
const peers = [];
const root = 'document.querySelector("#multiplayer-codex").shadowRoot';
async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = (peer, expression) => peer.bridge.cdp.evaluate(expression);
const click = (peer, text) => evaluate(peer, `[...${root}.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(text)})?.click()`);
const personSelector = peer => `${root}.querySelector('[data-peer-id="${peer.service.identity.id}"]')`;
async function screenshot(peer, name) {
  const result = await peer.bridge.cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, name), Buffer.from(result.data, 'base64'));
}
async function openShare(peer) {
  await evaluate(peer, 'document.querySelector("[data-app-action-sidebar-thread-row]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
  await until(() => evaluate(peer, `${root}.querySelector('[role="dialog"]') !== null`), 'share sheet');
}
async function accept(host, guest) {
  await until(() => guest.service.invitations.size === 1, 'invitation');
  const invitation = guest.service.state().invitations[0];
  assert.equal(invitation.code, host.service.state().outgoing.find(value => value.id === invitation.id).code);
  assert.equal(guest.service.remoteRooms.size, 0);
  await until(() => evaluate(guest, `${root}.querySelector('input') !== null`), 'accept UI');
  await evaluate(guest, `{const check=${root}.querySelector('input');check.checked=true;check.dispatchEvent(new Event('change'));}`);
  await click(guest, 'Accept');
  await until(() => guest.service.remoteRooms.size === 1, 'accepted room');
  await until(() => evaluate(guest, 'document.querySelectorAll("#native-timeline article").length >= 2'), 'native timeline');
}
try {
  for (const [index, name] of ['Host', 'Alex', 'Blair', 'Casey', 'Devon', 'Extra'].entries()) {
    const port = 19537 + index;
    const child = spawn(electron, [resolve('test/fixtures/desktop.cjs')], {
      env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_PROFILE: join(directory, `profile-${index}`) }, stdio: 'ignore',
    });
    children.push(child);
    const bridge = new DesktopBridge();
    const service = new MultiplayerService({ identity: loadIdentity(join(directory, `identity-${index}`)), name, bridge });
    const deliver = bindController(service, bridge);
    const peer = { bridge, service, deliver, name };
    peers.push(peer);
    await service.start({ host: '127.0.0.1', discovery: false });
    await until(async () => { try { await bridge.attach(port); return true; } catch { return false; } }, 'fixture startup');
    await deliver('state', service.state());
  }
  const [host, ...guests] = peers;
  const active = peers.slice(0, 5);
  const extra = peers[5];
  for (const guest of guests) host.service.peers.set(guest.service.identity.id, {
    id: guest.service.identity.id, name: guest.name, address: '127.0.0.1', port: guest.service.port,
  });
  await host.deliver('state', host.service.state());
  await openShare(host);
  await until(() => host.service.rooms.size === 1, 'host room');
  const room = [...host.service.rooms.values()][0];
  assert.equal(await evaluate(host, `${root}.querySelector('.identity-mark,.chat-preview')`), null);
  await screenshot(host, 'nearby-people.png');
  for (const guest of active.slice(1)) {
    await until(() => evaluate(host, `${personSelector(guest)}?.disabled === false`), 'invite enabled');
    await evaluate(host, `${personSelector(guest)}.click()`);
    await accept(host, guest);
  }
  await until(() => active.every(peer => peer.service.state().rooms[0]?.members.length === 5), 'five-member convergence');
  await until(() => evaluate(host, `${personSelector(extra)}?.textContent.includes('Chat full')`), 'full UI');
  assert.equal(await evaluate(host, `${personSelector(extra)}.disabled`), true);
  await evaluate(host, `${personSelector(extra)}.click()`);
  await assert.rejects(host.service.invite(room.id, extra.service.identity.id), /full/);
  assert.equal(extra.service.invitations.size, 0);
  assert.equal(extra.service.remoteRooms.size, 0);
  await screenshot(host, 'full-share-sheet.png');
  await click(host, 'Done');
  await evaluate(host, `window.__multiplayerFixtureExports.bus.dispatchHostMessage({type:'navigate-to-route',path:'/local/fixture-thread'})`);
  for (const peer of active) await until(() => evaluate(peer, 'document.querySelectorAll(".multiplayer-initial").length === 4'), 'four other sidebar avatars');
  for (const peer of active) await evaluate(peer, `{const editor=document.querySelector('#native-composer textarea');editor.value='Private draft ${peer.name}';editor.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(async () => (await Promise.all(active.map(peer => evaluate(peer, 'document.querySelectorAll(".multiplayer-typing").length === 4')))).every(Boolean), 'four other typing bubbles per UI');
  assert.ok(!JSON.stringify(room.snapshot()).includes('Private draft'));
  for (const peer of active) {
    assert.equal(await evaluate(peer, `(() => {
      const bubbles = [...document.querySelectorAll('.multiplayer-typing')];
      return bubbles.every((bubble, index) => {
        const bounds = bubble.getBoundingClientRect();
        const avatar = bubble.querySelector('.multiplayer-typing-avatar').getBoundingClientRect();
        return bounds.top >= 0 && Math.abs((avatar.left + avatar.right) / 2 - bounds.right) < 1
          && Math.abs((avatar.top + avatar.bottom) / 2 - bounds.bottom) < 1
          && (!index || bubbles[index - 1].getBoundingClientRect().bottom < bounds.top);
      });
    })()`), true);
  }
  await screenshot(host, 'four-typing-host.png');
  await screenshot(active[1], 'four-typing-guest.png');
  for (const peer of active) await evaluate(peer, `{const editor=document.querySelector('#native-composer textarea');editor.value='';editor.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(() => room.snapshot().typing.length === 0, 'typing cleared');
  for (const peer of active) {
    const text = `Message from ${peer.name}`;
    const before = await evaluate(host, 'window.fixtureTurn');
    await evaluate(peer, `{const editor=document.querySelector('#native-composer textarea');editor.value=${JSON.stringify(text)};document.querySelector('#native-composer').requestSubmit();}`);
    await until(async () => await evaluate(host, 'window.fixtureTurn') === before + 1 && !room.active && !room.starting, `host execution for ${peer.name}`);
    await until(async () => (await Promise.all(active.map(viewer => evaluate(viewer, `document.querySelector('#native-timeline').textContent.includes(${JSON.stringify(text)})`)))).every(Boolean), 'message fanout');
  }
  const expected = active.map(peer => `Message from ${peer.name}`);
  for (const peer of active) {
    await until(() => evaluate(peer, 'document.querySelectorAll(".multiplayer-message-avatar").length === 4'), 'four remote sender avatars');
    assert.deepEqual(await evaluate(peer, `[...document.querySelectorAll('[data-user-message-bubble]')].map(node => node.textContent).slice(-5)`), expected);
    assert.deepEqual((await evaluate(peer, `[...document.querySelectorAll('.multiplayer-message-avatar')].map(node => node.title)`)).sort(), active.filter(other => other !== peer).map(other => other.name).sort());
    assert.equal(await evaluate(peer, 'document.querySelectorAll(".native-agent").length'), 6);
    assert.equal(await evaluate(peer, 'document.querySelector("#native-composer") === window.fixtureComposerNode'), true);
    assert.equal(await evaluate(peer, 'window.fixtureError || null'), null);
    if (peer !== host) assert.equal(await evaluate(peer, 'window.fixtureTurn'), 0);
    await evaluate(peer, `{const timeline=document.querySelector('#native-timeline');timeline.scrollTop=timeline.scrollHeight;}`);
    await screenshot(peer, `messages-${peer.name.toLowerCase()}.png`);
  }
  await openShare(active[4]);
  await click(active[4], 'Leave chat');
  await until(() => room.members.size === 4, 'leaving frees slot');
  await openShare(host);
  await until(() => evaluate(host, `${personSelector(extra)}?.disabled === false`), 'replacement enabled');
  await evaluate(host, `${personSelector(extra)}.click()`);
  await accept(host, extra);
  await until(() => room.members.size === 5, 'replacement joined');
  await click(host, 'End sharing');
  await until(() => guests.every(peer => peer.service.remoteRooms.size === 0), 'all guests disconnected');
  for (const peer of peers) {
    await until(() => evaluate(peer, 'document.querySelector(".multiplayer-message-avatar,.multiplayer-presence,.multiplayer-live") === null'), 'decorations removed');
    assert.equal(await evaluate(peer, 'document.querySelector("#native-composer") === window.fixtureComposerNode'), true);
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true, participants: 5, windows: 6, rejectedSixth: true,
    fourTypingIndicatorsPerViewer: true, messagesFromEveryParticipant: true, oneHostAgent: true,
    replacementAfterLeave: true, cleanup: true, boundary: 'Isolated Electron UI fixtures and real loopback TLS; simulated Codex agent; not five physical Macs.' }, null, 2));
  console.log(`PASS: five-person UI, four simultaneous remote typers, all senders/avatars, sixth blocked, replacement, cleanup. Screenshots: ${output}`);
} finally {
  for (const peer of peers) { await peer.service.close(); await peer.bridge.close(); }
  for (const child of children) if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  rmSync(directory, { recursive: true, force: true });
}
