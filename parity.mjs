// Mock check: compare screenshots of a running build with the mocks of the game it must look like, and tell the
// building agent what to do next. This is the scoring step of visual hill climbing.
//   node parity.mjs <mocksDir> <shotsDir> [--out <dir>] [--only 03,07] [--build <commit>] [--backend claude|openai] [--model <id>]
// mocksDir: one image per shot (01-title.png ...) and an optional manifest.json:
//           {"shots":[{"file":"01-title.png","title":"Title screen","shows":"what the mock shows and what matters in it"}]}
// shotsDir: the build's live screenshot for each shot, same base name (any of .png .jpg .jpeg .webp), taken from the
//           same game state and camera as the mock.
// For every pair a vision model lists what differs and what to change, and scores the match 0 to 10. It does not play
// the game and does not comment on gameplay, fun or taste; the owner does that. The report ends with one verdict:
//   CONTINUE  keep building, fix the listed differences, take new screenshots and run the check again
//   UNDO      a shot scored DROP or more below its best so far: go back to the build that scored best and try a different fix
//   MATCH     every shot scores PASS or more: stop and hand the build to the owner
// Each shot's best score, the build that reached it and its screenshot are kept in <out>/best.json and <out>/best/.
// A pair is only sent to the model when one of its two images has changed, and model calls are capped per day.
// --rubric likeness: for work that is made WITHOUT seeing the mock and cannot copy it (store art, trailer frames
// made for a game whose real ones are held out). The mock is then the real asset of the same kind, and the score
// says how well the shot holds up next to it as official work for the same game (characters, style, palette,
// lettering, craft), not whether it is the same picture. Default: --rubric screen (the same screen as the mock).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILE_CFG = (() => { try { return JSON.parse(fs.readFileSync(process.env.REFEREE_CONFIG || path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
const cfg = (key, env, def) => process.env[env] ?? FILE_CFG[key] ?? def;

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i < 0 ? null : args.splice(i, 2)[1]; };
const OUT = opt('out'), ONLY = opt('only'), BUILD = opt('build');
const RUBRIC = opt('rubric') || cfg('parity_rubric', 'REFEREE_PARITY_RUBRIC', 'screen');
const BACKEND = opt('backend') || cfg('default_backend', 'REFEREE_BACKEND', 'claude');
const MODEL = opt('model') || (BACKEND === 'openai' ? cfg('openai_model', 'REFEREE_OPENAI_MODEL', 'local-vision-model') : cfg('claude_model', 'REFEREE_CLAUDE_MODEL', 'sonnet'));
const [REFS, SUBS] = args;
const USAGE = 'usage: node parity.mjs <mocksDir> <shotsDir> [--out <dir>] [--only 03,07] [--build <commit>] [--backend claude|openai] [--model <id>] [--rubric screen|likeness]';
if (!REFS || !SUBS) { console.error(USAGE); process.exit(2); }
if (!['screen', 'likeness'].includes(RUBRIC)) { console.error('unknown rubric ' + RUBRIC + '\n' + USAGE); process.exit(2); }
const outDir = OUT || path.join(SUBS, 'parity');
const CAP = Number(cfg('parity_cap', 'REFEREE_PARITY_CAP', 90));     // model calls per day, all runs together
const POOL = Number(cfg('parity_pool', 'REFEREE_PARITY_POOL', 3));   // model calls in parallel
const PASS = Number(cfg('parity_pass', 'REFEREE_PARITY_PASS', 8));   // every shot must score this to MATCH
const DROP = Number(cfg('parity_drop', 'REFEREE_PARITY_DROP', 2));   // a shot this far below its best means UNDO
const TIMEOUT_MS = Number(cfg('judge_timeout_min', 'REFEREE_JUDGE_TIMEOUT_MIN', 20)) * 60000;
const IMG = /\.(png|jpe?g|webp)$/i;
fs.mkdirSync(outDir, { recursive: true });

const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const base = f => path.basename(f).replace(IMG, '');
const manifest = readJson(path.join(REFS, 'manifest.json'), { shots: [] });
const info = Object.fromEntries((manifest.shots || []).map(s => [base(s.file || s.id || ''), s]));
const subFiles = Object.fromEntries(fs.readdirSync(SUBS).filter(f => IMG.test(f)).map(f => [base(f), path.join(SUBS, f)]));
let shots = fs.readdirSync(REFS).filter(f => IMG.test(f)).sort().map(f => ({ id: base(f), ref: path.join(REFS, f), sub: subFiles[base(f)] || null, ...(info[base(f)] || {}) }));
if (ONLY) { const want = ONLY.split(','); shots = shots.filter(s => want.some(w => s.id.startsWith(w))); }
if (!shots.length) { console.error('no mock images in ' + REFS); process.exit(2); }

