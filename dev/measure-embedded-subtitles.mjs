// Requires the synthetic fixture from make-validation-media.mjs and FFmpeg in PATH.
// Development measurement only: FFmpeg is not bundled or invoked by Vela.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
const file = '.tmp/media/multitrack.mkv';
for (let run = 1; run <= 3; run++) {
  const start = performance.now();
  const output = execFileSync('ffmpeg', ['-v', 'debug', '-i', file, '-map', '0:s:2', '-c:s', 'copy', '-f', 'ass', 'pipe:1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // execFileSync returns stdout; the AVIO read statistics are printed separately below.
  console.log(JSON.stringify({ run, ms: Math.round(performance.now() - start), fileBytes: statSync(file).size, subtitleBytes: Buffer.byteLength(output) }));
}
const { spawnSync } = await import('node:child_process');
const result = spawnSync('ffmpeg', ['-v', 'debug', '-i', file, '-map', '0:s:2', '-c:s', 'copy', '-f', 'ass', 'pipe:1'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
console.log(result.stderr.split(/\r?\n/).filter(line => /Statistics:.*bytes read/.test(line)).join('\n'));
