/**
 * @fileoverview The public entry points, and the seam between stages.
 * Every other suite drives one stage directly; these drive the pipeline the way an
 * embedder does, so a stage that is individually correct but wired up wrong still fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { checkSource, compileToSb3 } from "../index.js";
import { ENTRY_PATH, virtualResolver } from "./helpers.js";

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
