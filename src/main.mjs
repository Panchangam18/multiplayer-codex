import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadIdentity } from './identity.mjs';
import { DesktopBridge } from './desktop.mjs';
import { MultiplayerService } from './service.mjs';
import { bindController } from './controller.mjs';

const directory = process.env.MULTIPLAYER_HOME || join(homedir(), 'Library/Application Support/Multiplayer Codex');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const bridge = new DesktopBridge();
const service = new MultiplayerService({ identity: loadIdentity(directory), directory,
  name: process.env.MULTIPLAYER_NAME || userInfo().username, bridge });
const port = Number(process.env.MULTIPLAYER_CODEX_PORT || 9337);
let attaching = false;
let attached = false;
let exiting = false;
const status = (state, detail) => {
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ state, detail, pid: process.pid, updatedAt: Date.now(), profileSource: service.profileSource, displayName: service.name,
    avatarKind: service.avatar?.image ? 'image' : service.avatar?.initials ? 'initials' : 'fallback', avatarInitials: service.avatar?.initials, avatarBackground: service.avatar?.background, avatarProbe: service.profileProbe }), { mode: 0o600 });
  console.log(`${state}: ${detail}`);
};
const deliver = bindController(service, bridge);
service.on('profile', () => { if (attached) status('connected', 'Right-click a sidebar chat → Multiplayer to share.'); });
bridge.on('disconnected', () => {
  if (!attached) return;
  attached = false;
  status('waiting', 'Codex disconnected. Open it with Multiplayer Codex.');
});

await service.start();
status('waiting', 'Waiting for Codex on the local integration port.');
async function attach() {
  if (attaching || attached || exiting) return;
  attaching = true;
  try {
    await bridge.attach(port);
    attached = true;
    status('connected', 'Right-click a sidebar chat → Multiplayer to share.');
    await deliver('state', service.state());
  } catch (error) {
    if (error.message.includes('Unsupported Codex build:')) status('incompatible', error.message);
    else if (!error.message.includes('fetch failed')) status('waiting', error.message);
  } finally { attaching = false; }
}
const interval = setInterval(attach, 3000);
await attach();
async function close() {
  if (exiting) return;
  exiting = true;
  clearInterval(interval);
  await service.close();
  await bridge.close();
  status('stopped', 'Multiplayer Codex stopped.');
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
