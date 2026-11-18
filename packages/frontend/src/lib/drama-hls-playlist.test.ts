import { describe, expect, it } from 'vitest';
import { selectStartupPlaylists } from './drama-hls-playlist';

const BASE = 'https://customer-unit.cloudflarestream.com/token.sig/manifest/video.m3u8';
const resolved = (path: string) => new URL(path, BASE).href;

// 与 Cloudflare Stream 主清单同形：档位从高到低排，CODECS 带引号逗号，音轨单独一组。
const STREAM_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="original",LANGUAGE="und",DEFAULT=YES,AUTOSELECT=YES,URI="stream_audio.m3u8?p=a,b"',
  '#EXT-X-STREAM-INF:RESOLUTION=1080x1920,CODECS="avc1.640028,mp4a.40.2",BANDWIDTH=3950000,AUDIO="group_audio",FRAME-RATE=30.000',
  'stream_1080.m3u8?p=1',
  '#EXT-X-STREAM-INF:RESOLUTION=480x854,CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=900000,AUDIO="group_audio",FRAME-RATE=30.000',
  'stream_480.m3u8?p=1',
  '#EXT-X-STREAM-INF:RESOLUTION=240x426,CODECS="avc1.42c015,mp4a.40.2",BANDWIDTH=300000,AUDIO="group_audio",FRAME-RATE=30.000',
  '',
  'stream_240.m3u8?p=1',
].join('\r\n');

describe('selectStartupPlaylists', () => {
  it('选高度最低的视频档和它分组里的默认音轨，按主清单地址解析相对路径', () => {
    expect(selectStartupPlaylists(STREAM_MASTER, BASE)).toEqual([
      resolved('stream_240.m3u8?p=1'),
      resolved('stream_audio.m3u8?p=a,b'),
    ]);
  });

  it('同高度取码率更低的；没有 DEFAULT=YES 时取组内第一条；忽略其他分组', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",URI="other.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="a1.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="y",URI="a2.m3u8"',
      '#EXT-X-STREAM-INF:RESOLUTION=360x640,BANDWIDTH=600000,AUDIO="a"',
      'hi.m3u8',
      '#EXT-X-STREAM-INF:RESOLUTION=360x640,BANDWIDTH=400000,AUDIO="a"',
      'lo.m3u8',
    ].join('\n');
    expect(selectStartupPlaylists(master, BASE)).toEqual([
      resolved('lo.m3u8'),
      resolved('a1.m3u8'),
    ]);
  });

  it('没有音轨分组时只返回视频子清单；没有档位或内容异常时返回空', () => {
    const videoOnly = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlevel0/main.m3u8\n';
    expect(selectStartupPlaylists(videoOnly, BASE)).toEqual([resolved('level0/main.m3u8')]);
    expect(selectStartupPlaylists('#EXTM3U\n#EXTINF:4,\nseg.mp4\n', BASE)).toEqual([]);
    expect(selectStartupPlaylists('<html>error</html>', BASE)).toEqual([]);
  });
});
