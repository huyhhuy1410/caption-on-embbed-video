import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    'content/video-detector': 'src/content/video-detector.ts',
    'background/service-worker': 'src/background/service-worker.ts',
    'offscreen/capture': 'src/offscreen/capture.ts',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist',
  sourcemap: true,
});
await cp('manifest.json', 'dist/manifest.json');
await mkdir('dist/offscreen', { recursive: true });
await cp('src/offscreen/offscreen.html', 'dist/offscreen/offscreen.html');
