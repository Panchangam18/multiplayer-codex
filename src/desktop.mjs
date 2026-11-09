import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { CDP } from './cdp.mjs';

export class DesktopBridge extends EventEmitter {
  async attach(port) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = await response.json();
    for (const target of targets.filter(target => target.type === 'page' && /^(file:|app:|codex:)/.test(target.url))) {
      const cdp = new CDP(target.webSocketDebuggerUrl);
      try {
        const compatible = await cdp.evaluate('Boolean(window.electronBridge?.sendMessageFromView && document.querySelector("[data-app-action-sidebar-thread-row], aside.app-shell-left-panel"))');
        if (!compatible) { cdp.close(); continue; }
        this.cdp = cdp;
        cdp.on('disconnected', () => this.emit('disconnected'));
        await cdp.call('Runtime.enable');
        await cdp.call('Runtime.addBinding', { name: '__multiplayerSend' });
        cdp.on('Runtime.bindingCalled', params => {
          if (params.name !== '__multiplayerSend') return;
          try {
            const message = JSON.parse(params.payload);
            if (message.type === 'notification') this.emit('notification', message);
            else if (message.type === 'approval') this.emit('approval', message);
            else this.emit('action', message);
          } catch {}
        });
        const css = readFileSync(new URL('../renderer/multiplayer.css', import.meta.url), 'utf8');
        const script = readFileSync(new URL('../renderer/multiplayer.js', import.meta.url), 'utf8');
        const native = readFileSync(new URL('../renderer/native.js', import.meta.url), 'utf8');
        const managed = readFileSync(new URL('../renderer/managed.js', import.meta.url), 'utf8');
        const presence = readFileSync(new URL('../renderer/presence.js', import.meta.url), 'utf8');
        const profile = readFileSync(new URL('../renderer/profile.js', import.meta.url), 'utf8');
        this.script = `window.__multiplayerCSS=${JSON.stringify(css)};\n${profile}\n${managed}\n${presence}\n${native}\n${script}`;
        await cdp.call('Page.enable');
        const installed = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: this.script });
        this.scriptIdentifier = installed.identifier;
        await cdp.evaluate(this.script);
        await cdp.evaluate('window.__multiplayerCodex.ready', true);
        cdp.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) this.emit('reset'); });
        cdp.on('Page.loadEventFired', () => this.emit('reload'));
        return;
      } catch (error) { cdp.close(); if (this.cdp === cdp) throw error; }
    }
    throw new Error('No compatible Codex window found. Open a local chat with the sidebar visible.');
  }

  async request(method, params) {
    if (!['thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'thread/timeline/list', 'thread/queue/list', 'thread/goal/get', 'turn/start'].includes(method)) throw new Error('Unsupported Codex action.');
    if (!this.cdp) throw new Error('Connect to Codex first.');
    return this.cdp.evaluate(`window.__multiplayerCodex.rpc(${JSON.stringify(method)},${JSON.stringify(params)})`, true);
  }

  async deliver(type, value) {
    if (this.cdp) await this.cdp.evaluate(`window.__multiplayerCodex?.receive(${JSON.stringify({ type, value })})`);
  }

  async close() {
    if (!this.cdp) return;
    try {
      await this.cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptIdentifier });
      await this.cdp.evaluate('window.__multiplayerCodex?.cleanup()');
    } catch {}
    this.cdp.close();
  }
}
