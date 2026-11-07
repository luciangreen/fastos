# fastos

fastos optimises a Prolog repo, or a folder of repos, with [mnns](https://github.com/luciangreen/mnns). It keeps the result only when the repo's tests give exactly the same results, and it saves the optimised code in the same folders under new names. It's part of the [LucianOS suite](https://github.com/luciangreen/lucianos).

## Install

fastos runs inside the LucianOS platform:

```sh
cd lucianos/apps
git clone https://github.com/luciangreen/fastos
```

It needs mnns with its overall optimise command (`swipl optimise.pl IN OUT`). That command is on mnns's `feature/optimise-command` branch until it is merged. `swipl` and `node` must be in the suite's `allowedCommands`; both are by default.

## Using it

1. Open `/apps/fastos/`, or double-click its icon on the LucianOS desktop.
2. Go to a repo, or a folder of repos. Repos are folders with `.git` or `.pl` files.
3. Check the options:
   - **mnns folder** (default `Dropbox/GitHub-private2/mnns`)
   - **test runs** (3; the median time is used)
   - **new name ending** (`_fast`)
   - the **stack limit** and **start goal** for the run command
   - an optional **test command**
4. Press **Optimise this folder**. A progress bar follows each repo. When it finishes, a table shows:
   - the optimised files
   - the test time before and after
   - the speed-up
   - the run command, with a Copy button

## What happens to each repo

1. **Tests are found.** fastos uses, in order:
   - a `fastos.json` with `{"test": "command"}` (it can also set `"entry"`, `"goal"` and `"stackLimit"`)
   - `tests/run.pl`
   - PlUnit files (`*_tests.pl`, `test_*.pl` or files in `tests/` with `begin_tests`)

   A repo without tests is skipped, because its results could not be checked, unless you tick **Save repos without tests too**.
2. **The original is timed.** The tests run in a temporary copy, several times. If they give different results from run to run, the repo is skipped.
3. **Each source file is optimised** by mnns in a second copy. Test files are never optimised. Files mnns can't parse stay as they are.
4. **The optimised copy is tested.** Its output and exit code must match the original exactly, ignoring timings and inference counts. If they don't, nothing is saved.
5. **Files are saved** next to the originals:
   - Every source file is saved as `name_fast.pl`. Files mnns optimised get their optimised code; the rest are copies.
   - `consult`, `include` and `use_module` lines point at the other `_fast` files, so the `_fast` set runs on its own.
   - Each saved file starts with a `% fastos:` line. fastos never overwrites a file without that line.
   - `fastos-run.txt` holds the run command, for example:

     ```
     cd Dropbox/GitHub-private2/myrepo && swipl --stack-limit=4G -g main -t halt myrepo_fast.pl
     ```

     It also explains each option.

Your original files are never changed, and the temporary copies are deleted. fastos never optimises the mnns folder it is using.

## Command line

`runner.mjs` is what the app runs as a LucianOS job:

```sh
node runner.mjs <folder> [--mnns path] [--runs 3] [--suffix _fast] [--stack-limit 4G] [--goal main] [--test "command"] [--keep-untested]
```

Folders are relative to the suite folder.

## Tests

```sh
npm test
```

There are 9 tests. They run the real runner with a stand-in `swipl`, covering:

- a repo that gets faster and is saved, with its load lines rewritten
- a repo whose behaviour changes and is refused
- a repo with nothing to change, and one with no tests
- not overwriting your own files
- skipping mnns itself
- the suite's rules

## Coming next

From the plan: MNN and superposed-ANN stages using RENN or pl2ann, and a per-repo report of what changed.
