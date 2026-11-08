import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER } from '../lib/fastos.js';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner.mjs');
let base, root, bin;

// A stand-in for swipl:
//  * "swipl .../optimise.pl -- IN OUT" acts like mnns: "% SLOW" code becomes "% FAST"; "% BREAK" code changes behaviour
//  * anything else is a test run: slow if any .pl file in the folder says SLOW, and prints a result
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] && a[0].endsWith('optimise.pl')) {
  if (a[1] !== '--') { console.log('ERROR: swipl would load the input file'); process.exit(1); }
  a.splice(1, 1);
  const src = fs.readFileSync(a[1], 'utf8');
  if (src.includes('SYNTAX')) { console.log('MNN_OPTIMISE error syntax not supported'); process.exit(1); }
  const out = src.replace(/% SLOW/g, '% FAST').replace(/% BREAK/g, '% BROKEN');
  if (out === src) { fs.writeFileSync(a[2], src); console.log('MNN_OPTIMISE ok changed=false size_before=10 size_after=10 plop=unchanged simplify=0'); process.exit(0); }
  fs.writeFileSync(a[2], out);
  console.log('MNN_OPTIMISE ok changed=true size_before=40 size_after=36 plop=accepted simplify=0');
  process.exit(0);
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.pl') ? [fs.readFileSync(path.join(d, e.name), 'utf8')] : []);
const all = walk(process.cwd()).join('\\n');
const wait = all.includes('% SLOW') ? 400 : 60;
setTimeout(() => {
  console.log(all.includes('% BROKEN') ? 'Test b: FAILED' : 'All 2 tests passed');
  console.log('% 12,345 inferences, 0.01 CPU in ' + (wait / 1000) + ' seconds (99% CPU, 1000000 Lips)');
}, wait);
`;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastos-test-'));
  root = path.join(base, 'root');
  bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'swipl'), FAKE, { mode: 0o755 });
  const mk = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  mk('mnns/optimise.pl', '% stand-in');
  mk('GitHub/mnns/optimise.pl', '% stand-in inside the folder being optimised');
  mk('GitHub/mnns/tests/run.pl', ':- initialization(main, main).\n');
  // a repo mnns can speed up, with two files that load each other
  mk('GitHub/fastrepo/fastrepo.pl', ":- ['helper.pl'].\nmain :- helper.\n");
  mk('GitHub/fastrepo/helper.pl', 'helper. % SLOW\n');
  mk('GitHub/fastrepo/tests/run.pl', ':- initialization(main, main).\n');
  fs.mkdirSync(path.join(root, 'GitHub/fastrepo/.git'));
  // a repo where optimising changes behaviour: must not be saved
  mk('GitHub/brokenrepo/a.pl', 'a. % BREAK\n');
  mk('GitHub/brokenrepo/a_tests.pl', ':- begin_tests(a).\n:- end_tests(a).\n');
  // nothing to optimise
  mk('GitHub/plainrepo/p.pl', 'p.\n');
  mk('GitHub/plainrepo/fastos.json', '{"test": "swipl -g run_tests -t halt p.pl"}');
  // no tests
  mk('GitHub/untested/u.pl', 'u. % SLOW\n');
  // not a repo
  mk('GitHub/notes/readme.txt', 'hi');
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

function runFastos(args, allowed = 'swipl,node') {
  return new Promise((resolve) => {
    const child = spawn('node', [RUNNER, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LUCIANOS_ROOT: root, LUCIANOS_ALLOWED_COMMANDS: allowed },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const markers = out.split('\n').filter((l) => l.startsWith(MARKER)).map((l) => JSON.parse(l.slice(MARKER.length)));
      resolve({ code, out, markers, end: markers.find((m) => m.event === 'end') });
    });
  });
}

test('optimises a folder of repos, saving only what the tests confirm', async () => {
  const r = await runFastos(['GitHub', '--mnns', 'mnns', '--runs', '3']);
  assert.equal(r.code, 0, r.out);
  const begin = r.markers.find((m) => m.event === 'begin');
  assert.deepEqual(begin.repos.sort(), ['GitHub/brokenrepo', 'GitHub/fastrepo', 'GitHub/mnns', 'GitHub/plainrepo', 'GitHub/untested'], 'a different mnns copy is just another repo');
  const by = Object.fromEntries(r.end.results.map((x) => [x.repo.split('/').pop(), x]));

  // fastrepo: helper optimised, both files saved as _fast with loads rewritten, faster
  assert.equal(by.fastrepo.status, 'saved');
  assert.deepEqual(by.fastrepo.changed, ['helper.pl']);
  assert.ok(by.fastrepo.speedup > 2, `speed-up ${by.fastrepo.speedup}`);
  const repo = path.join(root, 'GitHub/fastrepo');
  assert.match(fs.readFileSync(path.join(repo, 'helper_fast.pl'), 'utf8'), /^% fastos: optimised by mnns of helper\.pl.*tests matched\.\nhelper\. % FAST/);
  assert.match(fs.readFileSync(path.join(repo, 'fastrepo_fast.pl'), 'utf8'), /% fastos: copy of fastrepo\.pl[^\n]*\n:- \['helper_fast\.pl'\]\./);
  assert.equal(fs.readFileSync(path.join(repo, 'helper.pl'), 'utf8'), 'helper. % SLOW\n', 'the original is untouched');
  assert.ok(!fs.existsSync(path.join(repo, 'tests/run_fast.pl')), 'tests are not copied');
  const howto = fs.readFileSync(path.join(repo, 'fastos-run.txt'), 'utf8');
  assert.match(howto, /cd GitHub\/fastrepo && swipl --stack-limit=4G -g main -t halt fastrepo_fast\.pl/);
  assert.match(by.fastrepo.command, /fastrepo_fast\.pl$/);

  assert.equal(by.brokenrepo.status, 'rejected');
  assert.match(by.brokenrepo.note, /different test results/);
  assert.ok(!fs.existsSync(path.join(root, 'GitHub/brokenrepo/a_fast.pl')));

  assert.equal(by.plainrepo.status, 'unchanged');
  assert.equal(by.untested.status, 'skipped');
  assert.match(by.untested.note, /no tests/);
  assert.ok(!fs.existsSync(path.join(root, 'GitHub/untested/u_fast.pl')));

  // temporary copies are gone
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fastos-') && !n.startsWith('fastos-test-')).length, 0);
});

test('a second run updates its own files, and leaves yours alone', async () => {
  const r = await runFastos(['GitHub/fastrepo', '--mnns', 'mnns', '--runs', '1']);
  assert.equal(r.end.results[0].status, 'saved');
  fs.writeFileSync(path.join(root, 'GitHub/untested/u_fast.pl'), 'my own file\n');
  const r2 = await runFastos(['GitHub/untested', '--mnns', 'mnns', '--runs', '1', '--keep-untested']);
  assert.equal(r2.end.results[0].status, 'rejected');
  assert.match(r2.end.results[0].note, /already exists and is not from fastos/);
  assert.equal(fs.readFileSync(path.join(root, 'GitHub/untested/u_fast.pl'), 'utf8'), 'my own file\n');
});

test('never optimises the mnns folder it is using', async () => {
  const r = await runFastos(['GitHub', '--mnns', 'GitHub/mnns', '--runs', '1']);
  const begin = r.markers.find((m) => m.event === 'begin');
  assert.ok(!begin.repos.includes('GitHub/mnns'));
  const r2 = await runFastos(['GitHub/mnns', '--mnns', 'GitHub/mnns']);
  assert.match(r2.out, /does not optimise the optimiser/);
});

test('follows the suite rules', async () => {
  let r = await runFastos(['../..', '--mnns', 'mnns']);
  assert.match(r.out, /Outside the suite folder/);
  r = await runFastos(['GitHub', '--mnns', 'nowhere']);
  assert.match(r.out, /optimise\.pl was not found/);
  r = await runFastos(['GitHub/fastrepo', '--mnns', 'mnns', '--runs', '1'], 'node');
  assert.match(r.out, /"swipl" is not in allowedCommands/);
  r = await runFastos(['GitHub', '--suffix', '../x']);
  assert.match(r.out, /--suffix must look like _fast/);
});
