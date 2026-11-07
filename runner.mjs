#!/usr/bin/env node
// fastos runner: optimise every repo in a folder with mnns, keeping results only when the
// repo's tests give identical results, and saving the optimised code under new names.
// Started by the fastos app as a LucianOS job:
//   node runner.mjs <folder> [--mnns path] [--suffix _fast] [--runs 3] [--timeout 300]
//                            [--stack-limit 4G] [--goal main] [--test "command"] [--keep-untested]
// Folders are relative to the suite folder. Rules: commands from allowedCommands only, no shell,
// everything read and written inside the suite folder; work happens in temporary copies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HEADER, MARKER, detectTests, fastName, findEntry, isFastOutput, isTestFile, median, normaliseOutput,
  parseOptimiseLine, rewriteRefs, runInstructions, splitArgs
} from './lib/fastos.js';

const ROOT = fs.realpathSync(process.env.LUCIANOS_ROOT || process.env.HOME);
const ALLOWED = (process.env.LUCIANOS_ALLOWED_COMMANDS || 'swipl').split(',').filter(Boolean);
const mark = (data) => process.stdout.write(`${MARKER}${JSON.stringify(data)}\n`);
const say = (t) => process.stdout.write(t);
let current = null;
let stopping = false;
const temps = [];

function options(argv) {
  const o = { folder: null, mnns: 'Dropbox/GitHub-private2/mnns', suffix: '_fast', runs: 3, timeout: 300, stackLimit: '4G', goal: 'main', test: null, keepUntested: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mnns') o.mnns = next();
    else if (a === '--suffix') o.suffix = next();
    else if (a === '--runs') o.runs = Math.max(1, Math.min(20, parseInt(next(), 10) || 3));
    else if (a === '--timeout') o.timeout = Math.max(5, parseInt(next(), 10) || 300);
    else if (a === '--stack-limit') o.stackLimit = next();
    else if (a === '--goal') o.goal = next();
    else if (a === '--test') o.test = next();
    else if (a === '--keep-untested') o.keepUntested = true;
    else if (!o.folder) o.folder = a;
  }
  if (!/^_[A-Za-z0-9_-]{1,20}$/.test(o.suffix)) throw new Error('--suffix must look like _fast');
  if (!/^\d+[KMG]?$/.test(o.stackLimit)) throw new Error('--stack-limit must look like 4G');
  if (!/^[a-z][A-Za-z0-9_]*$/.test(o.goal)) throw new Error('--goal must be a predicate name like main');
  return o;
}

function inside(rel) {
  const abs = path.resolve(ROOT, rel || '.');
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error(`Outside the suite folder: ${rel}`);
  return real;
}

// Run a command; resolves { code, out, err, ms, timedOut }.
function run(args, cwd, timeoutS) {
  const [cmd, ...rest] = args;
  if (!ALLOWED.includes(cmd)) return Promise.resolve({ code: 127, out: '', err: `"${cmd}" is not in allowedCommands`, ms: 0 });
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(cmd, rest, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (out.length < 2e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 2e6) err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutS * 1000);
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      current = null;
      resolve({ code: timedOut ? 124 : code ?? 1, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6, timedOut });
    });
  });
}

function prologFiles(dir, suffix) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && /\.pl$/i.test(d.name) && !isFastOutput(r, suffix)) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

function isRepo(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  try {
    return fs.readdirSync(dir).some((n) => /\.pl$/i.test(n));
  } catch {
    return false;
  }
}

function copyRepo(src) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fastos-'));
  temps.push(dest);
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') && !p.split(path.sep).includes('node_modules') });
  return dest;
}

async function timeTests(dir, testArgs, o) {
  const times = [];
  let first = null;
  for (let i = 0; i < o.runs; i++) {
    if (stopping) throw new Error('Interrupted');
    const r = await run(testArgs, dir, o.timeout);
    if (r.timedOut) return { ...r, times, output: `timed out after ${o.timeout} s` };
    const output = normaliseOutput(`${r.out}\n${r.err}`);
    if (!first) first = { code: r.code, output };
    else if (first.code !== r.code || first.output !== output) {
      return { code: r.code, output, times, unstable: true };
    }
    times.push(r.ms);
  }
  return { ...first, times, median: median(times) };
}

