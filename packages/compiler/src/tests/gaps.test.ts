/**
 * @fileoverview Executable spec for the features Katnip declares but does not yet lower.
 *
 * Every test here asserts the INTENDED behavior and is marked `todo`, so the suite stays
 * green while still describing the whole language rather than only the finished parts.
 * When a gap is implemented its test starts passing; drop the `todo` and it becomes a
 * normal regression test. Nothing here asserts current, known-wrong output: a test that
 * pins a bug in place has to be deleted before the bug can be fixed.
 *
 * Cross-referenced with features.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean, ENTRY_PATH, virtualResolver } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import { loadStdlibModules } from "../semantic/StdlibLoader.js";
import { opcodeSlots } from "../codegen/scratchDefs.js";
import { compileToSb3 } from "../index.js";
import { isBlock, type Block } from "../codegen/SB3TypeDefs.js";
import type { IRExpr, IRStmt } from "../ir/IRNode.js";
import { unzipSync } from "fflate";

/** The body of a sprite's first script. */
function script(source: string): IRStmt[] {
    const result = compile(source, { stdlib: true });
    expectClean(result);
    const program = new IRGenerator(result.analyzer).generate(result.ast);
    return program.sprites[0]!.scripts.at(-1)!.body;
}

/** Every variable read reachable from a statement list, control substacks included. */
function varReads(body: IRStmt[]): string[] {
    const out: string[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if (record.kind === "var") out.push(record.name as string);
        for (const value of Object.values(record)) walk(value);
    };
    walk(body);
    return out;
}

const isEmptyLit = (expr: IRExpr) => expr.kind === "lit" && expr.value === "";

test("the ** operator computes a power", { todo: "no opcode and no builds proc; the IR lowers it to an empty literal" }, () => {
    const body = script(`sprite Cat { events.onFlag() { temp x: num = 2 ** 3; looks.say(f"{x}"); } }`);
    const set = body.find((s): s is Extract<IRStmt, { kind: "raw" }> => s.kind === "raw" && s.opcode === "data_setvariableto")!;

    assert(!isEmptyLit(set.inputs[1]!), "2 ** 3 must lower to a real computation, not an empty literal");
});

test("imported procs reach codegen", { todo: "the IR walks only the entry file, so codegen throws 'call to unknown proc'" }, () => {
    const files = { "/proj/lib.knip": `public proc twice(n: num) -> num { return n * 2; }` };
    const { errors, sb3 } = compileToSb3(
        `import "./lib.knip";\nsprite Cat { events.onFlag() { looks.say(f"{lib.twice(2)}"); } }`,
        { path: ENTRY_PATH, resolve: virtualResolver(files) },
    );

    assert.deepEqual(errors, []);
    const project = JSON.parse(new TextDecoder().decode(unzipSync(sb3!)["project.json"]!));
    const protos = project.targets
        .flatMap((t: { blocks: Record<string, Block> }) => Object.values(t.blocks))
        .filter((b: Block) => isBlock(b) && b.opcode === "procedures_prototype");

    assert.equal(protos.length > 0, true, "the imported proc needs a definition in every target that calls it");
});

test("struct literals and field reads lower", { todo: "the IR no-ops every struct path; the analyzer is already complete" }, () => {
    const body = script(`struct Point { x: num, y: num }
sprite Cat { events.onFlag() { temp p: Point = Point(x = 1, y = 2); looks.say(f"{p.x}"); } }`);

    const say = body.find((s): s is Extract<IRStmt, { kind: "raw" }> => s.kind === "raw" && s.opcode === "looks_say")!;
    assert(!isEmptyLit(say.inputs[0]!), "p.x must read the field, not an empty literal");
});

test("a @lower = \"yields\" proc lowers", { todo: "lowerExpr has no branch for it; the plan lookup crashes" }, () => {
    const body = script(`public s: list<num> = [1, 2];
sprite Cat { events.onFlag() { temp gone: num = s.remove(1); looks.say(f"{gone}"); } }`);

    const opcodes = body.filter((s): s is Extract<IRStmt, { kind: "raw" }> => s.kind === "raw").map((s) => s.opcode);
    assert(opcodes.includes("data_deleteoflist"), "list.remove must emit its block before the value is read");
});

test("every stdlib opcode has codegen metadata", { todo: "the katnip_* builtins have no lowering; using one throws 'no slot metadata'" }, () => {
    const missing: string[] = [];
    for (const module of loadStdlibModules())
        for (const stmt of module.ast.body) {
            if (stmt.type !== "ProcedureDeclaration") continue;
            for (const decorator of stmt.decorators) {
                if (decorator.name !== "opcode" || decorator.value.type !== "Literal") continue;
                const opcode = String(decorator.value.value);
                if (!(opcode in opcodeSlots)) missing.push(`${module.namespace}.${stmt.name} -> ${opcode}`);
            }
        }

    // A proc the user can call but codegen cannot emit is a promise the compiler breaks
    // only once someone uses it, so the check is over the whole stdlib rather than per feature.
    assert.deepEqual(missing, [], `stdlib procs with no codegen metadata:\n  ${missing.join("\n  ")}`);
});

test("tuple destructuring reads every element", { todo: "a non-Identifier assignment target is skipped, dropping the call entirely" }, () => {
    const body = script(`proc two() -> (num, num) { return (1, 2); }
sprite Cat { events.onFlag() { temp a: num = 0; temp b: num = 0; (a, b) = two(); looks.say(f"{a}{b}"); } }`);

    assert.equal(body.filter((s) => s.kind === "call").length, 1, "the call must still be emitted");
    const slots = new Set(varReads(body).filter((name) => name.startsWith("two_ret")));
    assert.equal(slots.size, 2, "both return slots must be read");
});

test("a list declared inside a script lowers", () => {
    const body = script(`sprite Cat { events.onFlag() { temp xs: list<num> = [1, 2]; looks.say(f"{xs[1]}"); } }`);

    const say = body.find((s): s is Extract<IRStmt, { kind: "raw" }> => s.kind === "raw" && s.opcode === "looks_say")!;
    assert.equal((say.inputs[0] as { opcode?: string }).opcode, "data_itemoflist");
});

test("comments attach to the node they document", { todo: "the parser drops comment tokens; NodeBase.comment is never set" }, () => {
    const { ast } = compile(`# the running total\npublic score: num = 0;`);

    assert.match(ast.body[0]!.comment?.content ?? "", /running total/);
});