// ---------- model backends (the same two as server.mjs) ----------
function parseJson(text) {
  const s = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in model reply');
  return JSON.parse(s.slice(a, b + 1));
}
// Claude through the Claude Code CLI (`claude -p`), run in an empty temp dir that holds only the images.
function askClaude(prompt, images) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-claude-'));
  const lines = images.map(im => { const f = path.join(dir, `${im.tag}.jpg`); fs.copyFileSync(im.file, f); return `${im.tag}: ${f} (${im.desc})`; });
  const full = `${prompt}\n\nIMAGE FILES (open every one with the Read tool, in order, before answering):\n${lines.join('\n')}`;
  return new Promise((res, rej) => {
    const cp = spawn(cfg('claude_bin', 'REFEREE_CLAUDE_BIN', 'claude'), ['-p', '--model', MODEL, '--allowedTools', 'Read', '--output-format', 'json'], { cwd: dir, shell: true, windowsHide: true });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => err += d);
    const timer = setTimeout(() => cp.kill(), TIMEOUT_MS);
    cp.on('close', code => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      let j = null; try { j = JSON.parse(out); } catch { }
      if (j?.is_error || code) return rej(new Error(`claude ${code}: ${(j?.result || err || out).slice(0, 400)}`));
      res(j ? j.result || '' : out);
    });
    cp.stdin.end(full);
  });
}
// Any OpenAI-compatible chat completions endpoint with vision (vLLM, llama.cpp server, LM Studio, Ollama, OpenAI).
async function askOpenAI(prompt, images) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images) {
    content.push({ type: 'text', text: `${im.tag} (${im.desc}):` });
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(im.file).toString('base64') } });
  }
  const headers = { 'Content-Type': 'application/json' };
  const key = cfg('openai_api_key', 'REFEREE_OPENAI_API_KEY', '');
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(cfg('openai_url', 'REFEREE_OPENAI_URL', 'http://127.0.0.1:8000/v1/chat/completions'), {
    method: 'POST', headers,
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, temperature: 0.2, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}
const askModel = (prompt, images) => BACKEND === 'openai' ? askOpenAI(prompt, images) : askClaude(prompt, images);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
const jpg = (src, name) => { const o = path.join(tmp, name + '.jpg'); spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-vf', "scale='min(1568,iw)':-2", '-q:v', '3', o]); return fs.existsSync(o) ? o : null; };
// structural similarity of the two pictures at the same size (1 = identical); a cheap number beside the model's reading
function ssim(a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v]scale=960:540[x];[1:v]scale=960:540[y];[x][y]ssim', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /All:([0-9.]+)/.exec(r.stderr || ''); return m ? Number(m[1]) : null;
}

const SCREEN_PROMPT = s => `You are checking whether a game build looks like the mock it is being built toward. Two pictures of the same moment:
REF is the mock: the target picture of the game. It is the truth and is not being judged.
SUB is a live screenshot of the build. It must show the same thing as REF.
${s.title ? `The shot: ${s.title}.` : ''}${s.shows ? ` What REF shows: ${s.shows}` : ''}

Open both images, then compare them part by part: camera position, framing and field of view; every object (present, missing, extra, position, size, shape, facing); materials, colours, lighting, background and atmosphere; effects (exhaust, weapons, explosions, trails, glows); and every interface element (panels, buttons, icons, text, fonts, bars, markers, lines: present or missing, position, size, colour, wording).

Rules:
- Report only differences between SUB and REF. Do not comment on gameplay, fun, design quality or taste, and do not suggest improvements to REF.
- SUB is allowed to be higher fidelity: finer geometry, sharper textures, better shadows and reflections, smoother edges are NOT differences, as long as the design, shape, colours, layout and content are the same.
- A different picture size or a few pixels of offset is not a difference. Changed numbers that depend on time (a clock, a counter) are not differences.
- Be specific and literal: say what, where in the frame, how it differs, and the change to make in SUB. No general remarks.
- List the largest differences first, at most 10.

Score how closely SUB matches REF, 0 to 10: 10 = the same screen apart from fidelity; 8-9 = same content and layout with small differences in colour, glow, size or spacing; 5-7 = recognisably the same screen but with wrong, missing or misplaced parts; 2-4 = the same subject but a different screen; 0-1 = blank, broken or unrelated.

Reply with ONLY this JSON:
{"score":0,"same":"one plain sentence on what already matches","differences":[{"what":"the element","where":"where in the frame","ref":"how it is in REF","sub":"how it is in SUB","change":"what to change in SUB","size":"large|medium|small"}]}`;

// The likeness rubric: SUB was made separately for the same game and is not meant to copy REF's exact picture.
const LIKENESS_PROMPT = s => `You are comparing two assets of the same kind for the same game, side by side.
REF is the REAL, official asset. It is the truth and is not being judged.
SUB was made separately for the same game, without seeing REF. The question is whether SUB holds up next to REF as official work for this game, the way two official pieces of art for one game hold up next to each other.
${s.title ? `The asset: ${s.title}.` : ''}${s.shows ? ` What to compare: ${s.shows}` : ''}

Official art for one game often shows different scenes, poses, moments, compositions and lighting moods. Those choices are NOT differences in themselves. They count only when SUB's choice is outside what this game's art looks like (an art style, palette family or kind of scene that REF's game would never use), or when it breaks the job of this kind of asset (no clear focal subject, no room for the title, the title hard to read).

Open both images, then compare them part by part:
1. Subject identity: the characters, creatures, vehicles and objects SUB shows, and whether they are drawn as the game really has them in REF (shape, proportions, colours, costume, silhouette). A wrong, invented or redesigned protagonist, or duplicated characters, are large differences. Showing different characters or objects that plausibly belong to the same game is not.
2. Art style and rendering: medium (pixel, painted, flat vector, 3D), line work, shading, texture, level of detail.
3. Palette family and lighting style: whether SUB's colours and light belong to the same game.
4. Typography: every word on the picture. The title lettering's font style (serif, sans, script, pixel, hand-drawn), weight, case, colour, outline and effects, and its size and placement for this asset. Misspelt or extra words are large differences.
5. Craft: artefacts, smeared or mangled details, clutter, seams, anything that looks unfinished or amateur next to REF.

Rules:
- Report only differences a shopper would notice side by side. Do not suggest improvements to REF.
- A different picture size, crop, scene, pose or composition of the same game's world is not a difference by itself (see above). Higher fidelity is not a difference.
- Be specific and literal: say what, where, how it differs, and the change to make in SUB. List the largest first, at most 10.

Score how well SUB holds up next to REF, 0 to 10: 10 = indistinguishable in characters, style and lettering from the game's official art; 8-9 = holds up next to REF as official art: the right characters drawn the right way, the same style and palette family, lettering in the same spirit, professional craft; 6-7 = clearly the same game, but one part is visibly off (for example generic lettering, a character drawn differently, a different rendering style, weaker craft); 4-5 = the same game, but two or more parts are off; 2-3 = only the setting or genre matches: wrong character design, wrong art style or wrong lettering throughout; 0-1 = blank, broken or unrelated.

Reply with ONLY this JSON:
{"score":0,"same":"one plain sentence on what already matches","differences":[{"what":"the element","where":"where in the frame","ref":"how it is in REF","sub":"how it is in SUB","change":"what to change in SUB","size":"large|medium|small"}]}`;
const PROMPT = s => (RUBRIC === 'likeness' ? LIKENESS_PROMPT(s) : SCREEN_PROMPT(s));

const cacheFile = path.join(outDir, 'cache.json'), cache = readJson(cacheFile, {});
const budgetFile = path.join(path.resolve(ROOT, cfg('data_dir', 'REFEREE_DATA', 'data')), 'parity-budget.json');
const today = new Date().toISOString().slice(0, 10);
const budget = readJson(budgetFile, {}); if (budget.day !== today) { budget.day = today; budget.calls = 0; }
const spend = () => { budget.calls++; fs.mkdirSync(path.dirname(budgetFile), { recursive: true }); fs.writeFileSync(budgetFile, JSON.stringify(budget)); };

async function judge(s) {
  if (!s.sub) return { ...s, score: 0, missing: true, same: '', differences: [{ what: 'the whole shot', where: 'everywhere', ref: s.title || s.id, sub: 'no screenshot was submitted for this shot', change: `take ${s.id} from the same game state and camera as the mock`, size: 'large' }] };
  const key = sha(s.ref) + ':' + sha(s.sub) + (RUBRIC === 'screen' ? '' : ':' + RUBRIC);
  const sim = ssim(s.ref, s.sub);
  if (cache[key]) return { ...s, ...cache[key], ssim: sim, cached: true };
  if (budget.calls >= CAP) return { ...s, score: null, skipped: `daily cap of ${CAP} model calls reached`, ssim: sim, differences: [] };
  spend();
  const images = [{ tag: 'REF', file: jpg(s.ref, s.id + '-ref'), desc: 'the mock (the truth)' }, { tag: 'SUB', file: jpg(s.sub, s.id + '-sub'), desc: 'the build to check' }];
  let r, err;
  for (let i = 0; i < 2 && !r; i++) { try { r = parseJson(await askModel(PROMPT(s), images)); } catch (e) { err = e.message; } }
  if (!r) return { ...s, score: null, skipped: 'model call failed: ' + String(err).slice(0, 200), ssim: sim, differences: [] };
  const res = { score: Math.max(0, Math.min(10, Number(r.score) || 0)), same: r.same || '', differences: (r.differences || []).slice(0, 10) };
  cache[key] = res; fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  return { ...s, ...res, ssim: sim };
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

const results = await pool(shots, POOL, judge);
fs.rmSync(tmp, { recursive: true, force: true });
const scored = results.filter(r => r.score != null);
const mean = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0;
const low = scored.length ? Math.min(...scored.map(r => r.score)) : 0;
const pass = scored.length === results.length && low >= PASS;

// Hill climb: remember the best score each shot has reached and the build that reached it. If this build scores
// DROP or more below a shot's best, the last change made the game look less like its mock and the agent must undo it.
const bestFile = path.join(outDir, 'best.json'), best = readJson(bestFile, {});
const bestDir = path.join(outDir, 'best'); fs.mkdirSync(bestDir, { recursive: true });
const worse = results.filter(r => r.score != null && best[r.id] && r.score <= best[r.id].score - DROP)
  .map(r => ({ id: r.id, was: best[r.id].score, now: r.score, build: best[r.id].build || null }));
for (const r of results) {
  if (r.score == null || !r.sub || (best[r.id] && r.score < best[r.id].score)) continue;
  const keep = path.join(bestDir, r.id + path.extname(r.sub));
  fs.copyFileSync(r.sub, keep);
  best[r.id] = { score: r.score, build: BUILD, when: new Date().toISOString(), image: keep };
}
fs.writeFileSync(bestFile, JSON.stringify(best, null, 1));

// The verdict is an order to the building agent: keep going until every shot matches its mock, and undo any step that went backwards.
const behind = results.filter(r => r.score == null || r.score < PASS).map(r => r.id);
const verdict = worse.length ? 'UNDO' : pass ? 'MATCH' : 'CONTINUE';
const backTo = [...new Set(worse.map(w => w.build).filter(Boolean))];
const next = worse.length
  ? `Your last change made the build look less like the mocks: ${worse.map(w => `${w.id} went from ${w.was} to ${w.now}`).join(', ')}. Undo that change${backTo.length ? ` (go back to build ${backTo.join(' or ')})` : ''}, then try a different fix for the differences listed below. The best screenshot so far for each shot is in ${bestDir}.`
  : pass
  ? 'Every shot matches its mock. Stop here and hand the build to the owner, who judges taste and play.'
  : `Keep building. Fix the differences listed for ${behind.join(', ')}, take new live screenshots of the running build from the same game state and camera as each mock, save them under the same names in ${SUBS}, and run this check again${BUILD ? '' : ' with --build <commit>'}. Do not stop until every shot scores ${PASS} or more.`;
const report = { mocks: REFS, shots_dir: SUBS, build: BUILD, backend: BACKEND, model: MODEL, rubric: RUBRIC, when: new Date().toISOString(), shots: results.length, mean: Number(mean.toFixed(2)), lowest: low, pass, verdict, next, behind, worse, pass_rule: `every shot scores ${PASS} or more`, undo_rule: `any shot scores ${DROP} or more below its best`, model_calls_today: budget.calls, cap: CAP, results: results.map(({ ref, sub, ...r }) => ({ ...r, best: best[r.id]?.score ?? null, ref, sub })) };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
const md = [`# Mock check: ${results.length} shots, mean ${report.mean}, lowest ${low}, ${verdict} (pass = ${report.pass_rule}; undo = ${report.undo_rule})${BUILD ? ' · build ' + BUILD : ''}`, '', `**${verdict}.** ${next}`, ''];
for (const r of [...results].sort((a, b) => (a.score ?? -1) - (b.score ?? -1))) {
  md.push(`## ${r.id}${r.title ? ' · ' + r.title : ''}: ${r.score == null ? 'not judged (' + r.skipped + ')' : r.score + '/10'}${best[r.id] && best[r.id].score !== r.score ? ` (best ${best[r.id].score})` : ''}${r.ssim != null ? ` · similarity ${r.ssim.toFixed(3)}` : ''}${r.cached ? ' · unchanged since last run' : ''}`);
  if (r.same) md.push(`Matches: ${r.same}`);
  for (const d of r.differences || []) md.push(`- [${d.size || 'medium'}] ${d.what} (${d.where}): mock has ${d.ref}; build has ${d.sub}. Change: ${d.change}`);
  md.push('');
}
md.push(`**${verdict}.** ${next}`, '', `Model calls today: ${budget.calls} of ${CAP}.`);
fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));
console.log(md.join('\n'));
