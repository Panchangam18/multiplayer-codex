(() => {
  const handlers = new Map();
  const interceptors = new Set();
  const replies = new Map();
  const threads = new Map();
  window.fixtureCalls = [];
  window.fixtureMenus = [];
  window.fixtureRenamed = 0;
  window.fixtureTurn = 0;
  window.fixtureActive = 'fixture-thread';
  const initial = { id: 'history-turn', status: 'completed', items: [
    { id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'Let’s make onboarding feel a little more human.' }] },
    { id: 'history-agent', type: 'agentMessage', text: 'One welcoming screen, a clear first action, and the option to explore.' },
  ] };
  const thread = { id: 'fixture-thread', name: 'A calmer onboarding', preview: '', cwd: '/fixture/project', createdAt: 1, updatedAt: 1,
    modelProvider: 'openai', source: 'vscode', status: { type: 'idle' }, turns: [initial] };
  threads.set(thread.id, thread);
  const bus = {
    dispatchHostMessage(message) {
      for (const interceptor of interceptors) if (interceptor(message)) return;
      for (const handler of handlers.get(message.type) || []) handler(message);
    },
    interceptHostMessages(handler) { interceptors.add(handler); return () => interceptors.delete(handler); },
    subscribe(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type).delete(handler);
    },
  };
  const transport = { postMessage: message => window.electronBridge.sendMessageFromView(message), getState: () => null, setState() {} };
  window.__multiplayerFixtureExports = { bus, transport };
  const emit = message => bus.dispatchHostMessage({ hostId: 'local', ...message });
  window.fixtureRequest = (method, params) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    replies.set(id, { resolve, reject });
    transport.postMessage({ type: 'mcp-request', hostId: 'local', request: { id, method, params } });
  });
  bus.subscribe('mcp-response', message => {
    const reply = message.message;
    const waiter = replies.get(reply.id);
    if (!waiter) return;
    replies.delete(reply.id);
    if (reply.error) waiter.reject(new Error(reply.error.message)); else waiter.resolve(reply.result);
  });
  function sidebar(thread) {
    let row = [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].find(row => row.getAttribute('data-app-action-sidebar-thread-id') === thread.id);
    if (row) return row;
    row = document.createElement('div');
    row.setAttribute('data-app-action-sidebar-thread-row', '');
    row.setAttribute('data-app-action-sidebar-thread-id', thread.id);
    row.setAttribute('data-app-action-sidebar-thread-title', thread.name);
    row.setAttribute('data-app-action-sidebar-thread-host-id', 'local');
    const title = document.createElement('span');
    title.setAttribute('data-thread-title', '');
    title.textContent = thread.name;
    row.append(title);
    row.__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { getItems: () => [
      { id: 'rename', message: { defaultMessage: 'Rename' }, onSelect: () => window.fixtureRenamed++ },
      { id: 'share-thread', message: { defaultMessage: 'Share chat' }, onSelect: () => { window.fixtureShared = true; } },
      { id: 'archive', message: { defaultMessage: 'Archive' }, enabled: false },
    ] } } };
    row.addEventListener('dblclick', () => window.fixtureRenamed++);
    row.addEventListener('click', () => { window.fixtureActive = thread.id; render(); });
    document.querySelector('aside').append(row);
    return row;
  }
  function render() {
    const active = threads.get(window.fixtureActive);
    if (!active) return;
    document.querySelector('main h2').textContent = active.name;
    const timeline = document.querySelector('#native-timeline');
    timeline.replaceChildren();
    for (const turn of active.turns || []) for (const item of turn.items || []) {
      const bubble = document.createElement('article');
      bubble.dataset.itemId = item.id;
      bubble.className = item.type === 'userMessage' ? 'native-user' : 'native-agent';
      bubble.setAttribute('data-content-search-unit-key', `${turn.id}:${item.id}`);
      if (item.type === 'userMessage') {
        if (turn.id === 'history-turn') bubble.setAttribute('data-local-conversation-user-anchor', 'true');
        const props = {
          item: { type: 'user-message', searchItemId: item.id, ...(turn.id === 'history-turn' ? {} : { steeringStatus: 'accepted' }) },
          conversationId: active.id, toolActivityTurnKey: 'turn',
        };
        bubble.__reactFiber$fixture = { memoizedProps: { children: { props: { children: [{ props }] } } },
          return: { memoizedProps: { conversationId: active.id, turnId: turn.id } } };
      }
      const content = item.type === 'userMessage' ? document.createElement('div') : bubble;
      if (content !== bubble) { content.setAttribute('data-user-message-bubble', 'true'); bubble.append(content); }
      content.textContent = item.text || item.content?.map(part => part.text).join('\n') || '';
      for (const part of item.content || []) if (part.type === 'image') {
        const image = document.createElement('img');
        image.src = part.url;
        image.alt = 'Shared attachment';
        content.append(image);
      }
      timeline.append(bubble);
    }
    window.fixtureNativeMarkup = timeline.innerHTML;
  }
  bus.subscribe('navigate-to-route', async message => {
    const id = message.path.split('/').at(-1);
    window.fixtureActive = id;
    try {
      const result = await window.fixtureRequest('thread/resume', { threadId: id, excludeTurns: true });
      const page = await window.fixtureRequest('thread/turns/list', { threadId: id, itemsView: 'full' });
      threads.set(id, { ...result.thread, turns: page.data });
      render();
    } catch (error) { window.fixtureError = error.message; }
  });
  bus.subscribe('mcp-notification', message => {
    const { method, params } = message;
    if (method === 'thread/started') {
      threads.set(params.thread.id, params.thread);
      sidebar(params.thread);
      return;
    }
    const active = threads.get(params.threadId);
    if (!active) return;
    active.turns ||= [];
    let turn = active.turns.find(turn => turn.id === (params.turnId || params.turn?.id));
    if (!turn) { turn = { id: params.turnId || params.turn?.id, items: [] }; active.turns.push(turn); }
    if (method === 'item/started' || method === 'item/completed') {
      const index = turn.items.findIndex(item => item.id === params.item.id);
      if (index >= 0) turn.items[index] = params.item; else turn.items.push(params.item);
    }
    if (method === 'item/agentMessage/delta') {
      let item = turn.items.find(item => item.id === params.itemId);
      if (!item) { item = { id: params.itemId, type: 'agentMessage', text: '' }; turn.items.push(item); }
      item.text += params.delta;
    }
    if (method === 'turn/completed') turn.status = 'completed';
    render();
  });
  window.electronBridge = {
    async showContextMenu(items) { window.fixtureMenus.push(items); return { id: window.fixtureMenuChoice || 'multiplayer-share' }; },
    async sendMessageFromView(message) {
      const request = message.request;
      if (!request) return;
      window.fixtureCalls.push(request);
      const local = threads.get(request.params?.threadId);
      let result;
      if (request.method === 'thread/list') result = { data: [thread], nextCursor: null };
      else if (!local) { emit({ type: 'mcp-response', message: { id: request.id, error: { message: 'Unknown local thread' } } }); return; }
      else if (request.method === 'thread/read' || request.method === 'thread/resume') result = { thread: { ...local, turns: request.params.includeTurns ? local.turns : [] }, model: 'fixture-model', modelProvider: 'openai', cwd: '/fixture/project', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite' } };
      else if (request.method === 'thread/turns/list') result = { data: local.turns, nextCursor: null };
      else if (request.method === 'turn/start') {
        const turnId = `fixture-turn-${++window.fixtureTurn}`;
        const threadId = request.params.threadId;
        const turn = { id: turnId, status: 'inProgress', items: [] };
        result = { turn };
        setTimeout(() => emit({ type: 'mcp-notification', method: 'turn/started', params: { threadId, turn } }), 15);
        setTimeout(() => emit({ type: 'mcp-notification', method: 'item/completed', params: { threadId, turnId, item: { id: `user-${turnId}`, type: 'userMessage', content: request.params.input } } }), 25);
        setTimeout(() => emit({ type: 'mcp-notification', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `answer-${turnId}`, delta: 'Both suggestions are part of the same conversation. I’ll keep the welcome simple and let people explore.' } }), 70);
        setTimeout(() => emit({ type: 'mcp-notification', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }), 150);
      } else { emit({ type: 'mcp-response', message: { id: request.id, error: { message: 'Unknown fixture method' } } }); return; }
      queueMicrotask(() => emit({ type: 'mcp-response', message: { id: request.id, result } }));
    },
  };
  const composer = document.querySelector('#native-composer');
  window.fixtureComposerNode = composer;
  composer.addEventListener('submit', event => {
    event.preventDefault();
    const textarea = composer.querySelector('textarea');
    const text = textarea.value;
    if (!text.trim()) return;
    window.fixtureRequest('turn/start', { threadId: window.fixtureActive, input: [{ type: 'text', text, text_elements: [] }] })
      .then(() => { if (textarea.value === text) textarea.value = ''; }).catch(error => { window.fixtureError = error.message; });
  });
  sidebar(thread);
  render();
})();
