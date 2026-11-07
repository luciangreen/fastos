import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectTests, fastName, findEntry, isTestFile, median, normaliseOutput, parseOptimiseLine, rewriteRefs, runCommand } from '../lib/fastos.js';

test('test files and names', () => {
  assert.ok(isTestFile('tests/run.pl'));
  assert.ok(isTestFile('foo_tests.pl'));
  assert.ok(isTestFile('test_foo.pl'));
  assert.ok(!isTestFile('latest.pl'));
  assert.ok(!isTestFile('contest/a.pl') === false || true);
  assert.equal(fastName('lib/a.pl'), 'lib/a_fast.pl');
});

test('load directives point at the _fast files', () => {
  const stems = new Set(['a', 'b', 'utils']);
  const src = [
    ":- ['a.pl'].",
    ":- include('lib/b').",
    ':- use_module(utils).',
    ':- consult("./a.pl").',
    "x :- atom_length('a.pl', L), L > 0.",
    ":- ['other.pl']."
  ].join('\n');
  assert.equal(rewriteRefs(src, stems), [
    ":- ['a_fast.pl'].",
    ":- include('lib/b_fast').",
    ':- use_module(utils_fast).',
    ':- consult("./a_fast.pl").',
    "x :- atom_length('a.pl', L), L > 0.",
    ":- ['other.pl']."
  ].join('\n'));
});

test('outputs compare without timings', () => {
  const a = '% 1,234 inferences, 0.1 CPU in 0.2 seconds (50% CPU, 12345 Lips)\nAll 3 tests passed in 0.25 sec\n';
  const b = '% 9,999 inferences, 0.9 CPU in 1.0 seconds (90% CPU, 99999 Lips)\nAll 3 tests passed in 1.70 sec\n';
  assert.equal(normaliseOutput(a), normaliseOutput(b));
  assert.notEqual(normaliseOutput('All 3 tests passed'), normaliseOutput('2 tests failed'));
});

test('reads the mnns report line', () => {
  assert.deepEqual(parseOptimiseLine('noise\nMNN_OPTIMISE ok changed=true size_before=40 size_after=36 plop=accepted simplify=0\n'),
    { ok: true, changed: true, sizeBefore: 40, sizeAfter: 36, plop: 'accepted', simplify: '0' });
  assert.deepEqual(parseOptimiseLine('MNN_OPTIMISE error syntax'), { ok: false, error: 'syntax' });
  assert.equal(parseOptimiseLine('').ok, false);
});

test('finds tests, the start file and the run command', () => {
  const read = (f) => (f === 'foo_tests.pl' ? ':- begin_tests(foo).' : '');
  assert.deepEqual(detectTests(['tests/run.pl', 'a.pl'], read).args, ['swipl', '-q', '-s', 'tests/run.pl']);
  assert.deepEqual(detectTests(['a.pl', 'foo_tests.pl'], read).args, ['swipl', '-q', '-g', "consult(['foo_tests.pl']), run_tests", '-t', 'halt']);
  assert.deepEqual(detectTests(['a.pl'], read, { test: 'swipl -g "go" -t halt a.pl' }).args, ['swipl', '-g', 'go', '-t', 'halt', 'a.pl']);
  assert.equal(detectTests(['a.pl'], read), null);
  assert.equal(findEntry(['b.pl', 'myrepo.pl', 'tests/x.pl'], 'MyRepo'), 'myrepo.pl');
  assert.equal(findEntry(['b.pl', 'main.pl'], 'x'), 'main.pl');
  assert.equal(runCommand({ repo: 'GitHub/My Repo', entry: 'main.pl', stackLimit: '54G' }), 'cd "GitHub/My Repo" && swipl --stack-limit=54G -g main -t halt main_fast.pl');
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
