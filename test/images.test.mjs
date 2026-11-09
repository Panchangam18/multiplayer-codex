import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedImages, expandImages, uploadInputImages, IMAGE_CHUNK, IMAGE_LIMIT } from '../src/images.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
test('shared image bytes are chunked, deduplicated and restored without forwarding local paths', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'multiplayer-images-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.png');
  const bytes = Buffer.concat([png, Buffer.alloc(IMAGE_CHUNK * 2)]);
  writeFileSync(path, bytes);
  const store = new SharedImages();
  const source = { turn: { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Look' }, { type: 'localImage', path }] }] } };
  const packed = await store.pack(source);
  assert.equal(JSON.stringify(packed).includes(path), false);
  assert.equal(source.turn.items[0].content[1].path, path);
  assert.deepEqual(await store.pack(source), packed);
  const offsets = [], cache = new Map();
  const expanded = await expandImages(packed, cache, async (id, offset) => { offsets.push(offset); return store.read(id, offset); });
  assert.deepEqual(offsets, [0, IMAGE_CHUNK, IMAGE_CHUNK * 2]);
  assert.equal(expanded.turn.items[0].content[1].url, `data:image/png;base64,${bytes.toString('base64')}`);
  await expandImages(packed, cache, () => { throw new Error('Must use cache'); });
  assert.throws(() => store.read('../../private', 0), /unavailable/);
  const id = packed.turn.items[0].content[1].url.split(':')[1];
  assert.throws(() => store.read(id, -1), /unavailable/);
  store.close();
  assert.throws(() => store.read(id, 0), /unavailable/);
});

test('image relay rejects non-images, oversized chunks, and missing files without breaking history', async () => {
  const store = new SharedImages();
  await assert.rejects(store.reference({ type: 'image', url: 'data:image/png;base64,c2VjcmV0' }), /Only PNG/);
  const notices = [];
  const result = await store.pack({ type: 'userMessage', content: [{ type: 'localImage', path: '/missing/multiplayer-test.png' }] }, error => notices.push(error));
  assert.equal(notices.length, 1);
  assert.equal(result.content[0].url, 'multiplayer-image-unavailable:');
  const packed = await store.pack({ type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }] });
  await assert.rejects(expandImages(packed, new Map(), async () => ({ size: IMAGE_LIMIT + 1, offset: 0, data: png.toString('base64'), mime: 'image/png' })), /Invalid shared image chunk/);
});

test('uploads are bounded, member-scoped, expire, and never become host filesystem reads', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new SharedImages();
  context.after(() => store.close());
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const input = await uploadInputImages([{ type: 'image', url: dataUrl }], chunk => store.upload('guest', chunk));
  assert.deepEqual(store.input(input[0]), { type: 'image', url: dataUrl });
  assert.throws(() => store.input({ type: 'localImage', path: '/private/secret.png' }), /Upload images/);
  const chunk = { uploadId: '10000000-0000-4000-8000-000000000000', size: 20, mime: 'image/png', offset: 0, data: png.subarray(0, 10).toString('base64') };
  store.upload('guest', chunk);
  assert.throws(() => store.upload('other', { ...chunk, offset: 10 }), /limit/);
  assert.throws(() => store.upload('guest', { ...chunk, offset: 1 }), /out of order/);
  context.mock.timers.tick(30001);
  assert.equal(store.uploads.size, 0);
  store.upload('guest', chunk);
  store.discardUploads('guest');
  assert.equal(store.uploads.size, 0);
});
