import { buildSync } from "esbuild";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tests = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "caption-notice-tests-"));
const evidence = join(temp, "language-evidence.test.mjs");
buildSync({
  entryPoints: [join(tests, "language-evidence.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: evidence,
});
const unit = spawnSync(process.execPath, ["--test", evidence], {
  stdio: "inherit",
});
if (unit.status !== 0) process.exit(unit.status ?? 1);

const browser = [
  process.env.CAPTION_TEST_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
if (!browser) {
  console.error(
    "Browser fixture not run: set CAPTION_TEST_BROWSER to a Chromium executable.",
  );
  process.exit(1);
}
const bundle = buildSync({
  entryPoints: [join(tests, "caption-notice.browser.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
}).outputFiles[0].text;
const fixture = join(temp, "fixture.html");
writeFileSync(
  fixture,
  `<!doctype html><meta charset="utf-8"><body><script>${bundle}</script></body>`,
);
const run = spawnSync(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${join(temp, "profile")}`,
    "--dump-dom",
    pathToFileURL(fixture).href,
  ],
  { encoding: "utf8", timeout: 30000 },
);
const result = run.stdout?.match(
  /<pre data-result="(passed|failed)">([\s\S]*?)<\/pre>/,
);
if (run.status !== 0 || result?.[1] !== "passed") {
  console.error(
    result?.[2] ??
      run.error?.message ??
      run.stderr ??
      "Browser fixture failed without result.",
  );
  process.exit(1);
}
console.log(`CaptionNotice browser fixture: ${result[2]}`);
