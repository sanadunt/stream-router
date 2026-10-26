import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FfmpegCapabilities {
  rwTimeout: boolean;
  rtspTimeout: boolean;
  libopus: boolean;
}

const cache = new Map<string, Promise<FfmpegCapabilities>>();

export function parseFfmpegCapabilities(fullHelp: string, rtspHelp: string, encoders = ''): FfmpegCapabilities {
  return {
    rwTimeout: /^\s*-rw_timeout\s+/m.test(fullHelp),
    rtspTimeout: /^\s*-timeout\s+.*socket I\/O/m.test(rtspHelp),
    libopus: /^\s*[A-Z.]{6}\s+libopus\s+/m.test(encoders)
  };
}

async function help(ffmpegPath: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(ffmpegPath, args, {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    });
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  }
}

export function detectFfmpegCapabilities(ffmpegPath: string): Promise<FfmpegCapabilities> {
  const existing = cache.get(ffmpegPath);
  if (existing) return existing;
  const detection = Promise.all([
    help(ffmpegPath, ['-hide_banner', '-h', 'full']),
    help(ffmpegPath, ['-hide_banner', '-h', 'demuxer=rtsp']),
    help(ffmpegPath, ['-hide_banner', '-encoders'])
  ]).then(([fullHelp, rtspHelp, encoders]) => parseFfmpegCapabilities(fullHelp, rtspHelp, encoders));
  cache.set(ffmpegPath, detection);
  return detection;
}
