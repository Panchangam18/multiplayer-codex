import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { Bonjour } from 'bonjour-service';

export function networkKey(interfaces = networkInterfaces()) {
  return JSON.stringify(Object.entries(interfaces).flatMap(([name, values]) => (values || [])
    .filter(value => !value.internal && value.family === 'IPv4')
    .map(value => [name, value.address, value.netmask])).sort());
}

export function peerAddresses(service) {
  return [...new Set([service.referer?.address, ...(service.addresses || [])].filter(isIPv4))].slice(0, 4);
}

export class NearbyDiscovery {
  constructor({ id, port, profile, onPeer, onDown, onReset, onError, interfaces = networkInterfaces,
    createBonjour = error => new Bonjour({}, error) }) {
    Object.assign(this, { id, port, profile, onPeer, onDown, onReset, onError, interfaces, createBonjour });
    this.seen = new Map();
    this.generation = 0;
  }

  start() {
    this.key = networkKey(this.interfaces());
    this.restart();
    this.timer = setInterval(() => this.check(), 2000);
    this.timer.unref();
  }

  check(now = Date.now()) {
    const key = networkKey(this.interfaces());
    if (key !== this.key) {
      this.key = key;
      this.onReset();
      this.restart();
    } else if (now - this.lastBrowse >= 10_000) this.browse();
    for (const [id, lastSeen] of this.seen) if (now - lastSeen > 35_000) {
      this.seen.delete(id);
      this.onDown(id);
    }
  }

  restart() {
    this.generation++;
    clearTimeout(this.profileTimer);
    this.browser?.stop();
    this.bonjour?.destroy();
    this.seen.clear();
    this.bonjour = this.createBonjour(this.onError);
    this.advertisement = this.bonjour.publish({ name: `Multiplayer Codex · ${this.id.slice(0, 12)}`,
      type: 'codex-mp', port: this.port, txt: this.profile(), probe: false });
    this.browse();
  }

  browse() {
    this.browser?.stop();
    this.lastBrowse = Date.now();
    const generation = this.generation;
    const browser = this.bonjour.find({ type: 'codex-mp' });
    this.browser = browser;
    const current = () => generation === this.generation && browser === this.browser && !this.stopped;
    const discovered = service => {
      if (!current()) return;
      const { id, version } = service.txt || {};
      if (id === this.id || version !== '2' || !/^[a-f0-9]{64}$/.test(id || '') || !peerAddresses(service).length
        || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return;
      this.seen.set(id, Date.now());
      this.onPeer(service);
    };
    browser.on('up', discovered);
    browser.on('txt-update', discovered);
    browser.on('srv-update', discovered);
    browser.on('down', service => {
      if (!current()) return;
      this.seen.delete(service.txt?.id);
      this.onDown(service.txt?.id);
    });
  }

  updateProfile() {
    clearTimeout(this.profileTimer);
    const generation = this.generation;
    const advertisement = this.advertisement;
    if (!advertisement) return;
    this.profileTimer = setTimeout(() => {
      if (this.stopped || generation !== this.generation) return;
      advertisement.stop(() => {
        if (this.stopped || generation !== this.generation) return;
        advertisement.txt = this.profile();
        advertisement.start({ probe: false });
      });
    }, 100);
  }

  stop() {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.profileTimer);
    this.browser?.stop();
    this.advertisement?.stop();
    this.bonjour?.destroy();
  }
}
