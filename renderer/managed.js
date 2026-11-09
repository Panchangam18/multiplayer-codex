window.__createMultiplayerManaged = ({ runtime, action, send, toast, navigate }) => {
  const cached = id => {
    const value = runtime.c?.[id]?.exports;
    if (!value) throw new Error(`Unsupported Codex build: missing native module ${id}.`);
    return value;
  };
  const { O3: Manager, gR: ManagerTarget } = cached('V7mA');
  const { TF: RpcTarget, AX: RpcStub } = cached('Fkn8');
  const connectionAtom = cached('l00C').M4;
  const routerAtom = cached('Dgwo').p;
  const scopeType = cached('OWtl').u;
  if ([Manager, ManagerTarget, RpcTarget, RpcStub].some(value => typeof value !== 'function') || !connectionAtom || !routerAtom || !scopeType) throw new Error('Unsupported Codex build: native conversation adapter exports changed.');
  const noop = () => {};
  let scope = window.__multiplayerFixtureScope;
  for (const node of document.querySelectorAll('aside, [data-app-action-sidebar-thread-row]')) {
    if (scope) break;
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 60 && !scope; fiber = fiber.return, depth++) {
      for (let hook = fiber.memoizedState, count = 0; hook && count < 120; hook = hook.next, count++) {
        const candidate = hook.memoizedState?.current;
        if (candidate?.scope === scopeType && typeof candidate.get === 'function' && typeof candidate.set === 'function') { scope = candidate; break; }
      }
    }
  }
  const connection = scope?.get(connectionAtom, 'local');
  const router = scope?.get(routerAtom);
  if (!connection?.client?.rpc || !router || typeof router.forHost !== 'function' || typeof scope.watch !== 'function') throw new Error('Unsupported Codex build: native conversation services are not ready.');
  let original = connection.client.rpc;
  const originalForHost = router.forHost;
  const aliases = new Set();
  const hydrated = new Set();
  const loading = new Map();
  const buffered = new Map();
  const readStates = new Map();
  const readStateListeners = new Set();
  const leases = new Set();
  let state = { self: {}, rooms: [] };
  let closed = false;
  let viewedId = null;
  const clearViewedUnread = () => {
    if (!closed && viewedId && guestRoom(viewedId) && native.getConversation(viewedId)) native.markConversationAsRead(viewedId);
  };
  const roomFor = id => state.rooms.find(room => (room.host.id === state.self.id ? room.threadId : room.id) === id);
  const guestRoom = id => { const room = roomFor(id); return room?.host.id !== state.self.id ? room : null; };
  const rewrite = (value, from, to) => {
    if (Array.isArray(value)) return value.map(entry => rewrite(entry, from, to));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      ['id', 'threadId', 'conversationId'].includes(key) && entry === from ? to : rewrite(entry, from, to)]));
  };
  const requireRoom = id => {
    const room = roomFor(id);
    if (closed || !room) throw new Error('This shared chat is disconnected. Ask the host to invite you again.');
    return room;
  };
  const request = async (id, method, params = {}) => {
    const room = requireRoom(id);
    const result = await action('native-request', { roomId: room.id, method,
      params: { ...params, threadId: room.threadId }, requestId: crypto.randomUUID() });
    requireRoom(id);
    return room.host.id === state.self.id ? result : rewrite(result, room.threadId, room.id);
  };
  const scheduler = { schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
    scheduleMicrotask: callback => queueMicrotask(callback), canUseAnimationFrame: () => false, subscribeVisibilityChange: () => noop };
  const native = new Manager({ hostId: 'local',
    transport: { hostId: 'local', getAppServerVersion: () => null, supportsPaginatedThreadHistory: () => true,
      addRequestLifecycleListener: () => noop, getPendingRequestCount: () => 0,
      sendRequest: (method, params) => request(params?.threadId, method, params) },
    logger: { debug: noop, warning: noop, error: noop, info: noop, trace: noop },
    storage: { readValue: () => null, readGlobalState: async () => undefined },
    savedReadState: { syncWithServer: false,
      subscribe: listener => { readStateListeners.add(listener); return () => readStateListeners.delete(listener); },
      has: id => readStates.get(id) ?? false, isReady: () => true,
      set: (id, hasUnreadTurn) => { readStates.set(id, hasUnreadTurn); for (const listener of readStateListeners) listener({ threadId: id, hasUnreadTurn }); } },
    threadProjectAssignments: {}, filesystem: { attachments: { createId: () => crypto.randomUUID() } }, scheduler,
    settings: { restricted: {}, readFollowUpQueueMode: () => 'send-only', readPermissionRefreshEnabled: () => false,
      history: { canonicalTurnHistory: false, useTailHydration: false, paginatedHistoryEnabled: false,
        readThreadTimelineEnabled: () => false, readActiveHistoryEvictionEnabled: () => false,
        readCatalogConsumptionEnabled: () => false, readRetainedRecentThreadIds: () => new Set(), readThreadListOriginators: () => [] } },
    runtime: { threadMode: () => 'local', accountId: () => null,
      queuedMessages: { requiresReplayAdmission: false, automaticExecutionEnabled: false, isHostForConversation: () => true } },
    pendingThreadArchives: {}, sendAppServerResponse: () => { throw new Error('Approvals stay on the host.'); },
  });
  native.threadExecution = { executeDynamicToolCall: () => { throw new Error('Tools execute only on the host.'); } };
  const nativeTarget = new ManagerTarget(() => native);
  const nativeRpc = new RpcStub(nativeTarget);
  async function hydrate(id) {
    requireRoom(id);
    if (hydrated.has(id)) return;
    if (loading.has(id)) return loading.get(id);
    const promise = (async () => {
      const queue = { events: [], bytes: 0, overflow: false };
      buffered.set(id, queue);
      const result = await request(id, 'thread/read', { includeTurns: true });
      if (queue.overflow) throw new Error('Shared chat changed too quickly while loading. Please reopen the chat.');
      const thread = result.thread;
      if (!thread || thread.id !== id || !Array.isArray(thread.turns)) throw new Error('The host returned incomplete shared history.');
      native.onNotification('thread/started', { thread });
      const permissions = { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } };
      const execution = requireRoom(id).execution || {};
      const turns = native.history.mapThreadTurns({ threadId: id, turns: thread.turns, model: execution.model || '', reasoningEffort: execution.reasoningEffort ?? null, cwd: thread.cwd, permissions });
      native.setConversation({ ...native.getConversation(id), turns, resumeState: 'resumed', currentPermissions: permissions,
        ...modelFields(execution) });
      native.setConversationStreamRole(id, { role: 'owner' });
      native.ensureRecentConversationId(id);
      native.threadStore.replaceThreadSummaries([...native.getThreadSummaries().filter(summary => summary.conversationId !== id), native.threadStore.getThreadSummaryFromThread(thread)]);
      native.notifyConversationUpdated(id);
      hydrated.add(id);
      native.beginResumeNotificationBuffer(id);
      for (const event of queue.events) native.onNotification(event.method, event.params);
      native.releaseResumeNotificationBuffer(id);
      clearViewedUnread();
    })().finally(() => { loading.delete(id); buffered.delete(id); native.resumeNotificationBuffer.buffers.delete(id); });
    loading.set(id, promise);
    return promise;
  }
  function modelFields(execution) {
    return execution?.model ? { latestModel: execution.model, latestReasoningEffort: execution.reasoningEffort ?? null,
      latestCollaborationMode: { mode: 'default', settings: { model: execution.model, reasoning_effort: execution.reasoningEffort ?? null, developer_instructions: null } } } : {};
  }
  const sendInput = async (id, input, clientUserMessageId) => {
    const room = requireRoom(id);
    if (room.active) throw new Error('Codex is working. Wait for this turn to finish before sending.');
    if (!Array.isArray(input) || !input.length || input.some(part => !(part.type === 'text' && typeof part.text === 'string')
      && !(part.type === 'image' && typeof part.url === 'string') && !(part.type === 'localImage' && typeof part.path === 'string'))) throw new Error('Multiplayer supports text and raster images only.');
    return request(id, 'turn/start', { input, ...(typeof clientUserMessageId === 'string' ? { clientUserMessageId } : {}) });
  };
  const unsupported = (method = 'action') => { throw new Error(`This action is unavailable in a shared chat (${method}). Approvals and tools stay on the host.`); };
  const sharedId = args => {
    const visit = (value, depth = 0) => {
      if (typeof value === 'string') return aliases.has(value) || roomFor(value)?.members.length > 1 ? value : null;
      if (!value || typeof value !== 'object' || depth > 4) return null;
      for (const key of ['conversationId', 'threadId', 'id', 'key', 'request', 'params', 'options']) {
        const id = visit(value[key], depth + 1);
        if (id) return id;
      }
      return null;
    };
    return args.slice(0, 2).map(value => visit(value)).find(Boolean) || null;
  };
  class Lease extends RpcTarget {
    constructor(dispose) { super(); this.dispose = dispose; }
    unsubscribe() { this.dispose?.(); this.dispose = null; }
    [Symbol.dispose]() { this.unsubscribe(); }
  }
  const retain = async subscription => {
    const lease = await subscription;
    if (closed) lease[Symbol.dispose](); else leases.add(lease);
    return lease;
  };
  class Coordinator extends RpcTarget {
    async sendMessage(options, prepare, onMessageAdded, beforeSend, assertAdmission) {
      const id = sharedId([options]);
      if (!id) return original.getTurnCoordinator().sendMessage(options, prepare, onMessageAdded, beforeSend, assertAdmission);
      const message = options.message;
      const context = message?.context;
      if (options.editPosition || [context?.addedFiles, context?.fileAttachments, context?.mcpAppModelContextAttachments].some(value => value?.length)) return unsupported();
      const text = context?.prompt ?? message?.text;
      const images = (context?.imageAttachments || []).map(image => {
        const path = image.localPath || (typeof image.src === 'string' && image.src.startsWith('/') ? image.src : null);
        if (typeof path === 'string' && path.startsWith('/')) return { type: 'localImage', path };
        if (typeof image.src === 'string' && image.src.startsWith('data:image/')) return { type: 'image', url: image.src };
        throw new Error('This image is not available locally. Reattach it from this computer.');
      });
      if (typeof text !== 'string' || (!text.trim() && !images.length)) return unsupported();
      await assertAdmission?.();
      await beforeSend?.();
      const result = await sendInput(id, [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images], message.id);
      try { await onMessageAdded?.({ locallyAccepted: false }); } catch {}
      return { status: 'sent', kind: 'start', turnId: result.turn.id };
    }
    deferAutomaticTurns(id) { return sharedId([id]) ? new Lease(noop) : original.getTurnCoordinator().deferAutomaticTurns(id); }
  }
  for (const method of ['sendQueuedMessageNow', 'removeQueuedMessage', 'clearQueuedMessages', 'restoreQueuedMessage', 'reorderQueuedMessages', 'resumeInterruptedQueuedMessages']) {
    Coordinator.prototype[method] = function(...args) { return sharedId(args) ? unsupported() : original.getTurnCoordinator()[method](...args); };
  }
  const coordinator = new Coordinator();
  const guestReads = new Set(['getFollowUpContext', 'getLatestTurnMessages', 'getConversation', 'getCachedConversationMetadata', 'getConversationCwd', 'getThreadExecutionState',
    'getStreamRole', 'getCurrentPermissions', 'getTurnModelContext', 'getTurnSandboxPolicy', 'getConversationTitleInput',
    'getRealtimeCallMetadata', 'getThreadWritableRoots', 'getThreadWorkspaceState', 'getThreadGoal', 'getTurn', 'isConversationArchiving',
    'getConversationTurnHistoryTimeline', 'getLoadedConversationHistoryTurns', 'getThreadHasUnreadTurn', 'getConversationTitle',
    'getThreadStartKind', 'getForkTitleEntries', 'getPastedTextExcerpts', 'getThreadTokenUsage', 'getTurnDiffContext']);
  const guestReadState = new Set(['markConversationAsRead', 'markConversationAsUnread', 'recordUnreadMessage']);
  const noopGuest = new Set(['updateThreadViewActivity']);
  const baseTarget = new class extends RpcTarget {}();
  const target = new Proxy(baseTarget, {
    get(object, method, receiver) {
      if (typeof method !== 'string' || method === 'then' || method === 'constructor') return Reflect.get(object, method, receiver);
      if (method === 'getTurnCoordinator') return () => coordinator;
      if (method === 'markConversationsAsRead') return async (ids, mode) => {
        const shared = ids.filter(id => aliases.has(id));
        for (const id of shared) requireRoom(id);
        const local = ids.filter(id => !aliases.has(id));
        const failed = shared.length ? await nativeRpc.markConversationsAsRead(shared, mode) : [];
        return local.length ? [...failed, ...await original.markConversationsAsRead(local, mode)] : failed;
      };
      if (method === 'subscribe') return async options => {
        const id = options.key?.threadId || options.key?.conversationId;
        if (aliases.has(id)) return nativeRpc.subscribe(options);
        const mergeFields = new Set(['recentThreads', 'threadSummaryIds', 'threadStatuses']);
        if (options.type !== 'host' || !mergeFields.has(options.field)) return original.subscribe(options);
        const callback = options.listener.dup();
        let localValue, sharedValue;
        const publish = () => {
          if (localValue === undefined || sharedValue === undefined) return;
          const value = options.field === 'threadSummaryIds'
            ? { all: [...new Set([...sharedValue.all, ...localValue.all])], topLevel: [...new Set([...sharedValue.topLevel, ...localValue.topLevel])] }
            : [...sharedValue, ...localValue];
          void callback(value).catch(noop);
        };
        let localLease, sharedLease;
        const dispose = () => { localLease?.[Symbol.dispose](); sharedLease?.[Symbol.dispose](); callback[Symbol.dispose](); };
        try {
          localLease = await original.subscribe({ ...options, listener: value => { localValue = value; publish(); } });
          sharedLease = await nativeRpc.subscribe({ ...options, listener: value => { sharedValue = value; publish(); } });
          return new Lease(dispose);
        } catch (error) { dispose(); throw error; }
      };
      return (...args) => {
        const id = sharedId(args);
        if (!id) return original[method](...args);
        const room = requireRoom(id);
        const guest = room.host.id !== state.self.id;
        if (method === 'resumeConversation' && guest) return hydrate(id).then(() => ({ status: 'ready', activeTurnId: null }));
        if (['startTurn', 'startTurnWithOutcome'].includes(method)) {
          const operation = args[0]?.request || args[1]?.request || args[1];
          const result = sendInput(id, operation?.input, operation?.clientUserMessageId);
          return method === 'startTurnWithOutcome' ? result.then(() => 'accepted') : result;
        }
        if (method === 'sendRequest' && guest) return request(id, args[0], args[1]);
        if (!guest) return original[method](...args);
        if (method === 'getThreadHasUnreadTurn') return native.getThreadHasUnreadTurn(id);
        if (guestReadState.has(method)) return Promise.resolve(nativeRpc[method](...args)).then(result => { clearViewedUnread(); return result; });
        if (['markConversationRead', 'markThreadRead'].includes(method)) return native.markConversationAsRead(id);
        if (method === 'setConversationUnreadState') return native.setConversationUnreadState(id, args[1] === true);
        if (noopGuest.has(method)) return;
        if (method === 'ensureConversationHistoryLoaded') return hydrate(id);
        if (method === 'retainActiveConversation') return nativeRpc.retainActiveConversation(id);
        if (method === 'registerWindowActivity') return new Lease(noop);
        if (guestReads.has(method)) return nativeRpc[method](...args);
        if (['listThreadTurns', 'listThreadItems', 'readThread'].includes(method)) return nativeRpc[method](...args);
        return unsupported(method);
      };
    },
  });
  const facade = new RpcStub(target);
  const patchRouter = function(hostId) { return hostId === 'local' ? facade : originalForHost.call(this, hostId); };
  router.forHost = patchRouter;
  let installed;
  const stopWatch = scope.watch(({ get }) => {
    const current = get(connectionAtom, 'local');
    if (!current?.client || current.client.rpc === facade) return;
    original = current.client.rpc;
    installed = { ...current, client: { ...current.client, rpc: facade } };
    scope.set(connectionAtom, 'local', installed);
  });
  const methods = ['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed', 'turn/plan/updated', 'turn/diff/updated',
    'item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'error'];
  void retain(original.subscribe({ type: 'notification', key: { hostId: 'local' }, methods, listener: event => {
    if (state.rooms.some(room => room.host.id === state.self.id && room.threadId === event.params?.threadId)) send({ type: 'notification', method: event.method, params: event.params });
  } })).catch(error => toast(error.message));
  return {
    viewed(id) { viewedId = id; clearViewedUnread(); },
    update(next) {
      state = next;
      for (const room of state.rooms) {
        if (room.host.id === state.self.id) continue;
        if (hydrated.has(room.id) && room.execution?.model) {
          const conversation = native.getConversation(room.id);
          if (conversation && (conversation.latestModel !== room.execution.model || conversation.latestReasoningEffort !== room.execution.reasoningEffort)) {
            native.setConversation({ ...conversation, ...modelFields(room.execution) });
            native.notifyConversationUpdated(room.id);
          }
        }
        if (aliases.has(room.id)) continue;
        aliases.add(room.id);
        void hydrate(room.id).then(() => { if (!closed && guestRoom(room.id)) navigate(`/local/${room.id}`); }).catch(error => toast(error.message));
      }
    },
    event(event) {
      const room = state.rooms.find(room => room.id === event.roomId && room.host.id !== state.self.id);
      if (!room || event.params?.threadId !== room.threadId || (!hydrated.has(room.id) && !loading.has(room.id))) return;
      const params = rewrite(event.params, room.threadId, room.id);
      const queue = buffered.get(room.id);
      if (queue) {
        queue.bytes += JSON.stringify(params).length;
        if (queue.bytes > 64 * 1024 * 1024 || queue.events.length >= 10000) { queue.overflow = true; queue.events.length = 0; return; }
        if (!queue.overflow) queue.events.push({ method: event.method, params });
      } else { native.onNotification(event.method, params); clearViewedUnread(); }
    },
    rpc: (method, params) => original.sendRequest(method, params),
    cleanup() {
      closed = true;
      stopWatch();
      if (router.forHost === patchRouter) router.forHost = originalForHost;
      if (scope.get(connectionAtom, 'local') === installed) scope.set(connectionAtom, 'local', { ...installed, client: { ...installed.client, rpc: original } });
      for (const lease of leases) lease[Symbol.dispose]();
      facade[Symbol.dispose]();
      nativeRpc[Symbol.dispose]();
      Manager.dispose(native);
    },
  };
};
