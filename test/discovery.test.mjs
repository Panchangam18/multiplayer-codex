import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Browser } from 'bonjour-service';
import { NearbyDiscovery, networkKey, peerAddresses } from '../src/discovery.mjs';

const hostId = 'a'.repeat(64);
const guestId = 'b'.repeat(64);
const interfaces = address => ({ en0: [{ family: 'IPv4', address, netmask: '255.255.255.0', internal: false }] });
function packet(address) {
  const name = 'Guest._codex-mp._tcp.local';
  return { answers: [{ name: '_codex-mp._tcp.local', type: 'PTR', ttl: 120, data: name }], additionals: [
    { name, type: 'SRV', ttl: 120, data: { target: 'guest.local', port: 12345 } },
    { name, type: 'TXT', ttl: 120, data: [`id=${guestId}`, 'version=2', 'name=Guest'].map(value => Buffer.from(value)) },
    { name: 'guest.local', type: 'A', ttl: 120, data: address },
  ] };
}
function setup(context) {
  let network = interfaces('192.168.1.10');
  const instances = [], peers = [], removed = [];
  let resets = 0;
  const discovery = new NearbyDiscovery({ id: hostId, port: 1234, profile: () => ({ id: hostId, version: '2' }),
    interfaces: () => network, onPeer: peer => peers.push(peer), onDown: id => removed.push(id), onReset: () => resets++,
    onError: error => { throw error; }, createBonjour: () => {
      const mdns = new EventEmitter();
      mdns.query = () => {};
      const instance = { mdns, destroyed: false,
        publish(config) { this.config = config; return { stop: callback => callback?.(), start() {} }; },
        find(options) { return new Browser(mdns, options); },
        destroy() { this.destroyed = true; },
      };
      instances.push(instance);
      return instance;
    },
  });
  discovery.start();
  context.after(() => discovery.stop());
  return { discovery, instances, peers, removed, setNetwork: value => { network = interfaces(value); }, resets: () => resets };
}

test('Wi-Fi address change rebuilds advertisement and multicast browser and ignores old callbacks', context => {
  const { discovery, instances, peers, setNetwork, resets } = setup(context);
  const oldBrowser = discovery.browser;
  instances[0].mdns.emit('response', packet('192.168.1.20'), { address: '192.168.1.20' });
  assert.equal(peers.length, 1);
  setNetwork('10.0.0.10');
  discovery.check();
  assert.equal(resets(), 1);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].destroyed, true);
  assert.equal(instances[1].config.port, 1234);
  oldBrowser.emit('up', { txt: { id: guestId, version: '2' }, addresses: ['192.168.1.20'], port: 12345 });
  assert.equal(peers.length, 1);
  instances[1].mdns.emit('response', packet('10.0.0.20'), { address: '10.0.0.20' });
  assert.equal(peers.length, 2);
  assert.deepEqual(peerAddresses(peers[1]), ['10.0.0.20']);
});

test('fresh browsing picks up address-only changes ignored by the library cache; stale peers expire', context => {
  const { discovery, instances, peers, removed } = setup(context);
  const mdns = instances[0].mdns;
  mdns.emit('response', packet('192.168.1.20'), { address: '192.168.1.20' });
  mdns.emit('response', packet('10.0.0.20'), { address: '10.0.0.20' });
  assert.equal(peers.length, 1);
  discovery.check(Date.now() + 10_001);
  mdns.emit('response', packet('10.0.0.20'), { address: '10.0.0.20' });
  assert.equal(peers.length, 2);
  assert.deepEqual(peerAddresses(peers[1]), ['10.0.0.20']);
  discovery.check(Date.now() + 36_000);
  assert.deepEqual(removed, [guestId]);
  discovery.stop();
  mdns.emit('response', packet('10.0.0.30'), { address: '10.0.0.30' });
  assert.equal(peers.length, 2);
});

test('packet source is tried before stale address records and candidates stay bounded IPv4 addresses', () => {
  assert.deepEqual(peerAddresses({ referer: { address: '10.0.0.20' }, addresses: ['192.168.1.20', '10.0.0.20', 'bad', '::1'] }), ['10.0.0.20', '192.168.1.20']);
  assert.equal(peerAddresses({ addresses: Array.from({ length: 8 }, (_, index) => `10.0.0.${index + 1}`) }).length, 4);
  assert.notEqual(networkKey(interfaces('192.168.1.10')), networkKey(interfaces('10.0.0.10')));
});
