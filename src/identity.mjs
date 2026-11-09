import { X509Certificate, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function fingerprint(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export function loadIdentity(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'device.key');
  const certPath = join(directory, 'device.crt');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', '/CN=Multiplayer Codex'],
    { stdio: 'ignore' });
    chmodSync(keyPath, 0o600);
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  return { key, cert, id: fingerprint(new X509Certificate(cert).raw) };
}

export function commitment(nonce) {
  return createHash('sha256').update(nonce).digest('hex');
}

export function pairingCode(first, second, invitation, hostNonce, guestNonce) {
  const digest = createHash('sha256').update([... [first, second].sort(), invitation, hostNonce, guestNonce].join(':')).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
