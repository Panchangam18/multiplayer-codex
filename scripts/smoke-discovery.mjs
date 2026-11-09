import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadIdentity } from '../src/identity.mjs';
import { MultiplayerService } from '../src/service.mjs';

const directory = mkdtempSync(join(tmpdir(), 'multiplayer-discovery-'));
const peers = [];
try {
  for (const name of ['Discovery test A', 'Discovery test B']) {
    const service = new MultiplayerService({ identity: loadIdentity(join(directory, name)), name, bridge: new EventEmitter() });
    service.on('notice', text => console.log(text));
    peers.push(service);
    await service.start();
    service.setProfile({ name: `${name} profile`, avatar: { initials: 'DP' } });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !peers.every(service => service.peers.has(peers.find(other => other !== service).identity.id))) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!peers.every(service => service.peers.has(peers.find(other => other !== service).identity.id))) throw new Error('Bonjour peers did not discover each other. Check local-network permission and multicast availability.');
  peers[0].setProfile({ name: 'updated-codex-profile', avatar: { initials: 'UP', background: '#345678' } });
  const updateDeadline = Date.now() + 15_000;
  while (Date.now() < updateDeadline && peers[1].peers.get(peers[0].identity.id)?.name !== 'updated-codex-profile') {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const updated = peers[1].peers.get(peers[0].identity.id);
  if (updated?.name !== 'updated-codex-profile' || updated.avatar?.initials !== 'UP') throw new Error('Profile changes did not propagate through discovery.');
  console.log('PASS: native profile name/avatar updates propagate to a discovered peer.');
  peers[0].discovery.key = 'simulate-interface-change';
  peers[0].discovery.check();
  if (peers[0].peers.size !== 0 || peers[0].networkGeneration !== 1) throw new Error('Network reset did not invalidate old discovery.');
  const resetDeadline = Date.now() + 15_000;
  while (Date.now() < resetDeadline && !peers[0].peers.has(peers[1].identity.id)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!peers[0].peers.has(peers[1].identity.id)) throw new Error('Discovery did not recover after multicast rebind.');
  console.log('PASS: real multicast socket rebind rediscovers the peer after simulated interface change.');
  console.log('PASS: two independently advertised Bonjour peers discover each other on this Mac. This does not verify Wi-Fi reachability from another physical Mac.');
} finally {
  for (const service of peers) await service.close();
  rmSync(directory, { recursive: true, force: true });
}
