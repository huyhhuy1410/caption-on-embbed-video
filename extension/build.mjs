import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    'content/video-detector': 'src/content/video-detector.ts',
    'background/service-worker': 'src/background/service-worker.ts',
    'offscreen/capture': 'src/offscreen/capture.ts',
    'side-panel/side-panel': 'src/side-panel/side-panel.ts',
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
// ⚠️ HTML của side panel phải copy TAY như offscreen: bundler chỉ lo TS, không
// đụng file tĩnh. Thêm `side_panel.html` mà quên dòng này thì manifest trỏ
// tới file không tồn tại và panel mở ra trắng trơn.
await mkdir('dist/side-panel', { recursive: true });
await cp('src/side-panel/side-panel.html', 'dist/side-panel/side-panel.html');
