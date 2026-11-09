import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const IMAGE_LIMIT = 16 * 1024 * 1024;
export const IMAGE_CACHE_LIMIT = 64 * 1024 * 1024;
export const IMAGE_CHUNK = 192 * 1024;
const prefix = 'multiplayer-image:';

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Only PNG, JPEG, GIF, and WebP images can be shared.');
}

async function mapImages(value, convert) {
  if (Array.isArray(value)) {
    const result = [];
    for (const entry of value) result.push(await mapImages(entry, convert));
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'userMessage' && Array.isArray(value.content)) {
    const content = [];
    for (const part of value.content) content.push(await convert(part));
    return { ...value, content };
  }
  const entries = [];
  for (const [key, entry] of Object.entries(value)) entries.push([key, await mapImages(entry, convert)]);
  return Object.fromEntries(entries);
}

export class SharedImages {
  constructor() { this.assets = new Map(); this.hashes = new Map(); this.uploads = new Map(); this.bytes = 0; this.closed = false; }
  upload(owner, { uploadId, offset, size, mime, data }) {
    if (this.closed || !/^[a-f\d-]{36}$/.test(uploadId) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(size) || size <= 0 || size > IMAGE_LIMIT || typeof data !== 'string'
      || data.length > IMAGE_CHUNK * 4 / 3 || !/^[A-Za-z\d+/]+=*$/.test(data)) throw new Error('Invalid image upload.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || offset + bytes.length > size) throw new Error('Invalid image upload length.');
    const key = `${owner}:${uploadId}`;
    let upload = this.uploads.get(key);
    if (!upload) {
      if (offset !== 0 || this.bytes + size > IMAGE_CACHE_LIMIT || this.assets.size + this.uploads.size >= 128) throw new Error('Image upload limit reached.');
      upload = { owner, offset: 0, size, mime, chunks: [], timer: null };
      this.bytes += size;
      this.uploads.set(key, upload);
    }
    if (upload.offset !== offset || upload.size !== size || upload.mime !== mime) throw new Error('Image upload is out of order.');
    clearTimeout(upload.timer);
    upload.chunks.push(bytes); upload.offset += bytes.length;
    upload.timer = setTimeout(() => this.discardUpload(key), 30_000);
    upload.timer.unref?.();
    if (upload.offset !== size) return { offset: upload.offset };
    const complete = Buffer.concat(upload.chunks);
    this.discardUpload(key);
    if (imageMime(complete) !== mime) throw new Error('Invalid uploaded image type.');
    const hash = createHash('sha256').update(complete).digest('hex');
    let imageId = this.hashes.get(hash);
    if (!imageId) {
      imageId = randomUUID();
      this.assets.set(imageId, { bytes: complete, mime });
      this.hashes.set(hash, imageId);
      this.bytes += complete.length;
    }
    return { offset: size, imageId };
  }
  discardUpload(key) {
    const upload = this.uploads.get(key);
    if (!upload) return;
    clearTimeout(upload.timer); this.bytes -= upload.size; this.uploads.delete(key);
  }
  discardUploads(owner) { for (const [key, upload] of this.uploads) if (upload.owner === owner) this.discardUpload(key); }
  input(part) {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text, text_elements: [] };
    const asset = part.type === 'image' && typeof part.url === 'string' && part.url.startsWith(prefix) ? this.assets.get(part.url.slice(prefix.length)) : null;
    if (this.closed || !asset) throw new Error('Upload images from the sending computer before submitting.');
    return { type: 'image', url: `data:${asset.mime};base64,${asset.bytes.toString('base64')}` };
  }
  async reference(part) {
    if (part.type !== 'localImage' && !(part.type === 'image' && part.url?.startsWith('data:'))) return part;
    let bytes;
    if (part.type === 'localImage') {
      if (typeof part.path !== 'string' || !isAbsolute(part.path)) throw new Error('Invalid shared image path.');
      const file = await open(part.path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > IMAGE_LIMIT) throw new Error('Shared images must be files under 16 MiB.');
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) throw new Error('Shared image changed while reading.');
          offset += result.bytesRead;
        }
      } finally { await file.close(); }
    } else {
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z\d+/]+=*)$/.exec(part.url);
      if (!match || match[1].length > Math.ceil(IMAGE_LIMIT / 3) * 4) throw new Error('Invalid or oversized shared image.');
      bytes = Buffer.from(match[1], 'base64');
    }
    if (bytes.length > IMAGE_LIMIT) throw new Error('Shared images must be under 16 MiB.');
    const mime = imageMime(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let id = this.hashes.get(hash);
    if (this.closed) throw new Error('Sharing ended.');
    if (!id) {
      if (this.bytes + bytes.length > IMAGE_CACHE_LIMIT || this.assets.size >= 128) throw new Error('Shared image cache is full. End sharing and share again.');
      id = randomUUID();
      this.assets.set(id, { bytes, mime });
      this.hashes.set(hash, id);
      this.bytes += bytes.length;
    }
    return { type: 'image', url: `${prefix}${id}` };
  }
  pack(value, onError = () => {}) {
    return mapImages(value, async part => {
      try { return await this.reference(part); }
      catch (error) { onError(error); return { type: 'image', url: 'multiplayer-image-unavailable:' }; }
    });
  }
  read(id, offset) {
    const asset = this.assets.get(id);
    if (this.closed || !asset || !Number.isSafeInteger(offset) || offset < 0 || offset >= asset.bytes.length) throw new Error('This image is unavailable in the shared chat.');
    return { mime: asset.mime, size: asset.bytes.length, offset, data: asset.bytes.subarray(offset, offset + IMAGE_CHUNK).toString('base64') };
  }
  close() { this.closed = true; for (const key of this.uploads.keys()) this.discardUpload(key); this.assets.clear(); this.hashes.clear(); this.bytes = 0; }
}

