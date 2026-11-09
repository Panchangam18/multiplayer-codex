import { openSync, readSync, closeSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://codex.local/' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'MutationObserver', 'DOMParser', 'HTMLElement', 'Element', 'Node', 'HTMLInputElement', 'CustomEvent', 'MessageEvent', 'self']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'self' ? dom.window : dom.window[name] });
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const enqueueMicrotask = globalThis.queueMicrotask;
globalThis.queueMicrotask = function(callback) {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return enqueueMicrotask(callback);
};
const descriptor = openSync(process.argv[2], 'r');
const prefix = Buffer.alloc(16); readSync(descriptor, prefix, 0, 16, 0);
const header = Buffer.alloc(prefix.readUInt32LE(12)); readSync(descriptor, header, 0, header.length, 16);
const tree = JSON.parse(header), base = 8 + prefix.readUInt32LE(4);
const paths = new Map(), index = new Map(), factories = {}, cache = {};
function read(entry) { const buffer = Buffer.alloc(entry.size); readSync(descriptor, buffer, 0, buffer.length, base + Number(entry.offset)); return buffer.toString(); }
function walk(entry, path = '') {
  if (entry.files) { for (const [name, child] of Object.entries(entry.files)) walk(child, `${path}/${name}`); return; }
  if (!path.startsWith('/webview/assets/') || !path.endsWith('.js') || entry.unpacked) return;
  const source = read(entry);
  if (!source.includes('__webpack_modules__')) return;
  paths.set(path, entry);
  for (const match of source.matchAll(/[,{]([\w$]{4})\([\w$,]{1,12}\)\{/g)) if (!index.has(match[1])) index.set(match[1], path);
}
walk(tree);
function load(path) {
  const source = read(paths.get(path));
  const body = source.replace(/export const /g, 'const ');
  for (const [id, factory] of Object.entries(Function(`${body}\nreturn __webpack_modules__;`)())) if (!factories[id]) factories[id] = factory;
}
function requireModule(id) {
  if (cache[id]) return cache[id].exports;
  if (!factories[id]) {
    const path = index.get(id);
    if (!path) throw new Error(`Missing module ${id}`);
    load(path);
  }
  const module = cache[id] = { exports: {} };
  try { factories[id](module, module.exports, requireModule); }
  catch (error) { console.error('While requiring', id); throw error; }
  return module.exports;
}
requireModule.j = 348410;
requireModule.d = (exports, getters, values) => {
  for (const [name, getter] of Object.entries(getters || {})) Object.defineProperty(exports, name, { enumerable: true, get: getter });
  for (const [name, value] of Object.entries(values || {})) Object.defineProperty(exports, name, { enumerable: true, value });
};
requireModule.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
requireModule.n = module => { const getter = () => module?.__esModule ? module.default : module; Object.defineProperty(getter, 'a', { get: getter }); return getter; };
requireModule.nmd = module => module;
requireModule.o = (value, name) => Object.hasOwn(value, name);
requireModule.g = globalThis;
requireModule.m = factories;
requireModule.c = cache;
factories.WFY2 = (module) => { module.exports = { v: { debug() {}, warning() {}, error() {}, info() {}, trace() {} } }; };
factories.TL6G = (module) => { module.exports = { O1: { subscribe: () => () => {}, dispatchMessage() {} } }; };
for (const name of ['782259.7a3e865ee5.js', '727403.da6b00f04b.js', '158624.0baba19172.js']) load(`/webview/assets/${name}`);
load('/webview/assets/async/885188.3857056929.js');
requireModule('V7mA');
requireModule('SKhr');
closeSync(descriptor);
export { requireModule as runtime, dom };
