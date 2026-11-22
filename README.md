# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kocemeevox/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kocemeevox/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format

## Run it

```sh
node main.ts --help
```

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one specification
(`SPEC.md`): a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Each format
is auto-detected, or named with `--format`. An edit is found even when the
model drifted its whitespace or indentation, and every file is changed or
none: a failed edit changes nothing, and the edits after it still run.

## Build

Node 22 and its standard library alone; nothing is installed.

```sh
node main.ts --help
```

There is no build step: `main.ts` is the program, run as `node main.ts`.

## Use

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line for each path whose state changed (`A`, `D`, `M`, or
`R old -> new`) and then `ok: <n> files`. Exit 1 prints one
`error: <code> <path>` line for each edit that failed and then
`failed: <k> of <n> edits`, and writes nothing. Exit 2 prints exactly one
line: `error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`.

Matching is three-tier: exact lines first, then lines equal once trailing
spaces and tabs are removed, then lines equal once leading and trailing
spaces and tabs are removed. Unified hunks take the occurrence nearest the
line number the hunk names; SEARCH/REPLACE blocks fail as `ambiguous` when
their old lines occur more than once; V4A chunks follow an anchor and a
cursor. Unsafe paths (empty, absolute, backslash, or with `.`/`..`/empty
segments) fail as `unsafe`, and a path a patch names that does not exist, or
already exists when it must not, fails as `missing` or `exists`.

## Layout

- `main.ts` — the whole CLI.
- `runner.ts` — the kit's trial runner, kept as it is: when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
- `check.ts` — runs `main.ts` on the kit's public practice set.
- `SPEC.md` — the whole specification.

## Practice

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

100 of 100 practice checks pass: practice score 1000.

---

Entered on [make.fun](https://make.fun/?ref=mwzsh35h&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
