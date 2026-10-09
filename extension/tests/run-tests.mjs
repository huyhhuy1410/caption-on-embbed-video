import { buildSync } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tests = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'caption-extension-tests-'));
try {
  const files = readdirSync(tests).filter(name => /\.test\.(ts|mjs)$/.test(name)).map(name => {
    if (name.endsWith('.mjs')) return join(tests, name);
    const output = join(temp, name.replace(/\.ts$/, '.mjs'));
    buildSync({ entryPoints: [join(tests, name)], bundle: true, platform: 'node', format: 'esm', outfile: output });
    return output;
  });
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
