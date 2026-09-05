# Compile-time benchmark

Measures how long each pipeline phase (lex, parse, analyze, IR, sb3 codegen, zip pack) takes on
generated programs from ~100 to several hundred thousand lines. Nothing large is checked in: every
program is regenerated from `(shape, lines, seed)` by `gen.mjs`, so results are reproducible and the
repo stays small.

## Run

```
cd packages/compiler
npm run bench                                        # every shape at 100, 1k, 10k, 100k lines
npm run bench -- --sizes=1000,50000 --shapes=procs   # subset
npm run bench -- --sizes=300000 --shapes=mixed --runs=1
node bench/gen.mjs mixed 200 > /tmp/x.knip          # eyeball a generated program
```

Flags: `--sizes` (comma list of line counts), `--shapes` (comma list, default all), `--runs`
(median of N, default 3, capped at 2 for >= 100k lines), `--seed`. Each configuration gets one
untimed warmup pass. Output lands in `bench/results/<timestamp>.{json,md}` and `bench/results/latest.md`
(gitignored).

## Shapes

| shape | what it stresses |
|---|---|
| `procs` | many small top-level procs with params, locals, if/else, return, one call each |
| `expressions` | deep nested arithmetic and boolean trees (Pratt parser, type inference, reporter nesting) |
| `control` | nested `for`/`range`, `while`, `do/while`, `if/elif/else`, `switch` |
| `collections` | lists, dicts, indexing, compound index assignment, list methods, dict iteration, f-strings |
| `sprites` | one new sprite per chunk, each with private state, two procs and two handlers |
| `mixed` | round-robin of the four single-target shapes; the closest to real code |
| `fanout` | top-level procs plus many sprites; capped at 10k lines, see below |

Every generated program compiles to a valid `.sb3` with zero diagnostics; the runner throws otherwise.

## Results (2026-09-05, Ryzen AI 5 430, 16 GB, node 24.18, compiler 0.1.19)

Full tables (per-phase times, scaling exponents, output sizes) are in `results/latest.md` after a run.
Headline numbers, median of 3:

| lines | procs | expressions | control | collections | sprites | mixed |
|--:|--:|--:|--:|--:|--:|--:|
| 100 | 27 ms | 41 ms | 20 ms | 30 ms | 25 ms | 35 ms |
| 1k | 147 ms | 190 ms | 92 ms | 149 ms | 78 ms | 132 ms |
| 10k | 0.68 s | 1.65 s | 0.59 s | 1.45 s | 0.62 s | 1.07 s |
| 100k | 7.7 s | 19.4 s | 5.9 s | 17.1 s | 10.0 s | 9.9 s |
| 300k | 25.7 s | | | | | 31.7 s |

Throughput settles at 5k to 17k lines/s once a file is past ~1k lines; below that, fixed startup
cost dominates. Peak heap is roughly 4 to 13 KB per source line (1.3 GB for 100k lines of
expressions, 1.8 GB for 300k mixed), which is why the npm script raises `--max-old-space-size`.

### What the time goes to

- **Front end is cheap and linear.** Lex + parse + analyze + IR together are 25 to 40% of total at 100k
  lines, and every phase's scaling exponent between 10k and 100k sits at 0.7 to 1.2 for the
  single-target shapes. Nothing in the front end is quadratic on ordinary code.
- **Zip packing is the largest single cost: 40 to 53% at 100k+ lines.** `packSb3` does
  `JSON.stringify(project)` into one string, then `fflate` deflates it. For a 10 MB project.json that's
  ~9.5 s. Streaming the JSON into the deflater, or deflating at level 1, would roughly halve total compile
  time at scale.
- **SB3 block emission is 10 to 20%.** Time tracks output blocks, not input lines: `expressions` produces
  ~7 blocks per line and is the slowest shape at ~5k lines/s; `control` produces ~2.3 and is the fastest.
- **Cost is proportional to blocks, not lines.** Across all shapes, ~15 to 30 us per emitted block end to end.

### Two superlinear problems found

1. **Proc name mangling is O(n^2) in same-named procs** (`IRGenerator.ts` `mangle`). It probes `name`,
   `name_1`, `name_2`, ... against a Set until one is free, so the k-th sprite declaring `tick` does k probes.
   With 5.5k sprites (100k lines of `sprites`) this is 4.7 s, 47% of the compile, and IR scales at
   exponent 1.77 from 10k to 100k. A CPU profile puts `mangle` at the top of self time, ahead of the deflater and the GC. Fix: keep a
   per-base counter (`Map<base, nextSuffix>`) instead of rescanning from 1.
2. **Every top-level proc is emitted into every target** (`SB3Generator.ts`, the `[...ir.procs.values(), ...]`
   loop). Output grows as procs x sprites regardless of who calls what. The `fanout` shape (half procs, half
   sprites) yields 34 blocks per line at 1k lines versus ~3 for either half alone, and at 10k lines
   (500 procs x 280 targets) `JSON.stringify` dies with `RangeError: Invalid string length` because
   project.json exceeds V8's ~512 MB string cap. Fix: emit a top-level proc only into targets whose scripts
   or procs call it (the call graph already exists in `CallGraph.ts`).

### Minor

- GC is 15 to 25% of wall time at 100k+ lines: tokens, AST, IR and the sb3 object are all alive at once.
- `Logger` still constructs `KatnipLog` objects while disabled (~2% of a large compile).
