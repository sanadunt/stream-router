import type { FfmpegMode, FfmpegOptions, InputProtocol, OnlineAudioMode } from '@stream-router/contracts';
import { redactUrl } from './redaction.js';

export interface CommandSpec {
  executable: string;
  args: string[];
  redactedArgs: string[];
}

export interface BuildCommandInput {
  ffmpegPath: string;
  inputUrl: string;
  inputProtocol: InputProtocol;
  outputs: string[];
  mode: FfmpegMode;
  audioMode: OnlineAudioMode;
  options: FfmpegOptions;
  inputTimeoutOption?: 'rw_timeout' | 'timeout' | 'none';
}

function appendOutputOptions(args: string[], videoMode: FfmpegMode, audioMode: OnlineAudioMode, options: FfmpegOptions): void {
  if (videoMode === 'COPY') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', options.preset,
      '-b:v', `${options.videoBitrateKbps}k`,
      '-maxrate', `${options.videoBitrateKbps}k`,
      '-bufsize', `${options.videoBitrateKbps * 2}k`,
      '-g', String(options.gop)
    );
    if (options.fps) args.push('-r', String(options.fps));
    if (options.width && options.height) args.push('-vf', `scale=${options.width}:${options.height}`);
  }
  if (audioMode === 'COPY') {
    args.push('-c:a', 'copy');
  } else if (audioMode === 'AAC') {
    args.push('-c:a', 'aac', '-b:a', `${options.audioBitrateKbps}k`, '-ar', '48000');
  } else {
    args.push('-c:a', 'libopus', '-b:a', `${options.audioBitrateKbps}k`, '-ar', '48000', '-ac', '2');
  }
}

// Escape level luar parser tee (av_get_token): `|` memisahkan slave, backslash dan `'` adalah escape/quote.
function teeSlave(output: string): string {
  return `[f=flv:onfail=abort]${output.replace(/[\\'|[\]]/g, '\\$&')}`;
}

function teeTarget(outputs: string[]): string {
  return outputs.map(teeSlave).join('|');
}

export function buildFfmpegCommand(input: BuildCommandInput): CommandSpec {
  if (input.outputs.length === 0) throw new Error('Minimal satu output wajib disediakan');
  const args: string[] = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info'];
  const timeoutOption = input.inputTimeoutOption ?? 'none';

  if (input.inputProtocol === 'RTSP') {
    args.push('-rtsp_transport', 'tcp');
    if (timeoutOption === 'rw_timeout') args.push('-rw_timeout', '15000000');
    if (timeoutOption === 'timeout') args.push('-timeout', '15000000');
  } else if (timeoutOption === 'rw_timeout') {
    args.push('-rw_timeout', '15000000');
  }
  args.push('-i', input.inputUrl);

  // Multi-output yang meng-encode memakai tee: satu encoder, banyak destinasi. Tanpa tee setiap output
  // menjalankan libx264/aac sendiri. onfail=abort mempertahankan perilaku lama (satu destinasi gagal
  // menghentikan proses) agar route tidak tampil RUNNING sementara sebagian destinasi diam-diam putus.
  const sharedEncode = input.outputs.length > 1 && (input.mode === 'TRANSCODE' || input.audioMode !== 'COPY');
  let teeIndex = -1;
  if (sharedEncode) {
    args.push('-map', '0:v?', '-map', '0:a?');
    appendOutputOptions(args, input.mode, input.audioMode, input.options);
    args.push('-flags', '+global_header', '-f', 'tee', teeTarget(input.outputs));
    teeIndex = args.length - 1;
  } else {
    for (const output of input.outputs) {
      args.push('-map', '0:v?', '-map', '0:a?');
      appendOutputOptions(args, input.mode, input.audioMode, input.options);
      args.push('-f', 'flv', output);
    }
  }

  const redactedArgs = args.map((arg, index) => {
    if (index === teeIndex) return teeTarget(input.outputs.map(redactUrl));
    return /^(?:rtsp|rtmp|rtmps):\/\//i.test(arg) ? redactUrl(arg) : arg;
  });
  return { executable: input.ffmpegPath, args, redactedArgs };
}