export async function uploadInputImages(input, upload) {
  if (input.filter(part => part.type !== 'text').length > 8) throw new Error('Send at most eight images at a time.');
  const store = new SharedImages();
  try {
    const result = [];
    for (const part of input) {
      if (part.type === 'text') { result.push(part); continue; }
      if (!['localImage', 'image'].includes(part.type)) throw new Error('Only text and raster images can be sent in shared chats.');
      const reference = await store.reference(part);
      const id = reference.url?.startsWith(prefix) && reference.url.slice(prefix.length);
      if (!id) throw new Error('Only local or inline raster images can be sent in shared chats.');
      const uploadId = randomUUID();
      let offset = 0, response;
      do {
        const chunk = store.read(id, offset);
        response = await upload({ uploadId, ...chunk });
        offset += Buffer.from(chunk.data, 'base64').length;
        if (response.offset !== offset) throw new Error('Invalid image upload acknowledgement.');
        if (Boolean(response.imageId) !== (offset === chunk.size)) throw new Error('Incomplete image upload acknowledgement.');
      } while (!response.imageId);
      if (!/^[a-f\d-]{36}$/.test(response.imageId)) throw new Error('Invalid uploaded image identifier.');
      result.push({ type: 'image', url: `${prefix}${response.imageId}` });
    }
    return result;
  } finally { store.close(); }
}

export async function expandImages(value, cache, read) {
  return mapImages(value, async part => {
    if (part.type !== 'image' || !part.url?.startsWith(prefix)) return part;
    const id = part.url.slice(prefix.length);
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid shared image identifier.');
    if (!cache.has(id)) {
      let reserved = 0;
      const loading = (async () => {
        const chunks = [];
        let offset = 0, size, mime;
        do {
          const chunk = await read(id, offset);
          if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > IMAGE_LIMIT || chunk.offset !== offset
            || typeof chunk.data !== 'string' || chunk.data.length > IMAGE_CHUNK * 4 / 3
            || !/^[A-Za-z\d+/]+=*$/.test(chunk.data) || (size !== undefined && (chunk.size !== size || chunk.mime !== mime))) throw new Error('Invalid shared image chunk.');
          size = chunk.size; mime = chunk.mime;
          if (offset === 0) {
            if ((cache.bytes || 0) + size > IMAGE_CACHE_LIMIT) throw new Error('Shared image cache is full.');
            reserved = size;
            cache.bytes = (cache.bytes || 0) + size;
          }
          const bytes = Buffer.from(chunk.data, 'base64');
          if (!bytes.length || offset + bytes.length > size) throw new Error('Invalid shared image length.');
          chunks.push(bytes); offset += bytes.length;
        } while (offset < size);
        const bytes = Buffer.concat(chunks);
        if (imageMime(bytes) !== mime) throw new Error('Invalid shared image type.');
        return `data:${mime};base64,${bytes.toString('base64')}`;
      })();
      if (cache.size >= 128) throw new Error('Too many shared images.');
      cache.set(id, loading);
      loading.catch(() => { cache.bytes = (cache.bytes || 0) - reserved; if (cache.get(id) === loading) cache.delete(id); });
    }
    return { type: 'image', url: await cache.get(id) };
  });
}
