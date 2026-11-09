import { displayName } from './rooms.mjs';
import { imageMime } from './images.mjs';

export async function copyProfileImage(source, fetchImage = fetch) {
  let url = source;
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects < 4; redirects++) {
    const parsed = new URL(url);
    const allowed = ['cdn.auth0.com', 'googleusercontent.com', 'gravatar.com', 'oaistatic.com', 'oaiusercontent.com', 'openai.com', 'chatgpt.com'];
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')
      || !allowed.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error(`Unsupported profile image origin: ${parsed.hostname}`);
    const response = await fetchImage(parsed.href, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), parsed).href;
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Profile image could not be loaded.'); }
    const limit = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Profile image is too large.'); }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error('Profile image is too large.');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    return { dataUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` };
  }
  throw new Error('Too many profile image redirects.');
}

export function cleanAvatar(value) {
  if (!value || typeof value !== 'object') return undefined;
  const avatar = {};
  if (typeof value.initials === 'string' && /^[\p{L}\p{N}]{1,3}$/u.test(value.initials)) avatar.initials = value.initials;
  for (const key of ['background', 'color']) {
    if (typeof value[key] === 'string' && /^(#[a-f\d]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value[key]) && value[key].length < 60) avatar[key] = value[key];
  }
  if (typeof value.image === 'string' && value.image.length <= 32_000 && /^data:image\/png;base64,[A-Za-z\d+/]+=*$/.test(value.image)) {
    const data = Buffer.from(value.image.slice(22), 'base64');
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.length >= 24
      && data.readUInt32BE(16) <= 128 && data.readUInt32BE(20) <= 128) avatar.image = value.image;
  }
  return Object.keys(avatar).length ? avatar : undefined;
}

export function cleanProfile(value, fallback = 'Someone') {
  return { name: displayName(value?.name || fallback), avatar: cleanAvatar(value?.avatar) };
}
