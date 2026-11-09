window.__createMultiplayerPresence = ({ send, toast, viewed = () => {} }) => {
  let state = { self: {}, rooms: [] }, route, announced, lastInput = 0, lastSent = 0, lastKey = '';
  let observedPath = location.pathname;
  let disposed = false;
  const originalButtons = new Map();
  const surface = document.createElement('div');
  surface.className = 'multiplayer-live';
  surface.setAttribute('role', 'status');
  surface.setAttribute('aria-live', 'polite');
  const style = document.createElement('style');
  style.textContent = `.multiplayer-live:empty{display:none}.multiplayer-live{display:flex;flex-direction:column;align-items:flex-end;gap:22px;box-sizing:border-box;padding:8px 14px 14px;pointer-events:none}.multiplayer-typing{position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:64px;height:40px;border-radius:22px;background:var(--color-background-user-message,light-dark(#e9e9eb,#353537));color:inherit}.multiplayer-typing::before{content:"";position:absolute;right:5px;bottom:-3px;width:12px;height:12px;border-radius:0 0 3px 12px;background:inherit}.multiplayer-typing-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.multiplayer-typing-avatar{display:inline-flex;align-items:center;justify-content:center;position:absolute;right:-14px;bottom:-14px;z-index:1;box-sizing:border-box;width:28px;height:28px;border:2px solid #a8c7fa;border-radius:50%;background:#d8d3f2;color:#403766;font:500 11px -apple-system,BlinkMacSystemFont,sans-serif;user-select:none;pointer-events:auto}.multiplayer-dots{display:inline-flex;gap:4px}.multiplayer-dots i{width:6px;height:6px;border-radius:50%;background:var(--color-text-tertiary,#8e8e93);animation:multiplayer-pulse 1.2s infinite}.multiplayer-dots i:nth-child(2){animation-delay:.18s}.multiplayer-dots i:nth-child(3){animation-delay:.36s}@keyframes multiplayer-pulse{50%{opacity:.35;transform:translateY(-2px)}}@media(prefers-reduced-motion:reduce){.multiplayer-dots i{animation:none}}[data-multiplayer-model]{font-size:0!important}[data-multiplayer-model]>*{display:none!important}[data-multiplayer-model]::after{content:attr(data-multiplayer-model);font:500 12px -apple-system,BlinkMacSystemFont,sans-serif}`;
  document.head.append(style);
  const fiberFor = node => node?.[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
  const nativeConversation = composer => {
    for (let fiber = fiberFor(composer), depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
      for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
        const handle = hook.memoizedState?.current;
        const value = handle?.value;
        if (typeof handle?.get === 'function' && ['local', 'new', 'remote', 'cloud'].includes(value?.kind)) {
          return { known: true, id: value.kind === 'local' ? value.conversationId ?? null : null };
        }
      }
      const props = fiber.memoizedProps;
      if (props && Object.hasOwn(props, 'conversationId')) return { known: true, id: props.conversationId };
      for (let dependency = fiber.dependencies?.firstContext; dependency; dependency = dependency.next) {
        const value = dependency.memoizedValue?.value;
        if (value?.kind === 'local' && Object.hasOwn(value, 'conversationId')) return { known: true, id: value.conversationId };
      }
    }
    return { known: false };
  };
  const visible = composer => composer && !composer.closest('[hidden],[inert]') && composer.getClientRects().length > 0 && getComputedStyle(composer).visibility !== 'hidden';
  const getComposer = () => {
    const composers = [...document.querySelectorAll('[data-codex-composer-root]')].filter(visible);
    return composers.find(composer => composer.contains(document.activeElement)) || composers[0];
  };
  const currentRoom = composer => {
    if (location.pathname !== observedPath) { route = null; observedPath = location.pathname; }
    const context = nativeConversation(composer);
    const id = context.known ? context.id : (route || location.pathname).match(/\/local\/([^/?#]+)/)?.[1];
    return state.rooms.find(room => (room.host.id === state.self.id ? room.threadId : room.id) === id);
  };
  const stopTyping = () => {
    if (announced) send({ type: 'typing', roomId: announced, active: false });
    announced = null;
    lastSent = 0;
  };
  const input = event => {
    if (disposed) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const composer = target?.closest('[data-codex-composer-root]');
    if (!visible(composer)) return;
    const room = currentRoom(composer);
    if (!room || room.members.length < 2) return;
    const editor = target.closest('textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if (!editor) return;
    if (!(editor.value ?? editor.textContent)?.trim()) { stopTyping(); return; }
    if (announced && announced !== room.id) stopTyping();
    lastInput = Date.now();
    if (!announced || lastInput - lastSent > 1500) {
      announced = room.id;
      lastSent = lastInput;
      send({ type: 'typing', roomId: room.id, active: true });
    }
  };
  const beforeInput = event => queueMicrotask(() => input(event));
  function restoreButton(button, previous) {
    button.removeAttribute('data-multiplayer-model');
    for (const [name, value] of Object.entries(previous)) value === null ? button.removeAttribute(name) : button.setAttribute(name, value);
    originalButtons.delete(button);
  }
  function isModelButton(button) {
    if (originalButtons.has(button) || button.getAttribute('aria-label') === 'Select model') return true;
    let fiber = button[Object.keys(button).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      if (fiber.memoizedProps?.content === 'Select model') return true;
      if (fiber.memoizedProps?.['data-codex-composer-root'] !== undefined) break;
    }
    return false;
  }
  const blockModel = event => {
    const button = event.target.closest?.('[data-multiplayer-model]');
    if (!button || (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown'].includes(event.key))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('The host controls this chat’s model. Your message uses the host’s agent.');
  };
  function render() {
    const composer = getComposer();
    const room = currentRoom(composer);
    viewed(composer && document.visibilityState === 'visible' && document.hasFocus() && room?.host.id !== state.self.id ? room?.id ?? null : null);
    if (announced && (room?.id !== announced || Date.now() - lastInput > 2500)) stopTyping();
    const sending = new Set((room?.messages || []).filter(message => ['queued', 'sending'].includes(message.status)).map(message => message.author?.id));
    const active = new Set([...(room?.typing || []), ...sending]);
    const members = room?.members.filter(member => member.id !== state.self.id && active.has(member.id)) || [];
    const key = JSON.stringify(members.map(member => [member.id, member.name, member.avatar, sending.has(member.id)]));
    if (key !== lastKey) {
      lastKey = key;
      surface.replaceChildren(...members.map(member => {
        const bubble = document.createElement('span');
        bubble.className = 'multiplayer-typing';
        const label = document.createElement('span');
        label.className = 'multiplayer-typing-label';
        label.textContent = `${member.name} is ${sending.has(member.id) ? 'sending' : 'typing'}`;
        const dots = document.createElement('span');
        dots.className = 'multiplayer-dots';
        dots.setAttribute('aria-hidden', 'true');
        for (let count = 0; count < 3; count++) dots.append(document.createElement('i'));
        const avatar = document.createElement('span');
        avatar.className = 'multiplayer-typing-avatar';
        avatar.textContent = member.name?.[0]?.toUpperCase() || '?';
        window.__applyMultiplayerAvatar?.(avatar, member);
        avatar.style.position = 'absolute';
        avatar.style.borderColor = window.__multiplayerParticipantColor?.(member) || '#a8c7fa';
        avatar.title = member.name;
        avatar.setAttribute('aria-hidden', 'true');
        bubble.append(label, dots, avatar);
        return bubble;
      }));
    }
    if (composer && members.length) {
      const bounds = composer.getBoundingClientRect();
      surface.style.position = 'fixed';
      surface.style.left = `${Math.max(8, bounds.left)}px`;
      surface.style.bottom = `${Math.max(8, innerHeight - bounds.top + 6)}px`;
      surface.style.width = `${Math.max(0, Math.min(bounds.width, innerWidth - Math.max(8, bounds.left) - 8))}px`;
      surface.style.zIndex = '50';
      if (!surface.isConnected) document.body.append(surface);
    } else surface.remove();
    const guest = room && room.host.id !== state.self.id;
    for (const [button, previous] of originalButtons) if (!guest || !composer?.contains(button)) restoreButton(button, previous);
    if (!guest || !composer) return;
    const execution = room.execution;
    const label = execution?.model ? `${execution.model}${execution.reasoningEffort ? ` · ${execution.reasoningEffort}` : ''} · Host` : 'Host’s model';
    for (const button of composer.querySelectorAll('button')) {
      if (!isModelButton(button)) continue;
      if (!originalButtons.has(button)) originalButtons.set(button, Object.fromEntries(['title', 'aria-label', 'aria-disabled'].map(name => [name, button.getAttribute(name)])));
      if (button.getAttribute('data-multiplayer-model') === label) continue;
      button.setAttribute('data-multiplayer-model', label);
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('title', `Runs on ${room.host.name || 'the host'}’s computer. The host controls the model.`);
    }
  }
  document.addEventListener('input', input, true);
  document.addEventListener('beforeinput', beforeInput, true);
  document.addEventListener('focusout', stopTyping, true);
  document.addEventListener('click', blockModel, true);
  document.addEventListener('pointerdown', blockModel, true);
  document.addEventListener('keydown', blockModel, true);
  window.addEventListener('focus', render);
  window.addEventListener('blur', render);
  window.addEventListener('resize', render);
  document.addEventListener('visibilitychange', render);
  const timer = setInterval(render, 750);
  return {
    update(next) { state = next; render(); },
    navigate(path) { stopTyping(); route = path; render(); },
    cleanup() {
      disposed = true;
      stopTyping(); clearInterval(timer);
      document.removeEventListener('input', input, true);
      document.removeEventListener('beforeinput', beforeInput, true);
      document.removeEventListener('focusout', stopTyping, true);
      document.removeEventListener('click', blockModel, true);
      document.removeEventListener('pointerdown', blockModel, true);
      document.removeEventListener('keydown', blockModel, true);
      window.removeEventListener('focus', render);
      window.removeEventListener('blur', render);
      window.removeEventListener('resize', render);
      document.removeEventListener('visibilitychange', render);
      viewed(null);
      for (const [button, previous] of originalButtons) restoreButton(button, previous);
      surface.remove(); style.remove();
    },
  };
};
