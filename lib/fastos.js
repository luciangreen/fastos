// fastos logic shared by the runner and the app page (no Node-only imports).

export const MARKER = '\u001eFASTOS ';
export const HEADER = '% fastos:';

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Files fastos leaves alone: tests, and its own earlier output.
export function isTestFile(rel) {
  return /(^|\/)tests?\//i.test(rel) || /(^|[/_-])test[^/]*\.pl$|_tests?\.pl$/i.test(rel);
}

export const fastName = (rel, suffix = '_fast') => rel.replace(/\.pl$/i, `${suffix}.pl`);
export const isFastOutput = (rel, suffix = '_fast') => rel.toLowerCase().endsWith(`${suffix}.pl`.toLowerCase());

// Point load directives at the _fast copies. Only quoted file names in lines that load
// files are changed, e.g. :- ['a.pl'].  :- include('lib/b').  :- use_module(c).
export function rewriteRefs(text, stems, suffix = '_fast') {
  if (!stems.size) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!/consult|include|use_module|ensure_loaded|load_files|^\s*:-\s*\[|^\s*\[/.test(line)) return line;
      return line
        .replace(/(['"])((?:\.\/)?(?:[^'"]*\/)?)([A-Za-z0-9_+-]+)(\.pl)?\1/g, (m, q, dir, stem, ext) =>
          stems.has(stem) ? `${q}${dir}${stem}${suffix}${ext ?? ''}${q}` : m)
        .replace(/(use_module\(|ensure_loaded\(|consult\(|include\()([a-z][A-Za-z0-9_]*)\)/g, (m, call, stem) =>
          stems.has(stem) ? `${call}${stem}${suffix})` : m);
    })
    .join('\n');
}

// Remove what changes from run to run (timings, inference counts) before comparing outputs.
export function normaliseOutput(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/\b\d[\d,]*\s+inferences\b|\bLips\b|\bCPU\b|\bcpu\b.*\bsec/.test(l))
    .map((l) => l
      .replace(/\b\d+(\.\d+)?\s*(seconds?|secs?|sec|ms|msec|milliseconds?)\b/gi, '<time>')
      .replace(/\/tmp\/[^\s'"]*fastos-[^\s'"/]+/g, '<tmp>')
      .trimEnd())
    .join('\n')
    .trim();
}

// MNN_OPTIMISE ok changed=true size_before=40 size_after=36 plop=accepted simplify=0
export function parseOptimiseLine(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('MNN_OPTIMISE '));
  if (!line) return { ok: false, error: (stdout.trim().split('\n').pop() || 'no report from mnns').slice(0, 200) };
  if (line.startsWith('MNN_OPTIMISE error')) return { ok: false, error: line.slice('MNN_OPTIMISE error '.length) };
  const field = (k) => (new RegExp(`${k}=(\\S+)`).exec(line) ?? [])[1];
  return {
    ok: true,
    changed: field('changed') === 'true',
    sizeBefore: Number(field('size_before')),
    sizeAfter: Number(field('size_after')),
    plop: field('plop'),
    simplify: field('simplify')
  };
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// How to run the repo's tests. config: optional fastos.json { test: "swipl -q -s tests/run.pl" }
// files: repo-relative .pl paths; read(rel) -> text
export function detectTests(files, read, config = {}) {
  if (config.test) return { args: splitArgs(config.test), how: 'fastos.json' };
  if (files.includes('tests/run.pl')) return { args: ['swipl', '-q', '-s', 'tests/run.pl'], how: 'tests/run.pl' };
  const plunit = files.filter((f) => isTestFile(f) && /:-\s*begin_tests\(/.test(read(f)));
  if (plunit.length) {
    return { args: ['swipl', '-q', '-g', `consult([${plunit.map(quote).join(', ')}]), run_tests`, '-t', 'halt'], how: `${plunit.length} PlUnit file(s)` };
  }
  return null;
}

// The file to start the optimised program from.
export function findEntry(files, repoName, config = {}) {
  if (config.entry && files.includes(config.entry)) return config.entry;
  const top = files.filter((f) => !f.includes('/') && !isTestFile(f));
  const want = [`${repoName}.pl`.toLowerCase(), 'main.pl', 'run.pl', 'start.pl'];
  return top.find((f) => want.includes(f.toLowerCase())) ?? top[0] ?? null;
}

// One command with its options, to run the optimised repo.
export function runCommand({ repo, entry, suffix = '_fast', stackLimit = '4G', goal = 'main' }) {
  if (!entry) return null;
  return `cd ${/\s/.test(repo) ? `"${repo}"` : repo} && swipl --stack-limit=${stackLimit} -g ${goal} -t halt ${fastName(entry, suffix)}`;
}

export function runInstructions({ repo, entry, suffix, stackLimit, goal, changed, testedWith, speedup }) {
  const cmd = runCommand({ repo, entry, suffix, stackLimit, goal });
  return [
    `fastos run instructions for ${repo}`,
    '',
    cmd ? `  ${cmd}` : '  (no top-level .pl file found to start from)',
    '',
    'Options:',
    `  --stack-limit=${stackLimit}   memory for Prolog's stacks (e.g. 54G for breasoning)`,
    `  -g ${goal}               the goal to run first; use -g true to just load`,
    '  -t halt              stop when the goal ends; leave it out to stay in the ?- prompt',
    `  ${fastName(entry ?? 'file.pl', suffix)}  the optimised start file; every ${suffix}.pl file loads the other ${suffix}.pl files`,
    '',
    `Optimised by mnns: ${changed.join(', ') || 'no files changed'}.`,
    `Checked with ${testedWith}: identical results${speedup ? `, ${speedup.toFixed(2)}× the speed` : ''}.`,
    ''
  ].join('\n');
}

export function splitArgs(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}
