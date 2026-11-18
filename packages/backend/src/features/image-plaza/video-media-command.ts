import { config } from '../../platform/config.js';

export async function writePlayableVideo(
  branch: 'remux' | 'transcode',
  inputPath: string,
  videoPath: string,
  run: (command: string, args: string[], timeout: number) => Promise<string>
): Promise<void> {
  const timeoutMs = 30 * 60_000;
  if (branch === 'remux') {
    await run(
      config.imagePlaza.ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        videoPath,
      ],
      timeoutMs
    );
  } else {
    await run(
      config.imagePlaza.ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-fpsmax',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-maxrate',
        '6M',
        '-bufsize',
        '12M',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-force_key_frames',
        'expr:gte(t,n_forced*2)',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        videoPath,
      ],
      timeoutMs
    );
  }
}
