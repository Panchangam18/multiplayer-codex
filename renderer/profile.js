(() => {
  let imageKey;
  let imageData;
  let copyFailed = 0, retryFailed = 0;
  const thumbnail = image => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    canvas.getContext('2d').drawImage(image, 0, 0, 64, 64);
    const png = canvas.toDataURL('image/png');
    return png.length <= 32_000 ? png : undefined;
  };
  const portableColor = value => {
    if (/^(#[a-f\d]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value || '')) return value;
    if (!value || !globalThis.CSS?.supports?.('color', value)) return undefined;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    } catch { return undefined; }
  };
  window.__readMultiplayerProfile = copyImage => {
    const buttons = document.querySelectorAll('aside.app-shell-left-panel button, .sidebar-item button');
    let fallback;
    const probe = { buttons: 0, spans: 0, shortText: 0, images: 0, canvases: 0 };
    for (const button of buttons) {
      const fiberKey = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
      let identity;
      for (let current = button[fiberKey], depth = 0; current && depth < 30; current = current.return, depth++) {
        identity = current.memoizedProps?.sidebarFooter?.profileIdentity;
        if (identity) break;
      }
      const name = identity?.username?.trim() || identity?.displayName?.trim();
      if (!name) continue;
      const root = button.closest('.sidebar-item') || button;
      probe.buttons++;
      probe.spans += root.querySelectorAll('span').length;
      probe.shortText += [...root.querySelectorAll('*')].filter(node => /^[\p{L}\p{N}]{1,3}$/u.test(node.textContent.trim())).length;
      probe.images += root.querySelectorAll('img').length;
      probe.canvases += root.querySelectorAll('canvas').length;
      const avatar = {};
      const initial = [...root.querySelectorAll('span,div')].filter(node => (node.children.length === 0 || node.querySelector('svg text')) && /^[\p{L}\p{N}]{1,3}$/u.test(node.textContent.trim()))
        .sort((first, second) => Number(second.classList.contains('text-avatar-foreground')) - Number(first.classList.contains('text-avatar-foreground')))[0];
      if (initial) {
        avatar.initials = initial.textContent.trim();
        avatar.color = portableColor(getComputedStyle(initial).color);
        for (let node = initial; node && node !== root; node = node.parentElement) {
          const color = portableColor(getComputedStyle(node).backgroundColor);
          if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { avatar.background = color; break; }
        }
      }
      const image = root.querySelector('img');
      probe.imageWidth = image?.naturalWidth || 0;
      probe.httpsImage = Number(/^https:\/\//.test(image?.currentSrc || image?.src || ''));
      probe.dataImage = Number(/^data:/.test(image?.currentSrc || image?.src || ''));
      probe.blobImage = Number(/^blob:/.test(image?.currentSrc || image?.src || ''));
      const key = `${image?.currentSrc || image?.src || ''}:${image?.naturalWidth || 0}`;
      if (key !== imageKey) {
        imageKey = key;
        imageData = undefined;
        copyFailed = retryFailed = 0;
        if (image?.complete && image.naturalWidth) {
          try { imageData = thumbnail(image); }
          catch {
            copyFailed = 1;
            const source = image.currentSrc || image.src;
            if (/^https:\/\//.test(source)) {
              const readable = new Image();
              readable.crossOrigin = 'anonymous';
              readable.referrerPolicy = 'no-referrer';
              readable.onload = () => { if (imageKey === key) { try { imageData = thumbnail(readable); } catch { retryFailed = 1; } } };
              readable.onerror = () => {
                if (imageKey !== key) return;
                retryFailed = 1;
                if (!copyImage) return;
                void copyImage(source).then(({ dataUrl }) => {
                  if (imageKey !== key || typeof dataUrl !== 'string' || dataUrl.length > 3_000_000 || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(dataUrl)) return;
                  const local = new Image();
                  local.onload = () => { if (imageKey === key) { try { imageData = thumbnail(local); } catch {} } };
                  local.src = dataUrl;
                }).catch(() => {});
              };
              readable.src = source;
            }
          }
        }
      }
      probe.copyFailed = copyFailed;
      probe.retryFailed = retryFailed;
      if (imageData) avatar.image = imageData;
      if (!initial && !imageData) { fallback ||= { name, avatar, probe }; continue; }
      return { name, avatar, probe };
    }
    return fallback || null;
  };
  window.__multiplayerParticipantColor = person => {
    const palette = ['#a8c7fa', '#b5dbc2', '#d3bbed', '#f0cab0', '#edbfd3', '#add8df'];
    let hash = 0;
    for (const character of String(person?.id || person?.name || '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    return palette[hash % palette.length];
  };
  window.__applyMultiplayerAvatar = (node, person) => {
    const avatar = person?.avatar;
    node.textContent = avatar?.initials || String(person?.name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    for (const key of ['background', 'color']) {
      if (typeof avatar?.[key] === 'string' && /^(#[a-f\d]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(avatar[key]) && avatar[key].length < 60) node.style[key] = avatar[key];
    }
    if (typeof avatar?.image === 'string' && avatar.image.length <= 32_000 && /^data:image\/png;base64,[A-Za-z\d+/]+=*$/.test(avatar.image)) {
      const image = document.createElement('img');
      image.src = avatar.image;
      image.alt = '';
      image.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit';
      image.addEventListener('error', () => image.remove(), { once: true });
      node.append(image);
      image.style.position = 'absolute';
      image.style.inset = '0';
      node.style.position = 'relative';
    }
  };
})();
