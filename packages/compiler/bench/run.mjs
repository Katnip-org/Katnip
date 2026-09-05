// Compile-time benchmark. Generates programs of each shape at each size, times every pipeline
// phase, and writes bench/results/<stamp>.{json,md} plus bench/results/latest.md.
//
//   npm run bench                              # all shapes, 100 .. 100k lines
//   npm run bench -- --sizes 1000,50000 --shapes procs,mixed --runs 5
//   npm run bench -- --sizes 300000 --shapes mixed --runs 1

import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Lexer } from "../build/lexer/Lexer.js";
import { Parser } from "../build/parser/Parser.js";
import { SemanticAnalyzer } from "../build/semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "../build/semantic/StdlibLoader.js";
import { ErrorReporter } from "../build/utils/ErrorReporter.js";
import { Logger } from "../build/utils/Logger.js";
import { loadAssets } from "../build/codegen/assets.js";
import { IRGenerator } from "../build/ir/IRGenerator.js";
import { SB3Generator } from "../build/codegen/SB3Generator.js";
import { packSb3 } from "../build/codegen/pack.js";
import { generate, shapeNames, shapeCaps } from "./gen.mjs";

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]),
);
const sizes = String(args.sizes ?? "100,1000,10000,100000").split(",").map(Number);
const shapes = args.shapes ? String(args.shapes).split(",") : shapeNames;
const runs = Number(args.runs ?? 3);
const seed = Number(args.seed ?? 1);
const phases = ["gen", "lex", "parse", "analyze", "ir", "sb3", "pack"];

const stdlib = loadStdlibModules(new Logger());

/** One full compile with per-phase wall time. Throws on any diagnostic error so a broken generator can't fake a fast result. */
function compileTimed(source) {
    const t = {};
    let mark = performance.now();
    const lap = (name) => { const now = performance.now(); t[name] = now - mark; mark = now; };

    const reporter = new ErrorReporter(source);
    const logger = new Logger();
    const tokens = new Lexer(reporter, logger).tokenize(source); lap("lex");
    const ast = new Parser(reporter, logger).parse(tokens); lap("parse");
    const analyzer = new SemanticAnalyzer(reporter, logger);
    analyzer.loadStdlib(stdlib);
    const assets = loadAssets(ast, "", () => null, reporter);
    analyzer.analyze(ast); lap("analyze");
    if (reporter.hasErrors()) throw new Error(reporter.getErrors().map((e) => `${e.message} (line ${e.location?.line})`).slice(0, 5).join("\n"));
    const ir = new IRGenerator(analyzer).generate(ast); lap("ir");
    const project = new SB3Generator().generate(ir, assets); lap("sb3");
    const bytes = packSb3(project, assets); lap("pack");

    return {
        times: t,
        tokens: tokens.length,
        blocks: project.targets.reduce((n, tg) => n + Object.keys(tg.blocks).length, 0),
        targets: project.targets.length,
        sb3Bytes: bytes.length,
    };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function bench(shape, lines) {
    let genMs = 0, source = "";
    const samples = [];
    let meta, peakHeap = 0;
    const n = lines >= 100000 ? Math.min(runs, 2) : runs;
    for (let i = 0; i < n + 1; i++) {
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        const g0 = performance.now();
        source = generate(shape, lines, seed);
        genMs = performance.now() - g0;
        const r = compileTimed(source);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed - before);
        meta = r;
        if (i > 0) samples.push({ gen: genMs, ...r.times }); // first pass is JIT warmup
    }
    const times = Object.fromEntries(phases.map((p) => [p, median(samples.map((s) => s[p]))]));
    const total = phases.filter((p) => p !== "gen").reduce((a, p) => a + times[p], 0);
    const actualLines = source.split("\n").length - 1;
    return { shape, lines: actualLines, bytes: source.length, runs: n, times, total, peakHeapMB: peakHeap / 2 ** 20, ...meta };
}

const results = [];
const failures = [];
for (const shape of shapes) {
    for (const lines of sizes) {
        if (lines > (shapeCaps[shape] ?? Infinity)) continue;
        process.stderr.write(`${shape.padEnd(12)} ${String(lines).padStart(7)} lines ... `);
        try {
            const r = bench(shape, lines);
            results.push(r);
            process.stderr.write(`${r.total.toFixed(0)} ms  (${(r.lines / r.total * 1000).toFixed(0)} lines/s, ${r.blocks} blocks)\n`);
        } catch (err) {
            // A crash is itself a result (e.g. project.json exceeding V8's string limit), so keep going.
            failures.push({ shape, lines, error: String(err).split("\n")[0] });
            process.stderr.write(`FAILED: ${String(err).split("\n")[0]}\n`);
        }
    }
}

// --- report ---
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
const pct = (part, whole) => `${(100 * part / whole).toFixed(0)}%`;
const machine = `${cpus()[0].model.trim()}, ${Math.round(totalmem() / 2 ** 30)} GB, node ${process.version}`;

let md = `# Katnip compile-time benchmark\n\n${new Date().toISOString()}  \n${machine}  \nmedian of ${runs} runs after 1 warmup (2 runs at >= 100k lines), seed ${seed}\n\n`;

md += `## Totals\n\n| shape | lines | tokens | blocks | total | lines/s | lex | parse | analyze | ir | sb3 | pack | heap |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n`;
for (const r of results) {
    md += `| ${r.shape} | ${r.lines} | ${r.tokens} | ${r.blocks} | ${fmt(r.total)} | ${(r.lines / r.total * 1000).toFixed(0)} | `
        + ["lex", "parse", "analyze", "ir", "sb3", "pack"].map((p) => `${fmt(r.times[p])} (${pct(r.times[p], r.total)})`).join(" | ")
        + ` | ${r.peakHeapMB.toFixed(0)} MB |\n`;
}

// Scaling exponent between consecutive sizes: 1.0 = linear, 2.0 = quadratic.
md += `\n## Scaling\n\nExponent k in time ~ lines^k between consecutive sizes (1.0 is linear, 2.0 quadratic).\n\n| shape | sizes | total | lex | parse | analyze | ir | sb3 | pack |\n|---|---|--:|--:|--:|--:|--:|--:|--:|\n`;
for (const shape of shapes) {
    const rs = results.filter((r) => r.shape === shape);
    for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1], b = rs[i];
        const k = (x, y) => (Math.log(y / x) / Math.log(b.lines / a.lines)).toFixed(2);
        md += `| ${shape} | ${a.lines} -> ${b.lines} | ${k(a.total, b.total)} | `
            + ["lex", "parse", "analyze", "ir", "sb3", "pack"].map((p) => k(a.times[p], b.times[p])).join(" | ") + " |\n";
    }
}

if (failures.length) {
    md += `\n## Failures\n\n| shape | lines | error |\n|---|--:|---|\n`;
    for (const f of failures) md += `| ${f.shape} | ${f.lines} | ${f.error} |\n`;
}

md += `\n## Output\n\n| shape | lines | source bytes | targets | blocks | sb3 bytes | blocks/line |\n|---|--:|--:|--:|--:|--:|--:|\n`;
for (const r of results) md += `| ${r.shape} | ${r.lines} | ${r.bytes} | ${r.targets} | ${r.blocks} | ${r.sb3Bytes} | ${(r.blocks / r.lines).toFixed(1)} |\n`;

const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ machine, seed, runs, results, failures }, null, 2));
writeFileSync(join(outDir, `${stamp}.md`), md);
writeFileSync(join(outDir, "latest.md"), md);
console.log(md);
console.error(`wrote ${join(outDir, stamp)}.{json,md}`);
