import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    'content/video-detector': 'src/content/video-detector.ts',
    'popup/popup': 'src/popup/popup.ts',
    'background/service-worker': 'src/background/service-worker.ts',
    'offscreen/capture': 'src/offscreen/capture.ts',
    'recorder-worklet': 'src/offscreen/recorder-worklet.ts',
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
await cp('src/popup/popup.html', 'dist/popup/popup.html');
