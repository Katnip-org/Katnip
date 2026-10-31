/**
 * @fileoverview The public entry points, and the seam between stages.
 * Every other suite drives one stage directly; these drive the pipeline the way an
 * embedder does, so a stage that is individually correct but wired up wrong still fails here.
 */

import { stdlibSources } from "../stdlib.generated.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { checkSource, compileToIR, compileToSb3 } from "../index.js";
import { ENTRY_PATH, virtualAssetReader, virtualResolver } from "./helpers.js";

const HELLO = `sprite Cat { events.onFlag() { looks.say("hi", 1); } }`;

/** Repo root, from build/tests at runtime. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function projectOf(sb3: Uint8Array) {
    const entries = unzipSync(sb3);
    return JSON.parse(new TextDecoder().decode(entries["project.json"]!));
}

test("checkSource loads the stdlib itself, so an embedder wires up nothing", () => {
    assert.deepEqual(checkSource(HELLO), []);
});

test("checkSource reports errors without throwing", () => {
    const errors = checkSource(`sprite Cat { events.onFlag() { looks.say(nope); } }`);
    assert.equal(errors.length > 0, true);
    assert.match(errors[0]!.message, /nope/);
});

test("checkSource resolves imports through the supplied resolver", () => {
    const files = {
        "/proj/lib.knip": `public proc twice(n: num) -> num { return n * 2; }`,
    };
    const source = `import "./lib.knip";\nsprite Cat { events.onFlag() { looks.say(f"{lib.twice(2)}"); } }`;

    assert.deepEqual(checkSource(source, { path: ENTRY_PATH, resolve: virtualResolver(files) }), []);
    // Without a resolver the specifier cannot be read at all, so the namespace is unknown.
    assert.equal(checkSource(source).length > 0, true);
});

test("compileToSb3 returns bytes that unzip to a loadable project", () => {
    const { errors, sb3 } = compileToSb3(HELLO);

    assert.deepEqual(errors, []);
    assert(sb3 instanceof Uint8Array, "expected sb3 bytes");

    const project = projectOf(sb3);
    assert.equal(project.meta.semver, "3.0.0");
    assert.equal(project.targets[0].isStage, true);
    assert.equal(project.targets[1].name, "Cat");
    assert.equal(project.targets[1].isStage, false);
});

test("costumes and sounds are packed once per unique file and shared by md5", () => {
    const svg = new TextEncoder().encode("<svg/>");
    const wav = new TextEncoder().encode("RIFF");
    const assets = { "/proj/cat.svg": svg, "/proj/same.svg": svg, "/proj/meow.wav": wav };
    const source = `
        stage { costume "./cat.svg" as bg; }
        sprite Cat { costume "./cat.svg"; costume "./same.svg" as twin; sound "./meow.wav"; }
        sprite Dog { costume "./cat.svg" as borrowed; }
    `;
    const { errors, sb3 } = compileToSb3(source, { path: ENTRY_PATH, readAsset: virtualAssetReader(assets) });

    assert.deepEqual(errors, []);
    const entries = unzipSync(sb3!);
    const project = projectOf(sb3!);
    const [stage, cat, dog] = project.targets;

    assert.equal(stage.costumes[0].name, "bg");
    assert.deepEqual(cat.costumes.map((c: { name: string }) => c.name), ["cat", "twin"]);
    assert.equal(cat.sounds[0].name, "meow");
    assert.equal(cat.costumes[0].assetId, cat.costumes[1].assetId, "identical bytes share an id");
    assert.equal(cat.costumes[0].assetId, dog.costumes[0].assetId, "sprites share an id");
    assert.deepEqual(entries[cat.costumes[0].md5ext], svg);
    assert.deepEqual(entries[cat.sounds[0].md5ext], wav);
    // project.json, the default costume, one svg, one wav.
    assert.equal(Object.keys(entries).length, 4);
});

test("a missing asset is reported against its path, like an unresolvable import", () => {
    const { errors, sb3 } = compileToSb3(`sprite Cat { costume "./nope.svg"; }`, { path: ENTRY_PATH, readAsset: () => null });
    assert.equal(sb3, undefined);
    assert.match(errors[0]!.message, /nope\.svg/);
});

test("a sprite-less program still builds, but warns that it is empty", () => {
    // Everything katnip emits is owned by a sprite, so a file of only top-level
    // procs compiles clean to a project with nothing in it. A warning never blocks.
    const { errors, sb3 } = compileToSb3(`proc double(n: num) -> num { return(n * 2); }`);

    assert(sb3 instanceof Uint8Array, "expected sb3 bytes");
    assert.deepEqual(errors.map((e) => e.severity), ["warning"]);
    assert.match(errors[0]!.message, /no sprites/);
});

test("a program with errors yields no project at all", () => {
    // Emitting a partial project from a broken program would hand the user a
    // silently wrong .sb3, which is worse than refusing to build.
    const { errors, sb3 } = compileToSb3(`sprite Cat { events.onFlag() { looks.say(nope); } }`);

    assert.equal(errors.length > 0, true);
    assert.equal(sb3, undefined);
});

test("garbage input is reported, not thrown", () => {
    const { errors, sb3 } = compileToSb3(`!!! @@@ ### {{{`);

    assert.equal(errors.length > 0, true);
    assert.equal(sb3, undefined);
});

test("examples/codegen.knip compiles end to end", () => {
    // The example is the maintained record of everything the pipeline lowers today;
    // if it stops building, the documented feature surface has regressed.
    const path = resolve(repoRoot, "examples/codegen.knip");
    if (!existsSync(path)) return; // package extracted from the monorepo

    const { errors, sb3 } = compileToSb3(readFileSync(path, "utf8"), { path });
    assert.deepEqual(errors.map((e) => e.message), []);

    const project = projectOf(sb3!);
    assert.deepEqual(project.targets.map((t: { name: string }) => t.name), ["Stage", "Cat", "Dog"]);
    assert.deepEqual(project.extensions, ["pen"]);
});

test("the cli reports lexer errors, failed writes and semantic errors with a nonzero exit", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "katnip-cli-"));
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.js");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
    const file = (name: string, source: string) => {
        writeFileSync(resolve(dir, name), source);
        return resolve(dir, name);
    };

    const unterminated = run("tokenize", file("bad.knip", `looks.say("hi);`), resolve(dir, "tokens.json"));
    assert.equal(unterminated.status, 1);
    assert.match(unterminated.stdout + unterminated.stderr, /nterminated/);
    assert(!existsSync(resolve(dir, "tokens.json")), "tokens from a broken file should not be written");

    // The write used to float free of the promise chain, so this crashed as an unhandled rejection.
    const unwritable = run("tokenize", file("ok.knip", HELLO), resolve(dir, "missing", "tokens.json"));
    assert.equal(unwritable.status, 1);
    assert.match(unwritable.stderr, /Error tokenizing file/);

    assert.equal(run("check", file("sem.knip", `sprite Cat { events.onFlag() { looks.say(nope); } }`)).status, 1);
});

test("error carets line up under tab-indented and CRLF source", async () => {
    const { ErrorReporter, KatnipError } = await import("../utils/ErrorReporter.js");
    const reporter = new ErrorReporter("sprite Cat {\r\n\t\tlooks.say(nope);\r\n}");
    reporter.add(new KatnipError("Semantic", "'nope' is not defined", { line: 2, column: 13, length: 4 }));

    const printed: string[] = [];
    const original = console.error;
    console.error = (msg: string) => printed.push(msg);
    try { reporter.print(); } finally { console.error = original; }

    const lines = printed.join("\n").split("\n");
    assert(lines.some((l) => l.endsWith("| \t\tlooks.say(nope);")), "the source line keeps its tabs and loses the \r");
    assert(lines.some((l) => l.endsWith("| \t\t          ^^^^")), "the carets sit under 'nope'");
});

test("import() loads a csv row or column into a list and a flat json object into a dict", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const assets = {
        "/proj/row.csv": text("1,2,123,12555,234324"),
        "/proj/col.csv": text("1\r\n2\r\n123\r\n\r\n12555\n234324\n"),
        "/proj/names.csv": text(`Alice, Bob ,"Smith, Jr.",007,`),
        "/proj/scores.json": text(`{"alice": 3, "bob": 5}`),
        "/proj/flags.json": text(`[true, false]`),
    };
    const source = `
        sprite Cat {
            private row: list<num> = import("./row.csv");
            private col: list<num> = import("./col.csv");
            private names = import("./names.csv");
            private scores: dict<str, num> = import("./scores.json");
            private flags = import("./flags.json");
        }
    `;
    const { errors, sb3 } = compileToSb3(source, { path: ENTRY_PATH, readAsset: virtualAssetReader(assets) });
    assert.deepEqual(errors, []);

    const lists = Object.fromEntries(Object.values(projectOf(sb3!).targets[1].lists) as [string, unknown[]][]);
    assert.deepEqual(lists.row, [1, 2, 123, 12555, 234324]);
    assert.deepEqual(lists.col, [1, 2, 123, 12555, 234324]);
    assert.deepEqual(lists.names, ["Alice", "Bob", "Smith, Jr.", 7]);
    assert.deepEqual(lists.scores_keys, ["alice", "bob"]);
    assert.deepEqual(lists.scores_vals, [3, 5]);
    assert.deepEqual(lists.flags, [true, false]);
});

test("import() rejects grids, nested json and missing files", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const assets = {
        "/proj/grid.csv": text("1,2\n3,4"),
        "/proj/deep.json": text(`{"a": {"b": 1}}`),
        "/proj/bad.json": text(`{"a": `),
    };
    const check = (file: string) =>
        checkSource(`private x = import("./${file}");`, { path: ENTRY_PATH, readAsset: virtualAssetReader(assets) })
            .map((e) => e.message)
            .join("\n");

    assert.match(check("grid.csv"), /single row or a single column/);
    assert.match(check("deep.json"), /flat array or a flat object/);
    assert.match(check("bad.json"), /Invalid JSON/);
    assert.match(check("nope.csv"), /Cannot resolve '\.\/nope\.csv'/);
    assert.match(check("thing.txt"), /loads .json or .csv files/);
});

test("every stdlib file checks clean on its own, by its marker", () => {
    for (const { name, content } of stdlibSources) {
        assert.match(content, /^#! katnip: stdlib\r?\n/, name);
        assert.deepEqual(checkSource(content).map((e) => `${name}: ${e.message}`), []);
    }
});

test("the stdlib marker relaxes checks only on the first line, and can't be built", () => {
    const source = `proc f(@operator = "+", a: T) -> void {}\n`;
    assert.match(checkSource(source).map((e) => e.message).join("\n"), /@operator is only valid/);
    assert.match(checkSource(`\n#! katnip: stdlib\n${source}`).map((e) => e.message).join("\n"), /@operator is only valid/);
    assert.deepEqual(checkSource(`#! katnip: stdlib\r\n${source}`), []);

    const { errors, sb3 } = compileToSb3(`#! katnip: stdlib\nsprite Cat {}`);
    assert.equal(sb3, undefined);
    assert.match(errors.map((e) => e.message).join("\n"), /can only be checked/);
    assert.equal(compileToIR(`#! katnip: stdlib\nsprite Cat {}`).ir, undefined);
});
