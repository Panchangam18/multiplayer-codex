(() => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  function boot() {
    window.__multiplayerCodex?.cleanup();
    if (!window.electronBridge?.sendMessageFromView) return;
    const container = document.createElement('div');
    container.id = 'multiplayer-codex';
    const shadow = container.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('style');
    stylesheet.textContent = window.__multiplayerCSS || '';
    const surface = document.createElement('div');
    shadow.append(stylesheet, surface);
    document.body.append(container);
    let state = { self: {}, peers: [], rooms: [], invitations: [], outgoing: [] };
    let sheetState;
    let notice = '';
    let noticeTimer;
    let native;
    let disposed = false;
    let previousFocus;
    const pending = new Map();
    const checked = new Set();
    const connecting = new Set();
    const send = message => window.__multiplayerSend(JSON.stringify(message));
    const action = (type, params = {}) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The companion did not respond.')); }, 35_000);
      pending.set(id, { resolve, reject, timer });
      send({ type, id, ...params });
    });
    const run = promise => promise.catch(error => toast(error.message));
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (text, className, handler) => {
      const node = element('button', className, text);
      node.type = 'button';
      node.addEventListener('click', handler);
      return node;
    };
    const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const avatar = person => {
      const node = element('span', 'avatar', initials(person.name));
      window.__applyMultiplayerAvatar?.(node, person);
      return node;
    };
    function toast(text) {
      notice = text;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { notice = ''; render(); }, 8000);
      render();
    }
    function closeSheet() { sheetState = null; render(); previousFocus?.focus(); }
    async function invite(peerId) {
      const roomId = sheetState?.roomId;
      const key = `${roomId}:${peerId}`;
      if (!roomId || connecting.has(key)) return;
      connecting.add(key);
      notice = '';
      render();
      try { await action('invite', { roomId, peerId }); }
      catch (error) { toast(error.message); }
      finally { connecting.delete(key); render(); }
    }
    function modal(title, subtitle, chatTitle) {
      const backdrop = element('div', 'backdrop');
      const sheet = element('section', 'sheet');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', title);
      const header = element('header', 'sheet-header');
      const identity = element('div', 'identity');
      const self = avatar(state.self);
      identity.append(element('h2', '', title), element('p', '', subtitle));
      sheet.setAttribute('aria-description', chatTitle || 'Shared chat');
      header.append(self, identity);
      const body = element('div', 'sheet-body');
      const footer = element('footer', 'sheet-footer');
      sheet.append(header, body, footer);
      backdrop.append(sheet);
      surface.append(backdrop);
      return { body, footer };
    }
    async function openShare(threadId, title) {
      previousFocus = document.activeElement;
      const existing = state.rooms.find(room => room.threadId === threadId || room.id === threadId);
      const opening = { title, threadId, roomId: existing?.id };
      sheetState = opening;
      render();
      if (!existing) {
        try {
          const result = await action('share', { threadId, title });
          if (sheetState === opening) { opening.roomId = result.roomId; render(); }
        } catch (error) { if (sheetState === opening) closeSheet(); toast(error.message); }
      }
    }
    function renderShare() {
      if (!sheetState) return;
      const room = state.rooms.find(room => room.id === sheetState.roomId);
      const isHost = !room || room.host.id === state.self.id;
      const maxMembers = room?.maxMembers || 5;
      const waiting = state.outgoing.filter(value => value.roomId === sheetState.roomId && value.status === 'waiting' && !room?.members.some(member => member.id === value.peerId)).length;
      const full = (room?.members.length || 1) + waiting >= maxMembers;
      const nearby = state.peers.filter(peer => !room?.members.some(member => member.id === peer.id));
      const { body, footer } = modal('Multiplayer', `As ${state.self.name || 'you'}`, sheetState.title);
      body.append(element('p', 'capacity', `${room?.members.length || 1} / ${maxMembers} people · Includes the host${waiting ? ` · ${waiting} invited` : ''}`));
      if (isHost && !nearby.length && (room?.members.length || 1) === 1) {
        const empty = element('div', 'empty');
        empty.append(element('h3', '', 'No People Found'), element('p', '', 'There is no one nearby to share with.'),
          element('small', '', 'Open Multiplayer Codex on another Mac on the same network.'));
        body.append(empty);
      } else if (isHost && nearby.length) {
        const people = element('div', 'people');
        for (const peer of nearby) {
          const invitation = state.outgoing.find(value => value.roomId === sheetState.roomId && value.peerId === peer.id);
          const isConnecting = connecting.has(`${sheetState.roomId}:${peer.id}`);
          const person = button('', 'person', () => void invite(peer.id));
          person.dataset.peerId = peer.id;
          person.disabled = Boolean(invitation || full || isConnecting) || !sheetState.roomId;
          person.append(avatar(peer), element('strong', '', peer.name), element('small', '', invitation ? 'Waiting…' : isConnecting ? 'Connecting…' : full ? 'Chat full' : 'Invite'));
          people.append(person);
        }
        body.append(people);
      }
      for (const invitation of state.outgoing.filter(value => value.roomId === sheetState.roomId && value.status === 'waiting')) {
        const pairing = element('div', 'pairing');
        pairing.append(element('span', '', `Compare with ${invitation.name}`), element('strong', 'pair-code', invitation.code));
        body.append(pairing);
      }
      if (room?.members.length > 1) {
        const members = element('div', 'members');
        members.append(element('h3', 'section-label', 'In this chat'));
        for (const member of room.members.filter(member => member.id !== state.self.id)) {
          const person = element('div', 'member');
          person.append(avatar(member), element('span', '', member.name));
          if (isHost) person.append(button('Remove', 'quiet', () => run(action('revoke', { roomId: room.id, memberId: member.id }))));
          members.append(person);
        }
        body.append(members);
      }
      body.append(element('p', 'privacy', isHost ? 'Invitees can read this chat and send prompts using your computer and Codex permissions.' : `Messages run on ${room.host.name}’s computer. Approvals stay with the host.`));
      if (room) footer.append(button(isHost ? 'End sharing' : 'Leave chat', 'quiet', () => run(action('end', { roomId: room.id }).then(closeSheet))));
      footer.append(button('Done', 'cancel', closeSheet));
    }
    function renderInvitation() {
      const invitation = state.invitations[0];
      if (!invitation) return;
      const { body, footer } = modal('Multiplayer', `${invitation.name} wants to share a chat`, invitation.title);
      const request = element('div', 'invitation');
      request.append(avatar(invitation), element('h3', '', invitation.title),
        element('p', '', `Join the same Codex chat on ${invitation.name}’s computer.`), element('strong', 'pair-code', invitation.code));
      const label = element('label', 'confirm');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked.has(invitation.id);
      label.append(checkbox, document.createTextNode('The code matches on both computers'));
      const accept = button('Accept', 'primary', () => run(action('accept', { invitationId: invitation.id, code: invitation.code })));
      accept.disabled = !checkbox.checked;
      checkbox.addEventListener('change', () => { if (checkbox.checked) checked.add(invitation.id); else checked.delete(invitation.id); accept.disabled = !checkbox.checked; });
      request.append(label);
      body.append(request);
      footer.append(button('Decline', 'cancel', () => run(action('decline', { invitationId: invitation.id }))), accept);
    }
    function render() {
      if (disposed) return;
      const focused = shadow.activeElement;
      const focusLabel = focused?.textContent;
      const hadDialog = Boolean(surface.querySelector('[role="dialog"]'));
      surface.replaceChildren();
      if (state.invitations.length) renderInvitation(); else renderShare();
      if (notice) {
        const body = surface.querySelector('.sheet-body');
        const node = element('div', body ? 'sheet-notice' : 'toast', notice);
        node.setAttribute('role', 'status');
        if (body) body.prepend(node); else surface.append(node);
      }
      const dialog = surface.querySelector('[role="dialog"]');
      if (focused?.tagName === 'INPUT') dialog?.querySelector('input')?.focus();
      else if (focused) [...surface.querySelectorAll('button')].find(node => node.textContent === focusLabel)?.focus();
      else if (dialog && !hadDialog) { previousFocus ||= document.activeElement; dialog.querySelector('button:not(:disabled),input')?.focus(); }
    }
    const keydown = event => {
      const dialog = surface.querySelector('[role="dialog"]');
      if (!dialog) return;
      if (event.key === 'Escape' && !state.invitations.length) { event.preventDefault(); closeSheet(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button:not(:disabled),input')];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (!dialog.contains(shadow.activeElement) || shadow.activeElement === last)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    const ready = window.__createMultiplayerNative({ action, send, openShare, toast }).then(value => {
      if (disposed) { value.cleanup(); return; }
      native = value;
      native.update(state);
      send({ type: 'ready' });
    });
    ready.catch(error => toast(error.message));
    window.__multiplayerCodex = {
      ready,
      async rpc(method, params) { await ready; return native.rpc(method, params); },
      receive(message) {
        if (message.type === 'state') { state = message.value; native?.update(state); render(); }
        else if (message.type === 'native-event') native?.event(message.value);
        else if (message.type === 'notice') toast(message.value);
        else if (message.type === 'result') {
          const waiter = pending.get(message.value.id);
          if (!waiter) return;
          pending.delete(message.value.id);
          clearTimeout(waiter.timer);
          if (message.value.error) waiter.reject(new Error(message.value.error)); else waiter.resolve(message.value.result);
        }
      },
      cleanup() {
        disposed = true;
        native?.cleanup();
        clearTimeout(noticeTimer);
        document.removeEventListener('keydown', keydown);
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Multiplayer disconnected.')); }
        container.remove();
        delete window.__multiplayerCodex;
      },
    };
    render();
  }
})();
