/**
 * 用户自己的背景图只存在这台手机的 IndexedDB，不上传。
 * 存 ArrayBuffer 而不是 Blob：部分 iOS WebView 写 Blob 会失败。
 */
import type { ImageTone } from './chat-background';
import { loadImage, measureTone } from './image-tone';

const DATABASE = 'st-chat-appearance';
const STORE = 'images';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_WIDTH = 1080;
const MAX_HEIGHT = 2340;

/** 每人最多留这么多张；满了先删再加，不替用户做主删掉哪张。 */
export const MAX_IMAGES = 12;

export interface StoredImage extends ImageTone {
  id: string;
  ownerId: string;
  type: string;
  bytes: ArrayBuffer;
  createdAt: number;
}

export type ImportFailure = 'too_large' | 'decode' | 'storage';
export class ImageImportError extends Error {
  constructor(readonly reason: ImportFailure) {
    super(reason);
  }
}

let opening: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result
          .createObjectStore(STORE, { keyPath: 'id' })
          .createIndex('ownerId', 'ownerId');
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('image store blocked'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        opening = undefined;
      };
      resolve(database);
    };
  }).catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/** 等事务真正提交，不能只等请求成功：配额不足时请求成功、事务仍会中止。 */
async function write(run: (store: IDBObjectStore) => void): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    run(transaction.objectStore(STORE));
  });
}

function isStoredImage(value: unknown): value is StoredImage {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.id === 'string' &&
    typeof source.type === 'string' &&
    source.bytes instanceof ArrayBuffer &&
    typeof source.hi === 'number' &&
    typeof source.lo === 'number' &&
    typeof source.createdAt === 'number'
  );
}

export async function listImages(ownerId: string): Promise<StoredImage[]> {
  const database = await openDatabase();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = database
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .index('ownerId')
      .getAll(ownerId);
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () => reject(request.error);
  });
  return rows.filter(isStoredImage).sort((a, b) => b.createdAt - a.createdAt);
}

export const saveImage = (image: StoredImage) => write((store) => store.put(image));
export const deleteImage = (id: string) => write((store) => store.delete(id));

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 选图 → 缩到屏幕够用的尺寸 → 压缩并取样亮度。原图不保留。 */
export async function prepareImage(file: File, ownerId: string): Promise<StoredImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImageImportError('too_large');
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const ratio = Math.min(1, MAX_WIDTH / image.naturalWidth, MAX_HEIGHT / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new ImageImportError('decode');
    // 透明图垫一层深底，转 JPEG 时不会变成黑白不定的杂色。
    context.fillStyle = '#1c1a1c';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const tone = measureTone(canvas);
    // Safari 不支持编码 WebP，会悄悄返回 PNG，体积大几倍，这时改用 JPEG。
    const webp = await encode(canvas, 'image/webp', 0.82);
    const blob = webp?.type === 'image/webp' ? webp : await encode(canvas, 'image/jpeg', 0.84);
    if (!blob) throw new ImageImportError('decode');
    return {
      id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ownerId,
      type: blob.type,
      bytes: await blob.arrayBuffer(),
      createdAt: Date.now(),
      ...tone,
    };
  } catch (error) {
    throw error instanceof ImageImportError ? error : new ImageImportError('decode');
  } finally {
    URL.revokeObjectURL(url);
  }
}
