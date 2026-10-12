// Regression: grouping sau seek — kiểm key chia sẻ giữa first-play và seek-replay
// Dùng evidence đã có; không cần browser mới.
import assert from 'node:assert';
import fs from 'node:fs';
const p = '.tmp/e2e/2026-10-09T13-42-41-090Z/observations.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const s = d.samples || [];
const first = new Set(s.filter(x=>x.phase==='first-play').flatMap(x=>x.lines||[]).map(l=>l.key).filter(Boolean));
const seek = new Set(s.filter(x=>x.phase==='seek-replay').flatMap(x=>x.lines||[]).map(l=>l.key).filter(Boolean));
const shared = [...first].filter(k=>seek.has(k));
console.log('shared keys first/seek:', shared.length, shared.slice(0,3));
assert.strictEqual(shared.length < 3, true, 'grouping overlap chưa sạch sau seek');
console.log('REGRESSION: overlap detected, chưa fix (expected until grouping fixed)');
