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
if (!electron) throw new Error('Pass an Electron executable path as the first argument or MULTIPLAYER_ELECTRON. This test uses isolated hidden windows.');
const directory = mkdtempSync(join(tmpdir(), 'multiplayer-desktop-'));
const children = [];
const peers = [];
const output = resolve('test-results');
mkdirSync(output, { recursive: true });
async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('Desktop smoke condition timed out.');
}
const root = 'document.querySelector("#multiplayer-codex").shadowRoot';
const click = async (bridge, text) => bridge.cdp.evaluate(`[...${root}.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)})?.click()`);
async function screenshot(bridge, name) {
  const result = await bridge.cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, name), Buffer.from(result.data, 'base64'));
}
try {
  for (const [index, name] of ['Madhavan', 'Alex'].entries()) {
    const port = 19437 + index;
    const profile = join(directory, `profile-${index}`);
    const child = spawn(electron, [resolve('test/fixtures/desktop.cjs')], {
      env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_PROFILE: profile }, stdio: 'ignore' });
    children.push(child);
    const bridge = new DesktopBridge();
    const service = new MultiplayerService({ identity: loadIdentity(join(directory, `identity-${index}`)), name, bridge });
    const deliver = bindController(service, bridge);
    await service.start({ host: '127.0.0.1', discovery: false });
    peers.push({ bridge, service, deliver });
    await until(async () => { await bridge.attach(port); return true; });
    await deliver('state', service.state());
  }
  const [host, guest] = peers;
  host.service.peers.set(guest.service.identity.id, { id: guest.service.identity.id, name: 'Alex', address: '127.0.0.2', port: guest.service.port });
  await host.deliver('state', host.service.state());
  await host.bridge.cdp.evaluate('document.querySelector("[data-app-action-sidebar-thread-row]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
  await until(() => host.service.rooms.size === 1);
  await until(() => host.bridge.cdp.evaluate(`${root}.querySelector('.person')?.disabled === false`));
  await host.bridge.cdp.evaluate(`${root}.querySelector('.person').click()`);
  await until(() => host.bridge.cdp.evaluate(`${root}.querySelector('.sheet-body .sheet-notice')?.textContent.includes('Could not reach')`));
  assert.equal(guest.service.invitations.size, 0);
  assert.equal(host.service.outgoing.size, 0);
  await screenshot(host.bridge, 'connection-error.png');
  host.service.peers.set(guest.service.identity.id, { id: guest.service.identity.id, name: 'Alex', address: '127.0.0.1', port: guest.service.port });
  await host.deliver('state', host.service.state());
  await until(() => host.bridge.cdp.evaluate(`${root}.querySelector('.person')?.disabled === false`));
  await host.bridge.cdp.evaluate(`${root}.querySelector('.person').click()`);
  await until(() => guest.service.invitations.size === 1);
  await screenshot(host.bridge, 'share-sheet.png');
  await screenshot(guest.bridge, 'invitation.png');
  assert.equal(guest.service.remoteRooms.size, 0);
  await guest.bridge.cdp.evaluate(`{const check=${root}.querySelector('input');check.checked=true;check.dispatchEvent(new Event('change'));}`);
  await click(guest.bridge, 'Accept');
  await until(() => guest.service.remoteRooms.size === 1);
  await click(host.bridge, 'Done');
  await until(() => guest.bridge.cdp.evaluate('document.querySelectorAll("#native-timeline article").length===2'));
  const room = [...host.service.rooms.values()][0];
  await host.bridge.cdp.evaluate(`window.__multiplayerFixtureExports.bus.dispatchHostMessage({type:'navigate-to-route',path:'/local/fixture-thread'})`);
  await guest.bridge.cdp.evaluate(`{const editor=document.querySelector('#native-composer textarea');editor.value='Unsent private draft';editor.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(() => host.bridge.cdp.evaluate(`document.querySelector('.multiplayer-live')?.textContent.includes('Alex is typing')`));
  assert.ok(!JSON.stringify(room.snapshot()).includes('Unsent private draft'));
  assert.equal(await host.bridge.cdp.evaluate(`(() => {
    const bubble = document.querySelector('.multiplayer-typing');
    const badge = bubble.querySelector('.multiplayer-typing-avatar').getBoundingClientRect();
    const bounds = bubble.getBoundingClientRect();
    const composer = document.querySelector('[data-codex-composer-root]').getBoundingClientRect();
    return Math.abs((badge.left + badge.right) / 2 - bounds.right) < 1
      && Math.abs((badge.top + badge.bottom) / 2 - bounds.bottom) < 1
      && Math.abs(badge.right - composer.right) < 1
      && badge.width === 28 && bounds.bottom < composer.top
      && bubble.querySelectorAll('.multiplayer-dots i').length === 3;
  })()`), true);
  await screenshot(host.bridge, 'typing.png');
  await guest.bridge.cdp.evaluate(`{const editor=document.querySelector('#native-composer textarea');editor.value='';editor.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(() => room.snapshot().typing.length === 0);
  for (const [peer, text] of [[host, 'Could we start with a warm welcome and just one button?'], [guest, 'Yes — and let people skip setup and explore first.']]) {
    const before = room.bridge.cdp && await host.bridge.cdp.evaluate('window.fixtureTurn');
    await peer.bridge.cdp.evaluate(`{const textarea=document.querySelector('#native-composer textarea');textarea.value=${JSON.stringify(text)};document.querySelector('#native-composer').requestSubmit();}`);
    await until(async () => await host.bridge.cdp.evaluate('window.fixtureTurn') > before && !room.active && !room.starting);
  }
  await until(() => room.messages.filter(message => message.role === 'agent').length === 3 && !room.active && !room.starting);
  await until(() => guest.bridge.cdp.evaluate('document.querySelectorAll("[data-multiplayer-author]").length===1'));
  await until(() => host.bridge.cdp.evaluate('document.querySelectorAll("[data-multiplayer-author]").length===1'));
  assert.equal(await host.bridge.cdp.evaluate('window.fixtureCalls.filter(call=>call.method==="turn/start").length'), 2);
  assert.equal(await guest.bridge.cdp.evaluate('window.fixtureCalls.length'), 0);
  assert.ok(room.messages.some(message => message.author.name === 'Madhavan' && message.role === 'user'));
  assert.ok(room.messages.some(message => message.author.name === 'Alex' && message.role === 'user'));
  for (const peer of peers) {
    assert.equal(await peer.bridge.cdp.evaluate('document.querySelector("#native-composer") === window.fixtureComposerNode'), true);
    assert.equal(await peer.bridge.cdp.evaluate(`${root}.querySelector('textarea,.chat,.timeline,.dock') === null`), true);
    assert.equal(await peer.bridge.cdp.evaluate('document.querySelectorAll(".multiplayer-initial").length'), 1);
    assert.equal(await peer.bridge.cdp.evaluate('document.querySelectorAll(".multiplayer-message-avatar").length'), 1);
    assert.equal(await peer.bridge.cdp.evaluate('getComputedStyle(document.querySelector(".multiplayer-message-avatar")).position'), 'absolute');
    assert.equal(await peer.bridge.cdp.evaluate(`(() => {
      const avatar = document.querySelector('.multiplayer-message-avatar');
      const badge = avatar.getBoundingClientRect();
      const bubble = avatar.parentElement.querySelector('[data-user-message-bubble]').getBoundingClientRect();
      return Math.abs((badge.left + badge.right) / 2 - bubble.right) < 1 && Math.abs((badge.top + badge.bottom) / 2 - bubble.bottom) < 1 && Boolean(avatar.title);
    })()`), true);
  }
  assert.deepEqual(await host.bridge.cdp.evaluate('window.fixtureCalls.filter(call=>call.method==="turn/start").map(call=>call.params.input[0].text)'), [
    'Could we start with a warm welcome and just one button?', 'Yes — and let people skip setup and explore first.',
  ]);
  await screenshot(host.bridge, 'host-chat.png');
  await screenshot(guest.bridge, 'guest-chat.png');
  const imagePath = join(directory, 'clipboard.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  await host.bridge.cdp.evaluate(`window.fixtureRequest('turn/start', { threadId:'fixture-thread', input:[{type:'text',text:'Image round trip'},{type:'localImage',path:${JSON.stringify(imagePath)}}] })`, true);
  await until(() => guest.bridge.cdp.evaluate('document.querySelector("#native-timeline img")?.naturalWidth === 1'));
  await until(() => !room.active && !room.starting);
  await guest.bridge.cdp.evaluate(`window.fixtureRequest('turn/start', { threadId:${JSON.stringify(room.id)}, input:[{type:'text',text:'Guest image round trip'},{type:'localImage',path:${JSON.stringify(imagePath)}}] })`, true);
  await until(() => host.bridge.cdp.evaluate('document.querySelector("#native-timeline img")?.naturalWidth === 1'));
  await until(() => !room.active && !room.starting);
  await guest.bridge.cdp.evaluate('window.__multiplayerCodex.cleanup()');
  assert.equal(await guest.bridge.cdp.evaluate('document.querySelector("#native-timeline").innerHTML === window.fixtureNativeMarkup'), true);
  assert.equal(await guest.bridge.cdp.evaluate('document.querySelector(".multiplayer-message-avatar,.multiplayer-presence,[data-multiplayer-author],#multiplayer-codex")'), null);
  assert.equal(await guest.bridge.cdp.evaluate('document.querySelector("#native-composer") === window.fixtureComposerNode'), true);
  await host.bridge.cdp.evaluate('document.querySelector("[data-app-action-sidebar-thread-row]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
  await until(() => host.bridge.cdp.evaluate(`${root}.querySelector('[role="dialog"]') !== null`));
  await click(host.bridge, 'End sharing');
  await until(() => guest.service.remoteRooms.size === 0);
  await until(() => host.bridge.cdp.evaluate('document.querySelector("#native-timeline").innerHTML === window.fixtureNativeMarkup'));
  assert.equal(await host.bridge.cdp.evaluate('document.querySelector("[data-codex-composer-root]").style.visibility'), '');
  console.log('PASS: context menu → nearby sheet → TLS invite/accept → native composers → unchanged prompts to one host → native streamed timeline + corner avatars and hover names → end sharing. Original composers retained throughout.');
  console.log('Screenshots saved in test-results/. Agent and desktop host are fixtures, not the installed Codex app.');
} finally {
  for (const peer of peers) { await peer.service.close(); await peer.bridge.close(); }
  for (const child of children) {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); }
  }
  rmSync(directory, { recursive: true, force: true });
}
