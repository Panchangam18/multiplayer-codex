import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const app = process.env.CODEX_APP || '/Applications/ChatGPT.app';
const path = `${app}/Contents/Resources/app.asar`;
if (!existsSync(path)) throw new Error(`No Electron Codex app at ${app}. Set CODEX_APP to its path.`);
const file = openSync(path, 'r');
const prefix = Buffer.alloc(16);
readSync(file, prefix, 0, 16, 0);
const header = Buffer.alloc(prefix.readUInt32LE(12));
readSync(file, header, 0, header.length, 16);
const tree = JSON.parse(header);
const base = 8 + prefix.readUInt32LE(4);
function read(path) {
  let entry = tree;
  for (const part of path.split('/')) entry = entry?.files?.[part];
  if (!entry || entry.unpacked) throw new Error(`Missing packed asset: ${path}`);
  const content = Buffer.alloc(entry.size);
  readSync(file, content, 0, content.length, base + Number(entry.offset));
  return content.toString();
}
const packageInfo = JSON.parse(read('package.json'));
const assets = Object.keys(tree.files.webview.files.assets.files);
const initial = assets.find(name => /^app-initial-.*\.js$/.test(name));
const shared = assets.find(name => /^app-shared-.*\.js$/.test(name));
const entrypoints = [...read('webview/index.html').matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map(match => match[1].replace(/^\.?\//, ''));
const rendererPath = initial ? `webview/assets/${initial}` : `webview/${entrypoints.at(-1)}`;
const renderer = read(rendererPath);
const layout = shared ? 'vite' : renderer.includes('__webpack_require__') ? 'rspack' : 'unknown';
const preload = read('.vite/build/preload.js');
const markers = Object.fromEntries(['mcp-request', 'mcp-response', 'mcp-notification', 'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-row', 'data-codex-composer-root', 'interceptHostMessages'].map(marker => [marker, false]));
function inspect(entry, path) {
  if (entry.files) {
    for (const [name, child] of Object.entries(entry.files)) inspect(child, `${path}/${name}`);
    return;
  }
  if (!path.endsWith('.js') || entry.unpacked) return;
  const source = read(path);
  for (const marker of Object.keys(markers)) if (source.includes(marker)) markers[marker] = true;
  markers.mutableNativeTransport ||= source.includes('postMessage:') && source.includes('getState:') && source.includes('setState:');
  markers.nativeUserAnchor ||= source.includes('data-local-conversation-user-anchor');
  markers.nativeNavigation ||= source.includes('navigate-to-route');
}
inspect(tree.files.webview.files.assets, 'webview/assets');
markers.sendMessageFromView = preload.includes('sendMessageFromView');
markers.showContextMenu = preload.includes('showContextMenu');
markers.moduleLoader = layout !== 'unknown';
markers.knownRoutingCandidate = layout === 'vite' || (layout === 'rspack' && packageInfo.version === '26.1103.60933');
closeSync(file);
console.log(JSON.stringify({ app, version: packageInfo.version, layout, rendererSHA256: createHash('sha256').update(renderer).digest('hex'), markers,
  boundary: 'Static compatibility markers only. This does not verify a live renderer connection or two-Mac collaboration.' }, null, 2));
try {
  const response = await fetch(`http://127.0.0.1:${process.env.MULTIPLAYER_CODEX_PORT || 9337}/json/version`, { signal: AbortSignal.timeout(1500) });
  console.log('Local integration endpoint:', response.ok ? 'available' : response.status);
} catch { console.log('Local integration endpoint: unavailable; use the companion’s Enable Multiplayer menu.'); }
if (Object.values(markers).some(value => !value)) process.exitCode = 1;
