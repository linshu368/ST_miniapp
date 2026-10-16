import { MAX_SUPPORT_IMAGE_BYTES } from '@miniapp/shared';

/** 长边超过这个尺寸就缩小；手机截图缩到这里文字仍然清楚，上传也快 */
const MAX_EDGE = 1600;

export interface PreparedSupportImage {
  /** base64 原始内容，不带 data: 前缀 */
  base64: string;
  previewUrl: string;
}

/**
 * 客服截图发出前在本地处理：小于 1MB 的 JPG/PNG/WebP 原样发，其余缩到长边 1600 再转 JPEG。
 * 手机原图动辄 5MB 以上，弱网下直接传很容易超时。GIF 压缩会丢动画，只能原样发。
 */
export async function prepareSupportImage(file: File): Promise<PreparedSupportImage> {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    throw new Error('只支持 JPG、PNG、WebP、GIF 图片');
  }
  if (file.type === 'image/gif' || file.size <= 1024 * 1024) {
    if (file.size > MAX_SUPPORT_IMAGE_BYTES) throw new Error('图片太大，最多 3MB');
    return { base64: await toBase64(file), previewUrl: URL.createObjectURL(file) };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备不支持处理图片');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (blob && blob.size <= MAX_SUPPORT_IMAGE_BYTES) {
      return { base64: await toBase64(blob), previewUrl: URL.createObjectURL(blob) };
    }
  }
  throw new Error('图片太大，压缩后仍超过 3MB');
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('读取图片失败'));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
