import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAvatar, cleanProfile, copyProfileImage } from '../src/profile.mjs';

test('profile metadata is bounded and excludes URLs, markup, CSS injection and extra account fields', () => {
  assert.deepEqual(cleanProfile({ name: 'panchangam18', email: 'private', token: 'private', avatar: {
    initials: 'PA', background: 'rgb(52, 70, 92)', color: '#fff', image: 'https://example.com/tracking.png', accountId: 'private',
  } }), { name: 'panchangam18', avatar: { initials: 'PA', background: 'rgb(52, 70, 92)', color: '#fff' } });
  assert.equal(cleanAvatar({ initials: '<img>', background: 'url(https://example.com)', image: 'data:image/svg+xml;base64,PHN2Zz4=' }), undefined);
  assert.equal(cleanAvatar({ image: 'data:image/png;base64,YmFk' }), undefined);
  assert.equal(cleanProfile(null, 'Fallback').name, 'Fallback');
});

test('local avatar copy returns raster bytes without credentials and rejects unsafe origins or redirects', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const result = await copyProfileImage('https://cdn.auth0.com/avatars/pa.png', async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    return new Response(png);
  });
  assert.equal(result.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  const noFetch = () => { assert.fail('Unsafe destination must never be fetched'); };
  for (const source of ['file:///etc/passwd', 'https://127.0.0.1/avatar', 'https://googleusercontent.com.attacker.test/avatar', 'https://user:secret@lh3.googleusercontent.com/avatar']) {
    await assert.rejects(copyProfileImage(source, noFetch), /Unsupported/);
  }
  let calls = 0;
  await assert.rejects(copyProfileImage('https://lh3.googleusercontent.com/avatar', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  }), /Unsupported/);
  assert.equal(calls, 1);
  await assert.rejects(copyProfileImage('https://lh3.googleusercontent.com/avatar', async () => new Response('<svg></svg>')), /Only PNG/);
  await assert.rejects(copyProfileImage('https://lh3.googleusercontent.com/avatar', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))), /too large/);
});
