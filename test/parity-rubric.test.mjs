// node --test test/parity-rubric.test.mjs   (needs ffmpeg on the PATH, like parity.mjs itself; no model is called)
// The mock check with a stand-in judge: --rubric likeness sends the likeness prompt, the default sends the
// same-screen prompt, scores are cached per rubric, and the report says which rubric scored it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A solid-colour PNG, w x h, without any image library. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-rubric-'));
  const mocks = path.join(dir, 'mocks'), shots = path.join(dir, 'shots'), data = path.join(dir, 'data');
  fs.mkdirSync(mocks); fs.mkdirSync(shots);
  fs.writeFileSync(path.join(mocks, '01-header.png'), png(64, 32, [200, 40, 40]));
  fs.writeFileSync(path.join(shots, '01-header.png'), png(64, 32, [40, 40, 200]));
  fs.writeFileSync(path.join(mocks, 'manifest.json'), JSON.stringify({ shots: [{ file: '01-header.png', title: 'Header capsule', shows: 'key art and title' }] }));
  // The stand-in judge: records every prompt it is sent and answers like `claude -p --output-format json`.
  const log = path.join(dir, 'prompts.log');
  const judge = path.join(dir, 'judge.mjs');
  fs.writeFileSync(judge, `import fs from 'node:fs';
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{ fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(s)+'\\n');
const score = s.includes('holds up next to REF') ? 6 : 2;
process.stdout.write(JSON.stringify({ result: JSON.stringify({ score, same: 'x', differences: [] }) })); });`);
  return { dir, mocks, shots, data, log, bin: `"${process.execPath}" "${judge}"` };
}
const run = (t, extra) => spawnSync(process.execPath, [path.join(ROOT, 'parity.mjs'), t.mocks, t.shots, '--out', path.join(t.dir, 'out'), ...extra], { encoding: 'utf8', env: { ...process.env, REFEREE_CLAUDE_BIN: t.bin, REFEREE_DATA: t.data, REFEREE_PARITY_CAP: '50' } });
const prompts = (t) => (fs.existsSync(t.log) ? fs.readFileSync(t.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const report = (t) => JSON.parse(fs.readFileSync(path.join(t.dir, 'out', 'report.json'), 'utf8'));

test('--rubric likeness sends the likeness prompt and reports its rubric', () => {
  const t = setup();
  const r = run(t, ['--rubric', 'likeness', '--build', 'a']);
  assert.equal(r.status, 0, r.stderr);
  const p = prompts(t);
  assert.equal(p.length, 1);
  assert.match(p[0], /without seeing REF/);
  assert.match(p[0], /Typography/);
  assert.equal(report(t).rubric, 'likeness');
  assert.equal(report(t).results[0].score, 6);
});

test('the default rubric is unchanged (same screen as the mock)', () => {
  const t = setup();
  const r = run(t, ['--build', 'a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(prompts(t)[0], /checking whether a game build looks like the mock/);
  assert.equal(report(t).rubric, 'screen');
});

test('scores are cached per rubric: the same pair is judged again under the other rubric, not again under the same one', () => {
  const t = setup();
  run(t, ['--rubric', 'likeness', '--build', 'a']);
  run(t, ['--rubric', 'likeness', '--build', 'b']);
  assert.equal(prompts(t).length, 1, 'unchanged pair under the same rubric is not sent again');
  run(t, ['--build', 'c']);
  assert.equal(prompts(t).length, 2, 'the other rubric scores it afresh');
  assert.equal(report(t).results[0].score, 2);
});

test('an unknown rubric is refused', () => {
  const t = setup();
  const r = run(t, ['--rubric', 'vibes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown rubric/);
});

test('--rubric peer sends the peer prompt: another game is the quality bar, its subject and title are not compared', () => {
  const t = setup();
  const r = run(t, ['--rubric', 'peer', '--build', 'a']);
  assert.equal(r.status, 0, r.stderr);
  const p = prompts(t);
  assert.match(p[0], /two DIFFERENT games/);
  assert.match(p[0], /never count that as a difference/);
  assert.equal(report(t).rubric, 'peer');
});