async function optimiseRepo(repoAbs, o, mnnsAbs, index, total) {
  const name = path.basename(repoAbs);
  const rel = path.relative(ROOT, repoAbs).split(path.sep).join('/');
  const step = (status, extra = {}) => mark({ event: 'repo', index, total, repo: rel, status, ...extra });
  const result = { repo: rel, status: 'skipped', changed: [], saved: [], note: '' };

  const files = prologFiles(repoAbs, o.suffix);
  const sources = files.filter((f) => !isTestFile(f));
  if (!sources.length) return { ...result, note: 'no Prolog files' };
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(repoAbs, 'fastos.json'), 'utf8'));
  } catch {}
  const read = (f) => fs.readFileSync(path.join(repoAbs, f), 'utf8');
  const tests = o.test ? { args: splitArgs(o.test), how: 'your test command' } : detectTests(files, read, config);
  if (!tests && !o.keepUntested) {
    step('skipped');
    return { ...result, note: 'no tests found, so results could not be checked. Add tests, or a fastos.json with {"test": "command"}.' };
  }

  // 1. time the original tests in a copy
  step('timing original tests');
  say(`\n▶ ${rel}: ${sources.length} Prolog file(s); tests: ${tests ? tests.how : 'none (kept untested)'}\n`);
  const origCopy = copyRepo(repoAbs);
  const before = tests ? await timeTests(origCopy, tests.args, o) : null;
  if (before?.unstable) return { ...result, status: 'skipped', note: 'the tests give different results each run, so they cannot check the optimisation' };
  if (before?.timedOut) return { ...result, status: 'skipped', note: `the tests took longer than ${o.timeout} s` };

  // 2. optimise each source file into a second copy
  const optCopy = copyRepo(repoAbs);
  const outcomes = [];
  for (const [k, f] of sources.entries()) {
    if (stopping) throw new Error('Interrupted');
    step('optimising', { file: f, done: k, of: sources.length });
    const tmpOut = path.join(optCopy, `${f}.fastos-out.pl`);
    const r = await run(['swipl', path.join(mnnsAbs, 'optimise.pl'), path.join(origCopy, f), tmpOut], optCopy, o.timeout);
    const rep = parseOptimiseLine(r.out);
    if (rep.ok && rep.changed && fs.existsSync(tmpOut)) {
      fs.renameSync(tmpOut, path.join(optCopy, f));
      outcomes.push({ file: f, changed: true, sizeBefore: rep.sizeBefore, sizeAfter: rep.sizeAfter });
    } else {
      fs.rmSync(tmpOut, { force: true });
      outcomes.push({ file: f, changed: false, why: rep.ok ? 'nothing to convert' : rep.error });
    }
  }
  const changed = outcomes.filter((x) => x.changed).map((x) => x.file);
  result.files = outcomes;
  result.changed = changed;
  if (!changed.length) return { ...result, status: 'unchanged', note: 'mnns found nothing it can prove faster', before: before?.median };

  // 3. the same tests on the optimised copy must give identical results
  let after = null;
  if (tests) {
    step('timing optimised tests');
    after = await timeTests(optCopy, tests.args, o);
    if (after.code !== before.code || after.output !== before.output) {
      return { ...result, status: 'rejected', note: 'the optimised code gave different test results, so nothing was saved', before: before.median, diff: firstDifference(before.output, after.output) };
    }
  }

  // 4. save every source as <name>_fast.pl next to the original (optimised where mnns changed it),
  //    with loads pointing at the _fast files, so the _fast set runs on its own
  const stems = new Set(sources.map((f) => path.basename(f, path.extname(f))));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const f of sources) {
    const target = path.join(repoAbs, fastName(f, o.suffix));
    if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').startsWith(HEADER)) {
      return { ...result, status: 'rejected', note: `${fastName(f, o.suffix)} already exists and is not from fastos, so nothing was saved` };
    }
  }
  for (const f of sources) {
    const optimised = changed.includes(f);
    const body = rewriteRefs(fs.readFileSync(path.join(optimised ? optCopy : repoAbs, f), 'utf8'), stems, o.suffix);
    const head = `${HEADER} ${optimised ? 'optimised by mnns' : 'copy'} of ${path.basename(f)}, ${stamp}${tests ? ', tests matched' : ', untested'}.\n`;
    fs.writeFileSync(path.join(repoAbs, fastName(f, o.suffix)), head + body);
    result.saved.push(fastName(f, o.suffix));
  }
  const entry = findEntry(sources, name, config);
  const speedup = before && after ? before.median / Math.max(1, after.median) : null;
  fs.writeFileSync(path.join(repoAbs, 'fastos-run.txt'), runInstructions({
    repo: rel, entry, suffix: o.suffix, stackLimit: config.stackLimit ?? o.stackLimit, goal: config.goal ?? o.goal,
    changed, testedWith: tests ? tests.how : 'no tests', speedup
  }));
  result.saved.push('fastos-run.txt');
  return {
    ...result,
    status: tests ? 'saved' : 'saved-untested',
    before: before?.median,
    after: after?.median,
    speedup,
    command: `cd ${rel} && swipl --stack-limit=${config.stackLimit ?? o.stackLimit} -g ${config.goal ?? o.goal} -t halt ${entry ? fastName(entry, o.suffix) : ''}`.trim()
  };
}

