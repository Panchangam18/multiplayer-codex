import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { isIPv4 } from 'node:net';
import { fingerprint } from './identity.mjs';

export const MAX_FRAME = 4 * 1024 * 1024;

export class Wire extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.peerId = fingerprint(socket.getPeerCertificate().raw);
    this.closed = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(45_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      clearInterval(this.heartbeat);
      this.emit('close');
    });
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let boundary;
      while ((boundary = this.buffer.indexOf(10)) !== -1) {
        if (boundary > MAX_FRAME) return socket.destroy();
        const frame = this.buffer.subarray(0, boundary);
        this.buffer = this.buffer.subarray(boundary + 1);
        try {
          const message = JSON.parse(frame.toString('utf8'));
          if (!message || typeof message.type !== 'string') return socket.destroy();
          if (message.type !== 'ping') this.emit('message', message);
        } catch { return socket.destroy(); }
      }
      if (this.buffer.length > MAX_FRAME) socket.destroy();
    });
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 15_000);
    this.heartbeat.unref();
  }

  send(message) {
    if (this.closed || this.socket.destroyed) return false;
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME || this.socket.writableLength > MAX_FRAME * 2) {
      this.close();
      return false;
    }
    this.socket.write(frame);
    return true;
  }

  close() { this.socket.destroy(); }
}

export async function connectPeer(peer, identity) {
  const addresses = [...new Set([peer.address, ...(peer.addresses || [])].filter(isIPv4))].slice(0, 4);
  if (!addresses.length) throw new Error('Nearby computer has no usable address.');
  const deadline = Date.now() + 6000;
  let lastError;
  for (const address of addresses) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try { return await connectAddress({ ...peer, address }, identity, Math.min(remaining, addresses.length > 1 ? 1500 : 6000)); }
    catch (error) {
      if (error.message.includes('identity changed')) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('Nearby computer did not respond.');
}

function connectAddress(peer, identity, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: peer.address, port: peer.port, key: identity.key, cert: identity.cert,
      rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    const timeout = setTimeout(() => socket.destroy(new Error('Nearby computer did not respond.')), timeoutMs);
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.once('close', () => { clearTimeout(timeout); reject(new Error('Nearby connection closed before pairing.')); });
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      const raw = socket.getPeerCertificate().raw;
      if (!raw || fingerprint(raw) !== peer.id) {
        socket.destroy();
        reject(new Error('The nearby computer’s identity changed. Discover it again.'));
        return;
      }
      resolve(new Wire(socket));
    });
  });
}

export async function listen(identity, onConnection, host = '0.0.0.0', port = 0) {
  const server = tls.createServer({ key: identity.key, cert: identity.cert, requestCert: true,
    rejectUnauthorized: false, minVersion: 'TLSv1.3', handshakeTimeout: 5000 }, socket => {
    if (!socket.getPeerCertificate().raw) return socket.destroy();
    onConnection(new Wire(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
