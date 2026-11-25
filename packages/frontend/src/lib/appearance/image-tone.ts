import type { ImageTone } from './chat-background';

const SAMPLE_WIDTH = 24;
const SAMPLE_HEIGHT = 48;

/** 取样算亮度两头。跨域图没有 CORS 头时画布会被污染，抛错由调用方按未知处理。 */
export function measureTone(image: CanvasImageSource): ImageTone {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const values: number[] = [];
  for (let index = 0; index < data.length; index += 4) {
    values.push(
      (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!) / 255
    );
  }
  values.sort((a, b) => a - b);
  const at = (ratio: number) => Number(values[Math.floor((values.length - 1) * ratio)]!.toFixed(3));
  // 不取最亮最暗的单点，少数高光不该让整张图都压暗。
  return { hi: at(0.92), lo: at(0.08) };
}

export function loadImage(src: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = crossOrigin;
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image load failed'));
    image.src = src;
  });
}
