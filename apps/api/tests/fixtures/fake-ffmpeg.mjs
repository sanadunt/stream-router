#!/usr/bin/env node
if (process.argv.includes('-version')) {
  process.stdout.write('ffmpeg version fake-integration\n');
  process.exit(0);
}
if (process.argv.includes('-encoders')) {
  process.stdout.write(' A..... libopus              libopus Opus\n');
  process.exit(0);
}
if (process.argv.includes('-h')) {
  const topic = process.argv.at(-1);
  process.stdout.write(topic === 'demuxer=rtsp'
    ? '  -timeout           <int64> .D......... set timeout of socket I/O operations\n'
    : '  -rw_timeout        <int64> ED......... Timeout for IO operations\n');
  process.exit(0);
}
process.stderr.write('fake ffmpeg started\n');
process.stderr.write(`Output #0, flv, to '${process.argv.at(-1)}':\n`);
if (process.argv.join(' ').includes('/crash')) {
  setTimeout(() => process.exit(1), 80);
}
const timer = setInterval(() => process.stderr.write('frame=1 fps=1\n'), 250);
function stop() { clearInterval(timer); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
