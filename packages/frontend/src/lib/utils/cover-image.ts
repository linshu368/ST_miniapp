/** 封面只在创作页 224px 的方框里展示，长边压到这里，高 DPR 放大也够清楚 */
const MAX_EDGE = 1024;
/** 压缩目标体积。原图最大放宽到 20MB，手机原图动辄几 MB~十几 MB，体积越大，
 * 弱网/WebView 下传输中途被断开的概率越高（生产排查：约一半上传在开始后 0.8~1s 内中断）。 */
const TARGET_BYTES = 1.5 * 1024 * 1024;

export interface PreparedCoverUpload {
  image_base64: string;
  mime_type: 'image/jpeg';
}

/**
 * 封面上传前在本地压缩成小图再传。调用方需先用 validateImagePlazaReference 做类型/大小校验。
 * 不像客服截图有 3MB 硬上限会直接拒绝，这里压到最低画质仍超限也继续传，只是不再降质——
 * 封面可以模糊，但不能传不上去。
 */
export async function prepareCoverImage(file: File): Promise<PreparedCoverUpload> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备不支持处理图片');
  // 统一转 JPEG：带透明背景的封面原图很少见，拍平成白底换取远高于 PNG 的压缩率。
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let best: Blob | null = null;
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (!blob) continue;
    best = blob;
    if (blob.size <= TARGET_BYTES) break;
  }
  if (!best) throw new Error('图片处理失败，请重试');
  return { image_base64: await toBase64(best), mime_type: 'image/jpeg' };
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
