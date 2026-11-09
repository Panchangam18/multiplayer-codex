window.__createMultiplayerNative = async ({ action, send, openShare, toast }) => {
  const resources = [...(performance.getEntriesByType?.('resource') || []).map(entry => entry.name),
    ...[...document.querySelectorAll('script[src],link[href]')].map(node => node.src || node.href)];
  const asset = resources.find(url => /\/app-shared-[\w-]+\.js(?:\?|$)/.test(url));
  let exports = window.__multiplayerFixtureExports || (asset && await import(asset));
  if (!exports) {
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      if (!/\/assets\/\d+\.[\da-f]+\.js(?:\?|$)/.test(script.src)) continue;
      const candidate = await import(script.src);
      if (typeof candidate.__webpack_require__ === 'function') { exports = candidate; break; }
    }
  }
  const runtime = exports?.__webpack_require__;
  if (typeof runtime === 'function' && typeof window.__createMultiplayerManaged !== 'function') throw new Error('Unsupported Codex build: host-managed chats require the native service adapter.');
  const values = runtime ? [runtime.c?.TL6G?.exports?.O1, runtime.c?.SITX?.exports?.F] : exports ? Object.values(exports) : [];
  const concreteMethod = (value, key) => {
    try {
      for (let current = value, depth = 0; current && depth < 3; current = Object.getPrototypeOf(current), depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) return typeof descriptor.value === 'function';
      }
    } catch {}
    return false;
  };
  const bus = [exports?.zRt, ...values].find(value => ['dispatchHostMessage', 'interceptHostMessages', 'subscribe'].every(key => concreteMethod(value, key)));
  const transport = [exports?.WRt, ...values].find(value => ['postMessage', 'getState', 'setState'].every(key => concreteMethod(value, key)));
  if (!bus || !transport || !window.electronBridge?.showContextMenu) throw new Error('This Codex build has different native components. Multiplayer was not installed.');
  const originalPost = transport.postMessage;
  const pending = new Map();
  const listRequests = new Map();
  const knownRemote = new Map();
  const hosted = new Set();
  const cleanups = [];
  let state = { self: {}, rooms: [] };
  let disposed = false;
  const normalize = value => typeof value === 'string' ? value.replace(/^local:/, '') : null;
  const nativeId = room => room.host.id === state.self.id ? room.threadId : room.id;
  const rewrite = (value, from, to) => {
    if (Array.isArray(value)) return value.map(entry => rewrite(entry, from, to));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      ['id', 'threadId', 'conversationId'].includes(key) && entry === from ? to : rewrite(entry, from, to)]));
  };
  const remoteThread = room => ({ ...rewrite(room.thread || {}, room.threadId, room.id), id: room.id, name: room.title,
    turns: [], status: { type: room.active ? 'active' : 'idle', activeFlags: [] } });
  const deliver = message => { if (!disposed) bus.dispatchHostMessage(message); };
  const managed = runtime ? window.__createMultiplayerManaged({ runtime, action, send, toast,
    navigate: path => deliver({ type: 'navigate-to-route', path }) }) : null;
  if (managed) cleanups.push(() => managed.cleanup());
  const presence = window.__createMultiplayerPresence?.({ send, toast, viewed: id => managed?.viewed(id) });
  if (presence) {
    cleanups.push(() => presence.cleanup());
    cleanups.push(bus.subscribe('navigate-to-route', message => presence.navigate(message.path)));
  }
  const response = (request, result, error) => deliver({ type: 'mcp-response', hostId: 'local', message: {
    id: request.id, ...(error ? { error: { code: -32000, message: error.message } } : { result }),
  } });

  function post(message) {
    const request = message.type === 'mcp-request' && message.hostId === 'local' && message.request;
    if (!request) return originalPost.call(transport, message);
    const threadId = normalize(request.params?.threadId);
    const room = state.rooms.find(room => nativeId(room) === threadId);
    const remote = room && room.host.id !== state.self.id;
    if (request.method === 'thread/list') {
      listRequests.set(request.id, request.params || {});
      if (listRequests.size > 100) listRequests.delete(listRequests.keys().next().value);
    }
    if (!room && knownRemote.has(threadId)) {
      queueMicrotask(() => response(request, null, new Error('This shared chat is disconnected. Ask the host to invite you again.')));
      return;
    }
    const mutation = /^(turn\/|thread\/(?:queue\/|rollback|fork|delete|archive|name\/set|settings\/update|inject_items|start))/.test(request.method);
    if (!room || (!remote && (room.members.length < 2 || !mutation || request.method === 'turn/interrupt'))) return originalPost.call(transport, message);
    void action('native-request', { roomId: room.id, method: request.method,
      params: { ...request.params, threadId: room.threadId }, requestId: crypto.randomUUID() })
      .then(result => response(request, remote ? rewrite(result, room.threadId, room.id) : result))
      .catch(error => { response(request, null, error); toast(error.message); });
  }
  transport.postMessage = post;
  cleanups.push(() => { if (transport.postMessage === post) transport.postMessage = originalPost; });
  cleanups.push(bus.interceptHostMessages(message => {
    if (message.type !== 'mcp-response' || message.hostId !== 'local') return false;
    const request = listRequests.get(message.message?.id);
    if (!request) return false;
    listRequests.delete(message.message.id);
    const result = message.message.result;
    if (!result?.data || request.archived || request.cursor || request.parentThreadId || request.ancestorThreadId) return false;
    const threads = state.rooms.filter(room => room.host.id !== state.self.id).map(remoteThread);
    result.data = [...threads.filter(thread => !result.data.some(existing => existing.id === thread.id)), ...result.data];
    return false;
  }));
  cleanups.push(bus.subscribe('mcp-response', message => {
    if (message.hostId !== 'local') return;
    const reply = message.message;
    const waiter = pending.get(reply?.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(reply.error.message || 'Codex request failed.'));
    else waiter.resolve(reply.result);
  }));
  cleanups.push(bus.subscribe('mcp-notification', message => {
    if (!managed && message.hostId === 'local' && hosted.has(message.params?.threadId)) send({ type: 'notification', method: message.method, params: message.params });
  }));
  cleanups.push(bus.subscribe('mcp-request', message => {
    if (message.hostId === 'local' && hosted.has(message.request?.params?.threadId)) send({ type: 'approval', threadId: message.request.params.threadId });
  }));

  const fiber = node => node?.[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
  function menuProps(row) {
    for (let current = fiber(row), depth = 0; current && depth < 35; current = current.return, depth++) {
      const props = current.memoizedProps;
      if (props && (typeof props.getItems === 'function' || Array.isArray(props.items)) && (props.trigger == null || props.trigger === 'contextmenu')) {
        let format;
        for (let dependency = current.dependencies?.firstContext; dependency; dependency = dependency.next) {
          if (dependency.memoizedValue?.formatMessage) format = dependency.memoizedValue.formatMessage;
        }
        return { props, format };
      }
    }
    return null;
  }
  function nativeItems(items, format) {
    return items.map(item => ({ id: item.id, type: ['separator', 'radio'].includes(item.type) ? item.type : undefined,
      label: item.type === 'separator' ? '' : `${item.checked && item.type !== 'radio' ? '✓ ' : ''}${item.nativeLabel || item.label || (item.message && (format?.(item.message, item.messageValues) || item.message.defaultMessage)) || item.id}`,
      checked: item.type === 'radio' ? item.checked === true : undefined,
      role: item.nativeRole, enabled: item.type !== 'label' && item.enabled !== false,
      icon: nativeIcon(item.nativeIcon ?? item.icon), accelerator: item.accelerator,
      toolTip: item.nativeTooltip || (item.tooltipMessage && (format?.(item.tooltipMessage, item.tooltipMessageValues) || item.tooltipMessage.defaultMessage)),
      submenu: item.submenu && nativeItems(item.submenu, format),
    }));
  }
  function nativeIcon(icon) {
    if (typeof icon === 'string') return icon;
    if (typeof icon?.createElement !== 'function') return undefined;
    return `data:image/svg+xml;utf8,${encodeURIComponent(new XMLSerializer().serializeToString(icon.createElement(document)))}`;
  }
  function findItem(items, id) {
    for (const item of items) {
      if (item.id === id) return item;
      const child = item.submenu && findItem(item.submenu, id);
      if (child) return child;
    }
  }
  const contextMenu = event => {
    const row = event.target instanceof Element && event.target.closest('[data-app-action-sidebar-thread-row]');
    const threadId = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
    const hostId = row?.getAttribute('data-app-action-sidebar-thread-host-id');
    if (!threadId || (hostId && hostId !== 'local')) return;
    const menu = menuProps(row);
    if (!menu) { toast('This chat’s native menu could not be extended on this Codex build.'); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    const title = row.getAttribute('data-app-action-sidebar-thread-title') || row.querySelector('[data-thread-title]')?.textContent || 'Shared conversation';
    void (async () => {
      const { props, format } = menu;
      try {
        await props.onBeforeOpen?.();
        const existing = await (props.getItems ? props.getItems() : props.items);
        const multiplayer = { id: 'multiplayer-share', label: 'Multiplayer',
          nativeIcon: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="6.25" r="2.75"/><path d="M1.75 16.5v-1.25A4.25 4.25 0 0 1 6 11h2a4.25 4.25 0 0 1 4.25 4.25v1.25M13 3.65a2.75 2.75 0 0 1 0 5.2M14.5 11.25a4.25 4.25 0 0 1 3.75 4.22v1.03"/></svg>')}`,
          onSelect: () => openShare(threadId, title) };
        const items = [...existing];
        const shareIndex = items.findIndex(item => ['share-thread', 'share-chatgpt-conversation', 'share'].includes(item.id));
        if (shareIndex >= 0) items.splice(shareIndex, 0, multiplayer);
        else items.push({ id: 'multiplayer-separator', type: 'separator' }, multiplayer);
        props.onOpenChange?.(true);
        const selected = await window.electronBridge.showContextMenu(nativeItems(items, format), { x: event.clientX, y: event.clientY });
        const item = findItem(items, selected?.id);
        if (item?.enabled !== false && item?.nativeRole == null) await item?.onSelect?.();
      } finally { props.onOpenChange?.(false); props.onAfterClose?.(); }
    })().catch(error => toast(error.message));
  };
  document.addEventListener('contextmenu', contextMenu, true);
  cleanups.push(() => document.removeEventListener('contextmenu', contextMenu, true));

  const style = document.createElement('style');
  style.textContent = `.multiplayer-presence{display:inline-flex;align-items:center;margin-left:7px;gap:2px;vertical-align:middle;flex-shrink:0}.multiplayer-initial{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;border-radius:50%;background:#d8d3f2;color:#403766;font:600 9px -apple-system,BlinkMacSystemFont,sans-serif;border:1.5px solid var(--color-background-surface,#f5f5f5)}[data-multiplayer-author]{position:relative}`;
  document.head.append(style);
  const avatarSize = 28;
  style.textContent += `.multiplayer-message-avatar{display:inline-flex;align-items:center;justify-content:center;position:absolute;z-index:1;box-sizing:border-box;width:${avatarSize}px;height:${avatarSize}px;border:2px solid var(--color-background-surface,#202020);border-radius:50%;background:#d8d3f2;color:#403766;font:500 11px -apple-system,BlinkMacSystemFont,sans-serif;user-select:none}`;
  const initials = name => String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const messageUnits = '[data-content-search-unit-key], [data-local-conversation-user-anchor]';
  const observedBubbles = new Set();
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleDecoration()) : null;
  let lastDecorationSummary;
  function messageIdentity(anchor, diagnostics) {
    let primaryMessage = anchor.hasAttribute('data-local-conversation-user-anchor');
    const searchKey = anchor.getAttribute('data-content-search-unit-key');
    const searchTurnId = searchKey?.includes(':') ? searchKey.slice(0, searchKey.indexOf(':')) : null;
    const observed = new Set();
    const count = key => { if (!observed.has(key)) { observed.add(key); diagnostics[key]++; } };
    const roomForProps = props => {
      if (typeof props?.conversationId !== 'string') return null;
      count('conversationProps');
      const room = state.rooms.find(room => nativeId(room) === normalize(props.conversationId));
      if (room) count('roomMatches');
      return room;
    };
    const turnIdentity = (room, props) => {
      const author = room?.authors?.turns?.[props.turnId ?? props.turn?.turnId]
        || room?.authors?.turns?.[searchTurnId];
      if (author) { count('turnMatches'); return { room, author }; }
    };
    const resolve = props => {
      if (props?.item?.type !== 'user-message') return;
      count('messageProps');
      primaryMessage = props.item.steeringStatus == null;
      const room = roomForProps(props);
      if (!room) return;
      const item = props.item;
      const turnKey = typeof props.toolActivityTurnKey === 'string' ? props.toolActivityTurnKey.split('\0').at(-1) : null;
      const author = room.authors?.items?.[item.searchItemId] || room.authors?.items?.[item.id];
      if (author) { count('messageMatches'); return { room, author }; }
      if (!primaryMessage) return;
      const turnAuthor = room.authors?.turns?.[turnKey] || room.authors?.turns?.[props.historyEntityKey];
      if (turnAuthor) { count('turnMatches'); return { room, author: turnAuthor }; }
      return turnIdentity(room, props);
    };
    if (fiber(anchor)) count('reactAnchors');
    const hostProps = anchor[Object.keys(anchor).find(key => key.startsWith('__reactProps$'))] || fiber(anchor)?.memoizedProps;
    const children = [hostProps];
    for (let count = 0; children.length && count < 128; count++) {
      const props = children.shift();
      const result = resolve(props);
      if (result) return result;
      for (const child of [props?.children].flat()) if (child?.props) children.push(child.props);
    }
    const visited = new Set();
    for (const node of [anchor, ...anchor.querySelectorAll('*')]) {
      if (node.closest('.multiplayer-message-avatar')) continue;
      if (node.closest(messageUnits) !== anchor) continue;
      for (let current = fiber(node), depth = 0; current && depth < 96; current = current.return, depth++) {
        if (visited.has(current)) break;
        visited.add(current);
        const result = resolve(current.memoizedProps);
        if (result) return result;
        const props = current.memoizedProps;
        const room = roomForProps(props);
        const turn = primaryMessage && turnIdentity(room, props || {});
        if (turn) return turn;
      }
    }
  }
  function decorate() {
    if (disposed) return;
    const expected = new Set();
    const bubbles = new Set();
    const diagnostics = { reactAnchors: 0, conversationProps: 0, roomMatches: 0, messageProps: 0, messageMatches: 0, turnMatches: 0, ownMessages: 0 };
    for (const row of document.querySelectorAll('[data-app-action-sidebar-thread-row]')) {
      const threadId = normalize(row.getAttribute('data-app-action-sidebar-thread-id'));
      const room = state.rooms.find(room => nativeId(room) === threadId);
      const members = room?.members.filter(member => member.id !== state.self.id) || [];
      let presence = row.querySelector('.multiplayer-presence');
      if (!members.length) { presence?.remove(); continue; }
      const key = JSON.stringify(members.map(member => [member.id, member.name, member.avatar]));
      if (presence?.dataset.members === key) continue;
      if (!presence) {
        presence = document.createElement('span');
        presence.className = 'multiplayer-presence';
        const title = row.querySelector('[data-thread-title]');
        if (title) title.after(presence); else row.append(presence);
      }
      presence.dataset.members = key;
      presence.replaceChildren(...members.map(member => {
        const avatar = document.createElement('span');
        avatar.className = 'multiplayer-initial';
        avatar.textContent = initials(member.name);
        window.__applyMultiplayerAvatar?.(avatar, member);
        avatar.style.borderColor = window.__multiplayerParticipantColor?.(member) || '#a8c7fa';
        avatar.title = `${member.name} · In this chat`;
        avatar.setAttribute('aria-label', avatar.title);
        return avatar;
      }));
    }
    for (const anchor of document.querySelectorAll(messageUnits)) {
      const { room, author } = messageIdentity(anchor, diagnostics) || {};
      if (!author) continue;
      if (author.id === state.self.id) { diagnostics.ownMessages++; continue; }
      const bubble = anchor.querySelector('[data-user-message-bubble]');
      if (!bubble) continue;
      expected.add(anchor);
      bubbles.add(bubble);
      bubbles.add(anchor);
      if (anchor.getAttribute('data-multiplayer-author') !== author.name) anchor.setAttribute('data-multiplayer-author', author.name);
      const person = room.members.find(member => member.id === author.id) || author;
      const key = JSON.stringify([person.id, person.name, person.avatar]);
      let avatar = anchor.querySelector('.multiplayer-message-avatar');
      if (avatar?.dataset.person !== key) {
        avatar?.remove();
        avatar = document.createElement('span');
        avatar.className = 'multiplayer-message-avatar';
        avatar.dataset.person = key;
        avatar.textContent = initials(person.name);
        window.__applyMultiplayerAvatar?.(avatar, person);
        avatar.style.borderColor = window.__multiplayerParticipantColor?.(person) || '#a8c7fa';
        avatar.style.position = 'absolute';
        avatar.title = person.name;
        avatar.setAttribute('role', 'img');
        avatar.setAttribute('aria-label', `${person.name} · Sent this message`);
        anchor.append(avatar);
      }
      const bounds = bubble.getBoundingClientRect();
      const origin = anchor.getBoundingClientRect();
      const left = `${bounds.right - origin.left - anchor.clientLeft + anchor.scrollLeft - avatarSize / 2}px`;
      const top = `${bounds.bottom - origin.top - anchor.clientTop + anchor.scrollTop - avatarSize / 2}px`;
      if (avatar.style.left !== left) avatar.style.left = left;
      if (avatar.style.top !== top) avatar.style.top = top;
    }
    for (const anchor of document.querySelectorAll('[data-multiplayer-author]')) if (!expected.has(anchor)) {
      anchor.removeAttribute('data-multiplayer-author');
      anchor.querySelector('.multiplayer-message-avatar')?.remove();
    }
    for (const bubble of observedBubbles) if (!bubbles.has(bubble)) { resizeObserver?.unobserve(bubble); observedBubbles.delete(bubble); }
    for (const bubble of bubbles) if (!observedBubbles.has(bubble)) { resizeObserver?.observe(bubble); observedBubbles.add(bubble); }
    const summary = { anchors: document.querySelectorAll(messageUnits).length,
      marked: expected.size, turnAuthors: state.rooms.reduce((count, room) => count + Object.keys(room.authors?.turns || {}).length, 0),
      itemAuthors: state.rooms.reduce((count, room) => count + Object.keys(room.authors?.items || {}).length, 0), ...diagnostics };
    const summaryKey = JSON.stringify(summary);
    if (summaryKey !== lastDecorationSummary) {
      lastDecorationSummary = summaryKey;
      send({ type: 'decoration-diagnostics', summary });
    }
  }
  let scheduled;
  function scheduleDecoration() { if (!disposed && !scheduled) scheduled = requestAnimationFrame(() => { scheduled = null; decorate(); }); }
  const observer = new MutationObserver(scheduleDecoration);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-content-search-unit-key', 'data-app-action-sidebar-thread-id'] });
  window.addEventListener('resize', scheduleDecoration);
  cleanups.push(() => { resizeObserver?.disconnect(); observedBubbles.clear(); window.removeEventListener('resize', scheduleDecoration); });
  let lastProfile;
  const syncProfile = () => {
    const profile = window.__readMultiplayerProfile?.(url => action('profile-image', { url }));
    const key = JSON.stringify(profile);
    if (key === lastProfile) return;
    lastProfile = key;
    send({ type: 'profile', profile });
  };
  const profileTimer = setInterval(syncProfile, 3000);
  queueMicrotask(syncProfile);
  cleanups.push(() => clearInterval(profileTimer));

  return {
    update(next) {
      state = next;
      managed?.update(next);
      presence?.update(next);
      hosted.clear();
      for (const room of state.rooms) {
        if (room.host.id === state.self.id) { hosted.add(room.threadId); continue; }
        if (!knownRemote.has(room.id)) {
          knownRemote.set(room.id, room);
          if (!managed) {
            deliver({ type: 'mcp-notification', hostId: 'local', method: 'thread/started', params: { thread: remoteThread(room) } });
            deliver({ type: 'navigate-to-route', path: `/local/${room.id}` });
          }
        }
      }
      decorate();
    },
    event(event) {
      if (managed) { managed.event(event); decorate(); return; }
      const room = state.rooms.find(room => room.id === event.roomId && room.host.id !== state.self.id);
      if (!room || event.params?.threadId !== room.threadId) return;
      deliver({ type: 'mcp-notification', hostId: 'local', method: event.method, params: rewrite(event.params, room.threadId, room.id) });
      decorate();
    },
    rpc(method, params) {
      if (method === 'thread/resume') hosted.add(params.threadId);
      if (managed) return managed.rpc(method, params);
      const id = `multiplayer-rpc-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex did not respond. Check the original chat.')); }, 30_000);
        pending.set(id, { resolve, reject, timer });
        Promise.resolve(window.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request: { id, method, params } }))
          .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
      });
    },
    cleanup() {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      cleanups.reverse().forEach(cleanup => cleanup());
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Multiplayer disconnected.')); }
      for (const node of document.querySelectorAll('.multiplayer-presence,.multiplayer-message-avatar')) node.remove();
      for (const node of document.querySelectorAll('[data-multiplayer-author]')) node.removeAttribute('data-multiplayer-author');
      style.remove();
    },
  };
};