function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { line: i + 1, before: x[i] ?? '', after: y[i] ?? '' };
  return null;
}

async function main() {
  const o = options(process.argv.slice(2));
  if (!o.folder && o.folder !== '') throw new Error('Usage: node runner.mjs <folder> [options]');
  if (!ALLOWED.includes('swipl')) throw new Error('"swipl" is not in allowedCommands in the suite config.json');
  const target = inside(o.folder);
  const mnnsAbs = inside(o.mnns);
  if (!fs.existsSync(path.join(mnnsAbs, 'optimise.pl'))) {
    throw new Error(`mnns's optimise.pl was not found in ${o.mnns}. Update mnns (git pull; the optimise command is on the feature/optimise-command branch until it is merged) or set the mnns folder.`);
  }
  const repos = isRepo(target) ? [target] : fs.readdirSync(target, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && isRepo(path.join(target, d.name)))
    .map((d) => path.join(target, d.name))
    .filter((r) => fs.realpathSync(r) !== mnnsAbs); // never rewrite the optimiser while it is running
  if (fs.realpathSync(target) === mnnsAbs) throw new Error('That is the mnns folder itself; fastos does not optimise the optimiser.');
  mark({ event: 'begin', repos: repos.map((r) => path.relative(ROOT, r).split(path.sep).join('/')) });
  say(`fastos: ${repos.length} repo(s) in ${o.folder || 'the suite folder'}\n`);
  const results = [];
  for (const [i, repo] of repos.entries()) {
    if (stopping) break;
    let r;
    try {
      r = await optimiseRepo(repo, o, mnnsAbs, i, repos.length);
    } catch (err) {
      r = { repo: path.relative(ROOT, repo), status: 'failed', note: err.message };
    }
    results.push(r);
    mark({ event: 'result', index: i, total: repos.length, result: r });
    say(`  ${r.status}${r.speedup ? ` · ${r.speedup.toFixed(2)}× faster` : ''}${r.note ? ` · ${r.note}` : ''}\n`);
  }
  mark({ event: 'end', results });
  const saved = results.filter((r) => r.status.startsWith('saved')).length;
  say(`\nDone: ${saved} of ${repos.length} repo(s) optimised and saved.\n`);
}

function cleanUp() {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    current?.kill('SIGKILL');
    cleanUp();
    say('\nInterrupted.\n');
    process.exit(143);
  });
}

main()
  .catch((err) => {
    say(`${err.message}\n`);
    mark({ event: 'end', error: err.message, results: [] });
    process.exitCode = 1;
  })
  .finally(cleanUp);
