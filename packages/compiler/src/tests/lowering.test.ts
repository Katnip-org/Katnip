/**
 * @fileoverview Runs lowered IR on a tiny evaluator, for features whose correctness is the value they compute
 * (`**`, slices, tuple patterns), and pins the constructs that must refuse to build instead of miscompiling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { compileToIR, compileToSb3 } from "../index.js";
import type { IRExpr, IRProc, IRProgram, IRStmt } from "../ir/IRNode.js";

class Stop extends Error {}

const mathops: Record<string, (x: number) => number> = {
    abs: Math.abs,
    floor: Math.floor,
    ln: Math.log,
    sqrt: Math.sqrt,
    "e ^": Math.exp,
};

/** Compile options serving these virtual files by bare name, so `import "./lib.knip"` finds "lib.knip". */
const withFiles = (files: Record<string, string>) => ({
    path: "/p/main.knip",
    resolve: (specifier: string) => {
        const name = specifier.replace("./", "");
        return files[name] === undefined ? null : { path: `/p/${name}`, source: files[name]! };
    },
});

/** Scratch's list lookups ignore case. */
const sameItem = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Runs the first sprite's scripts in order and returns everything `looks.say` said. */
function run(source: string, files: Record<string, string> = {}): unknown[] {
    const { errors, ir } = compileToIR(source, withFiles(files));
    assert.ok(ir, errors.map((e) => e.message).join("\n"));
    const program: IRProgram = ir;
    const sprite = program.sprites[0]!;
    const vars = new Map<string, any>([...program.variables, ...sprite.variables]);
    const lists = new Map<string, any[]>([...program.lists, ...sprite.lists].map(([k, v]) => [k, [...v]]));
    const procs = new Map<string, IRProc>([...program.procs.values(), ...sprite.procs.values()].map((p) => [p.name, p]));
    const said: unknown[] = [];
    const listOf = (expr: IRExpr) => lists.get((expr as { name: string }).name)!;

    const value = (expr: IRExpr, args: Map<string, any>): any => {
        switch (expr.kind) {
            case "lit": return expr.value;
            case "var": return vars.get(expr.name);
            case "param": return args.get(expr.name);
            case "stackref": {
                const list = lists.get(expr.list)!;
                return list[list.length - 1 - expr.depth];
            }
        }
        const at = (i: number) => value(expr.inputs[i]!, args);
        const n = (i: number) => Number(at(i));
        switch (expr.opcode) {
            case "operator_add": return n(0) + n(1);
            case "operator_subtract": return n(0) - n(1);
            case "operator_multiply": return n(0) * n(1);
            case "operator_divide": return n(0) / n(1);
            case "operator_mod": return n(0) % n(1);
            case "operator_gt": return n(0) > n(1);
            case "operator_lt": return n(0) < n(1);
            case "operator_equals": return String(at(0)) === String(at(1));
            case "operator_and": return at(0) && at(1);
            case "operator_or": return at(0) || at(1);
            case "operator_not": return !at(0);
            case "operator_join": return `${at(0)}${at(1)}`;
            case "operator_length": return String(at(0)).length;
            case "operator_letter_of": return String(at(1))[n(0) - 1] ?? "";
            case "operator_mathop": return mathops[at(0)]!(n(1));
            case "data_lengthoflist": return listOf(expr.inputs[0]!).length;
            case "data_itemoflist": return listOf(expr.inputs[0]!)[n(1) - 1] ?? "";
            case "data_itemnumoflist": return listOf(expr.inputs[0]!).findIndex((item) => sameItem(item, at(1))) + 1;
            case "data_listcontainsitem": return listOf(expr.inputs[0]!).some((item) => sameItem(item, at(1)));
        }
        throw new Error(`evaluator has no ${expr.opcode}`);
    };

    const exec = (stmts: IRStmt[], args: Map<string, any>): void => {
        for (const stmt of stmts) {
            switch (stmt.kind) {
                case "call": {
                    const proc = procs.get(stmt.proc)!;
                    const inner = new Map(proc.params.map((p, i) => [p.name, value(stmt.args[i]!, args)]));
                    try {
                        exec(proc.body, inner);
                    } catch (err) {
                        if (!(err instanceof Stop)) throw err;
                    }
                    break;
                }
                case "if":
                    exec(value(stmt.cond, args) ? stmt.then : stmt.else, args);
                    break;
                case "while":
                    while (value(stmt.cond, args)) exec(stmt.body, args);
                    break;
                case "repeat":
                    for (let i = Number(value(stmt.times, args)); i > 0; i--) exec(stmt.body, args);
                    break;
                case "for": {
                    // Scratch's for each re-reads its count on every iteration
                    for (let i = 1; i <= Number(value(stmt.times, args)); i++) {
                        vars.set(stmt.iter, i);
                        exec(stmt.body, args);
                        vars.set(stmt.iter, i);
                    }
                    break;
                }
                case "forever":
                    throw new Error("evaluator cannot run forever");
                case "raw": {
                    const [first, second] = stmt.inputs;
                    switch (stmt.opcode) {
                        case "data_setvariableto":
                            vars.set((first as { name: string }).name, value(second!, args));
                            break;
                        case "data_addtolist":
                            listOf(first!).push(value(second!, args));
                            break;
                        case "data_replaceitemoflist":
                            listOf(first!)[Number(value(second!, args)) - 1] = value(stmt.inputs[2]!, args);
                            break;
                        case "data_deletealloflist":
                            listOf(first!).length = 0;
                            break;
                        case "data_deleteoflist":
                            listOf(first!).pop();
                            break;
                        case "looks_say":
                            said.push(value(first!, args));
                            break;
                        case "control_stop":
                            throw new Stop();
                        default:
                            throw new Error(`evaluator has no ${stmt.opcode}`);
                    }
                }
            }
        }
    };
    for (const script of sprite.scripts) exec(script.body, new Map());
    return said;
}

/** What each expression says, one at a time, with `decls` at the top level. */
function says(expr: string, decls = ""): unknown {
    return run(`${decls} sprite Cat { events.onFlag() { looks.say(f"{${expr}}"); } }`)[0];
}

test("** folds literals and computes through inline blocks or math.pow", () => {
    assert.equal(says("2 ** 3"), 8);
    assert.equal(says("2 ** -2"), 0.25);
    assert.equal(says("(0 - 2) ** 3"), -8);
    assert.equal(says("2 ** 3 ** 2"), 512, "right associative");

    const vars = `public b: num = 2; public n: num = 0 - 8; public e: num = 2;`;
    assert.equal(says("b ** 0", vars), 1);
    assert.equal(says("b ** 1", vars), 2);
    assert.equal(says("b ** 2", vars), 4);
    assert.equal(says("b ** 3", vars), 8);
    assert.equal(says("(b + 1) ** 2", vars), 9);
    assert.equal(says("b ** 4", vars), 16);
    assert.equal(says("b ** 40", vars), 2 ** 40);
    assert.equal(says("b ** -2", vars), 0.25);
    assert.equal(says("n ** 3", vars), -512);
    assert.equal(says("b ** e", vars), 4);
    assert.ok(Math.abs((says("b ** 1.5", vars) as number) - Math.SQRT2 * 2) < 1e-9);
    assert.ok(Math.abs((says("b ** 0.5", vars) as number) - Math.SQRT2) < 1e-9);
    assert.ok(Number.isNaN(says("n ** 1.5", vars)), "no real answer");
    assert.ok(Number.isNaN(says("n ** 0.5", vars)), "no real answer");
});

/** The first sprite's only script, plus whether the project needed any shared proc. */
function lowered(source: string) {
    const { errors, ir } = compileToIR(source);
    assert.ok(ir, errors.map((e) => e.message).join("\n"));
    return { body: ir.sprites[0]!.scripts.at(-1)!.body, procs: [...ir.procs.keys()] };
}

test("small literal powers are plain multiplies with no proc", () => {
    const { body, procs } = lowered(`public b: num = 2; sprite Cat { events.onFlag() { private x: num = b ** 2; } }`);
    assert.deepEqual(procs, []);
    assert.deepEqual(body, [
        {
            kind: "raw",
            opcode: "data_setvariableto",
            inputs: [
                { kind: "var", name: "x" },
                { kind: "op", opcode: "operator_multiply", inputs: [{ kind: "var", name: "b" }, { kind: "var", name: "b" }] },
            ],
        },
    ]);
    assert.deepEqual(lowered(`public b: num = 2; sprite Cat { events.onFlag() { private x: num = b ** 4; } }`).procs, ["katnip_pow"]);
});

test("a base that isn't a plain read is computed once, so a random base squares one roll", () => {
    const { body } = lowered(`sprite Cat { events.onFlag() { private x: num = math.random(1, 6) ** 2; } }`);
    const rolls = JSON.stringify(body).split("operator_random").length - 1;
    assert.equal(rolls, 1);
});

test("a return value used as a base survives a later call", () => {
    const f = `proc f(n: num) -> num { return n; }`;
    assert.equal(says("f(2) ** 2 + f(3)", f), 7);
    assert.equal(says("f(2) ** 2 + f(3) ** 2", f), 13);
    assert.equal(says("(f(2) + 1) ** 2 + f(3)", f), 12);
});

test("a loop condition with an inline power is recomputed every iteration", () => {
    const said = run(`public n: num = 0;
sprite Cat { events.onFlag() { while ((n + 1) ** 2 < 10) { n += 1; } looks.say(f"{n}"); } }`);
    assert.deepEqual(said, [3]);
});

test("short literal string slices are letter blocks with no proc; the rest use str.slice", () => {
    const procsOf = (slice: string) =>
        lowered(`public s: str = "abc"; sprite Cat { events.onFlag() { looks.say(${slice}); } }`).procs;
    assert.deepEqual(procsOf("s[2:4]"), []);
    assert.deepEqual(procsOf("s[:8]"), []);
    assert.deepEqual(procsOf("s[3:1:-1]"), []);
    assert.deepEqual(procsOf("s[:9]"), ["katnip_slice"]);
    assert.deepEqual(procsOf("s[2:]"), ["katnip_slice"]);
    assert.deepEqual(procsOf("s[::-1]"), ["katnip_slice"]);

    const one = lowered(`public s: str = "abc"; sprite Cat { events.onFlag() { looks.say(s[2:2]); } }`);
    assert.equal(JSON.stringify(one.body).split("operator_join").length - 1, 0);
});

test("a computed string is read once by an inline slice", () => {
    const said = run(`public a: str = "ab"; public n: num = 0;
proc next() -> str { n += 1; return a; }
sprite Cat { events.onFlag() { looks.say(next()[1:2]); looks.say(f"{n}"); } }`);
    assert.deepEqual(said, ["ab", 1]);
    assert.equal(says("(a + a)[2:3]", `public a: str = "ab";`), "ba");
});

test("**= and math.pow both reach the same proc", () => {
    const said = run(`sprite Cat { events.onFlag() { private x: num = 3; x **= 2; looks.say(f"{x}"); looks.say(f"{math.pow(2, 5)}"); } }`);
    assert.deepEqual(said, [9, 32]);
});

test("the pow proc only enters a project that uses it", () => {
    const { ir } = compileToIR(`sprite Cat { events.onFlag() { looks.say("hi"); } }`);
    assert.deepEqual([...ir!.procs.keys()], []);
    assert.deepEqual([...ir!.variables.keys()], []);
});

test("two calls in one statement each keep their own return value", () => {
    const f = `proc f(n: num) -> num { return n; } proc g(n: num) -> num { return f(n) * 10; }`;
    assert.equal(says("f(1) + f(2)", f), 3);
    assert.equal(says("f(1) + g(2)", f), 21, "a nested call clobbers the same variable");
    assert.equal(says("f(f(3))", f), 3);
    assert.equal(says("2 ** 3 + 3 ** 2"), 17);
});

test("a condition with two calls is recomputed every iteration", () => {
    const said = run(`public n: num = 0;
proc f(x: num) -> num { return x; }
sprite Cat { events.onFlag() { while (f(n) + f(1) < 4) { n += 1; } looks.say(f"{n}"); } }`);
    assert.deepEqual(said, [3]);
});

test("string slices are 1-based and stop-inclusive", () => {
    const s = `public s: str = "abcdef";`;
    assert.equal(says("s[2:4]", s), "bcd");
    assert.equal(says("s[:2]", s), "ab");
    assert.equal(says("s[5:]", s), "ef");
    assert.equal(says("s[1:5:2]", s), "ace");
    assert.equal(says("s[::-1]", s), "fedcba");
    assert.equal(says("s[4:2:-1]", s), "dcb");
    assert.equal(says("s[5:99]", s), "ef");
    assert.equal(says("s[5:7]", s), "ef");
    assert.equal(says("s[3:3]", s), "c");
    assert.equal(says("s[1:20:3]", s), "ad");
    assert.equal(says("s[4:2]", s), "");
});

test("list slices fill a declaration, a loop and a reassignment", () => {
    const said = run(`public xs: list<num> = [1, 2, 3, 4, 5];
public ys: list<num> = [];
sprite Cat {
    events.onFlag() {
        private part = xs[2:3];
        looks.say(f"{part.length()}{part[2]}");
        for (x, xs[4:]) { looks.say(f"{x}"); }
        ys = xs[::-2];
        looks.say(f"{ys[1]}{ys[3]}");
        xs = xs[2:2];
        looks.say(f"{xs.length()}{xs[1]}");
    }
}`);
    assert.deepEqual(said, ["23", 4, 5, "51", "12"]);
});

test("slices package into a project, including from the top level", () => {
    const { errors, sb3 } = compileToSb3(`public xs: list<num> = [1, 2, 3];
public ys = xs[2:];
public s: str = "abc";
sprite Cat { private zs = xs[:2]; events.onFlag() { looks.say(s[1:2]); looks.say(f"{2 ** 8}"); } }
sprite Dog { private zs = xs[:1]; }`);
    assert.deepEqual(errors, []);
    assert.ok(sb3);
});

test("slice bounds are checked", () => {
    const message = (source: string) => compileToSb3(source).errors.map((e) => e.message).join("\n");
    assert.match(message(`public n: num = 1; sprite Cat { events.onFlag() { looks.say(n[1:2]); } }`), /Cannot slice/);
    assert.match(message(`public s: str = "a"; sprite Cat { events.onFlag() { looks.say(s["a":2]); } }`), /slice bound/);
    assert.match(message(`public s: str = "a"; sprite Cat { events.onFlag() { looks.say(s[1:2:0]); } }`), /step cannot be 0/);
    assert.match(message(`public s: str = "a"; public k: num = 1; sprite Cat { events.onFlag() { looks.say(s[1::k]); } }`), /computed step/);
});

test("tuple patterns unpack var and vstack returns, and swap", () => {
    const flat = run(`proc two() -> (num, num) { return (1, 2); }
sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; (a, b) = two(); looks.say(f"{a}{b}"); (a, b) = (b, a); looks.say(f"{a}{b}"); two(); } }`);
    assert.deepEqual(flat, ["12", "21"]);

    const cyclic = run(`proc pair(n: num) -> (num, num) {
    if (n == 0) { return (1, 2); }
    private x: num = 0;
    private y: num = 0;
    (x, y) = pair(n - 1);
    return (x + 1, y + 2);
}
sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; (a, b) = pair(2); looks.say(f"{a}{b}"); } }`);
    assert.deepEqual(cyclic, ["36"]);
});

test("tuple patterns are checked", () => {
    const two = `proc two() -> (num, num) { return (1, 2); }`;
    const message = (body: string) =>
        compileToSb3(`${two} public l: list<num> = [1]; sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; ${body} } }`)
            .errors.map((e) => e.message).join("\n");
    assert.match(message(`(a, l[1]) = two();`), /plain variables/);
    assert.match(message(`(a, b) += two();`), /cannot assign to a tuple/);
    assert.match(message(`(a, b) = 1;`), /Cannot assign/);
    assert.match(message(`private c: str = ""; (a, c) = two();`), /Cannot assign/);
});

const DICTS = `public d: dict<str, num> = {"a": 1, "b": 2}; public e: dict<str, num> = {"b": 20, "c": 30};`;
const dictRun = (body: string) => run(`${DICTS} sprite Cat { events.onFlag() { ${body} } }`);

test("dict.merge overwrites shared keys, appends new ones and leaves the source alone", () => {
    assert.deepEqual(
        dictRun(`d.merge(e); for ((k, v), d) { looks.say(f"{k}={v}"); } looks.say(f"{e.length()}");`),
        ["a=1", "b=20", "c=30", 2],
    );
});

test("merging a dict into itself changes nothing", () => {
    assert.deepEqual(dictRun(`d.merge(d); for ((k, v), d) { looks.say(f"{k}={v}"); }`), ["a=1", "b=2"]);
});

test("dict.contains and dict.length report the keys, ignoring case as Scratch does", () => {
    assert.deepEqual(
        dictRun(`looks.say(f"{d.length()}"); if (d.contains("a")) { looks.say("a"); } if (d.contains("A")) { looks.say("A"); } if (d.contains("z")) { looks.say("z"); }`),
        [2, "a", "A"],
    );
});

test("keys() and values() are live, and a stored copy is not", () => {
    assert.deepEqual(
        dictRun(`private own: list<str> = d.keys(); d["z"] = 9;
            looks.say(f"{own.length()}"); looks.say(f"{d.keys().length()}"); looks.say(f"{d.values()[3]}");
            for (k, d.keys()) { looks.say(k); }`),
        [2, 3, 9, "a", "b", "z"],
    );
});

test("zip walks keys() and values() together", () => {
    assert.deepEqual(dictRun(`for ((k, v), zip(d.keys(), d.values())) { looks.say(f"{k}{v}"); }`), ["a1", "b2"]);
});

const LISTS = `public a: list<num> = [1, 2]; public b: list<num> = [10, 20, 30];`;
const listRun = (procs: string, body: string) => run(`${LISTS} ${DICTS} ${procs} sprite Cat { events.onFlag() { ${body} } }`);

test("list.merge appends, and merging a list into itself doubles it once", () => {
    assert.deepEqual(listRun("", `a.merge(b); looks.say(f"{a.length()},{a[3]},{b.length()}"); b.merge(b); looks.say(f"{b.length()},{b[6]}");`), ["5,10,3", "6,30"]);
});

test("list.merge on a list of structs still refuses to build", () => {
    const { errors, sb3 } = compileToSb3(`struct P { x: num = 0 } public ps: list<P> = []; sprite Cat { events.onFlag() { ps.merge(ps); } }`);
    assert.equal(sb3, undefined);
    assert.match(errors.map((e) => e.message).join("\n"), /isn't supported on a list of structs/);
});

test("list slices run through the stdlib, including backwards and out of range", () => {
    const body = `private c: list<num> = []; c = b[3:1:-1]; looks.say(f"{c.length()},{c[1]},{c[3]}");
        c = b[0:9]; looks.say(f"{c.length()},{c[1]}"); c = b[2:3]; c = c[1:1]; looks.say(f"{c.length()},{c[1]}");`;
    assert.deepEqual(listRun("", body), ["3,30,10", "3,10", "1,20"]);
});

test("a stdlib proc taking lists stays out of a project that doesn't call it", () => {
    const { ir } = compileToIR(`public a: list<num> = [1]; sprite Cat { events.onFlag() { a.add(1); } }`);
    assert.equal(ir!.procs.size + ir!.sprites[0]!.procs.size, 0);
});

test("motion.getPosition unpacks x and y", () => {
    const { errors, sb3 } = compileToSb3(`public a: num = 0; public b: num = 0; sprite Cat { events.onFlag() { (a, b) = motion.getPosition(); motion.setX(motion.x() + motion.y()); } }`);
    assert.ok(sb3, errors.map((e) => e.message).join("\n"));
});

test("calls that would silently do nothing, or wipe the list, refuse to build", () => {
    const cases: [string, RegExp][] = [
        [`d.values().merge(a);`, /read-only/],
        [`a.sliceInto(a, 1, 1);`, /use a slice instead/],
        [`a.sliceInto(b, 1, 1);`, /use a slice instead/],
    ];
    for (const [body, expected] of cases) {
        const { errors, sb3 } = compileToSb3(`${LISTS} ${DICTS} sprite Cat { events.onFlag() { ${body} } }`);
        assert.equal(sb3, undefined, body);
        assert.match(errors.map((e) => e.message).join("\n"), expected, body);
    }
});

test("a list param reads whichever list each call passes", () => {
    const sum = `proc sum(xs: list<num>) -> num { private t: num = 0; for (x, xs) { t += x; } return t; }`;
    assert.deepEqual(listRun(sum, `looks.say(f"{sum(a)}"); looks.say(f"{sum(b)}"); looks.say(f"{sum(a)}");`), [3, 60, 3]);
});

test("writing through a list param changes the caller's list", () => {
    assert.deepEqual(
        listRun(`proc push(xs: list<num>, v: num) -> void { xs.add(v); xs[1] = v; }`, `push(a, 7); looks.say(f"{a[1]},{a.length()},{b[1]}");`),
        ["7,3,10"],
    );
});

test("a dict param reaches both columns", () => {
    assert.deepEqual(
        listRun(`proc put(m: dict<str, num>) -> void { m["q"] = 5; for ((k, v), m) { looks.say(f"{k}{v}"); } }`, `put(e); looks.say(f"{d.length()}");`),
        ["b20", "c30", "q5", 2],
    );
});

test("a list param passes through other procs, and recursion stays on one copy", () => {
    const procs = `proc last(xs: list<num>, i: num) -> num { if (i == xs.length()) { return xs[i]; } return last(xs, i + 1); }
        proc outer(ys: list<num>) -> num { return last(ys, 1); }`;
    assert.deepEqual(listRun(procs, `looks.say(f"{outer(a)}"); looks.say(f"{outer(b)}");`), [2, 30]);
});

test("slices and keys() can be passed, and a proc writing to keys() can't touch the dict", () => {
    const procs = `proc count(xs: list<any>) -> num { xs.add(0); return xs.length(); }`;
    assert.deepEqual(listRun(procs, `looks.say(f"{count(b[1:2])}"); looks.say(f"{count(d.keys())}"); looks.say(f"{d.length()}");`), [3, 3, 2]);
});

test("a struct list param keeps its field columns", () => {
    const procs = `struct P { x: num = 0, y: num = 0 } public ps: list<P> = [P(x = 1, y = 2)];
        proc ys(l: list<P>) -> num { l.add(P(x = 3, y = 4)); return l[l.length()].y + l[1].y; }`;
    assert.deepEqual(listRun(procs, `looks.say(f"{ys(ps)}"); looks.say(f"{ps.length()}");`), [6, 2]);
});

test("each sprite gets its own copy, which can reach its private list", () => {
    const { errors, ir } = compileToIR(`public g: list<num> = [1];
        proc size(xs: list<num>) -> num { return xs.length(); }
        sprite A { private own: list<num> = [1, 2]; events.onFlag() { looks.say(f"{size(own)}"); looks.say(f"{size(g)}"); } }
        sprite B { events.onFlag() { looks.say(f"{size(g)}"); } }`);
    assert.ok(ir, errors.map((e) => e.message).join("\n"));
    assert.deepEqual([...ir.sprites[0]!.procs.keys()].sort(), ["size_g", "size_own"]);
    assert.deepEqual([...ir.sprites[1]!.procs.keys()], ["size_g_1"]);
    assert.equal(ir.procs.size, 0, "the uncopied proc must not reach the project");
});

test("a copy of a global proc reads the global a sprite member shadows", () => {
    const said = run(`public n: num = 1; public g: list<num> = [5];
        proc read(xs: list<num>) -> num { return n + xs[1]; }
        sprite A { private n: num = 100; events.onFlag() { looks.say(f"{read(g)}"); } }`);
    assert.deepEqual(said, [6]);
});

test("list param projects build to a real sb3", () => {
    const { errors, sb3 } = compileToSb3(`public a: list<num> = [1]; public b: list<num> = [2];
        proc size(@proccode = "size of %xs and %n", xs: list<num>, n: num) -> num { return xs.length() + n; }
        sprite A { events.onFlag() { looks.say(f"{size(a, 1)}"); looks.say(f"{size(b, 1)}"); } }`);
    assert.ok(sb3, errors.map((e) => e.message).join("\n"));
});

test("constructs with no lowering refuse to build", () => {
    const cases: [string, RegExp][] = [
        [`looks.say("hi"); sprite Cat {}`, /top level/],
        [`sprite Cat { looks.say("hi"); }`, /directly in a sprite/],
        [`public c: list<num> = range(5); sprite Cat {}`, /initialized from a literal/],
        [`public a: list<num> = []; public b = a; sprite Cat {}`, /initialized from a literal/],
        [`public a: list<num> = []; public b: list<num> = []; sprite Cat { events.onFlag() { a = b; } }`, /whole list/],
        [`public a: list<num> = []; sprite Cat { events.onFlag() { if (a == a) { } } }`, /whole lists/],
        [`proc two() -> (num, num) { return (1, 2); } sprite Cat { events.onFlag() { private a = two(); } }`, /must be unpacked/],
        [`sprite Cat { events.onFlag() { private t: (num, num) = (1, 2); } }`, /returned or unpacked/],
        [`private p: list<(str, num)> = [("a", 1)]; sprite Cat {}`, /returned or unpacked/],
    ];
    for (const [source, expected] of cases) {
        const { errors, sb3 } = compileToSb3(source);
        assert.equal(sb3, undefined, source);
        assert.match(errors.map((e) => e.message).join("\n"), expected, source);
    }
});

test("a stdlib constant can't be written", () => {
    const { errors, sb3 } = compileToSb3(`sprite Cat { events.onFlag() { math.pi = 2; } }`);
    assert.equal(sb3, undefined);
    assert.match(errors.map((e) => e.message).join("\n"), /read-only/);
});

// -- module state --
const say = (...exprs: string[]) => exprs.map((expr) => `looks.say(f"{${expr}}");`).join(" ");
const inFlag = (imports: string, body: string) => `${imports} sprite Cat { events.onFlag() { ${body} } }`;

test("a module keeps private state between calls", () => {
    const lib = `private n: num = 0; public proc bump() -> num { n += 1; return n; }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, `lib.bump(); ${say("lib.bump()")}`), { "lib.knip": lib }), [2]);
});

test("the importer can read and write public module state, and the module sees it", () => {
    const lib = `public n: num = 1; public proc get() -> num { return n; } public proc set2() -> void { n = 2; }`;
    const body = `${say("lib.n")} lib.n = 5; ${say("lib.get()")} lib.n += 1; ${say("lib.n")} lib.set2(); ${say("lib.n")}`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, body), { "lib.knip": lib }), [1, 5, 6, 2]);
});

test("two modules and the main file can share a variable name", () => {
    const files = { "a.knip": `public n: num = 0; public proc set() -> void { n = 1; }`, "b.knip": `public n: num = 0; public proc set() -> void { n = 2; }` };
    const source = inFlag(`import "./a.knip"; import "./b.knip"; public n: num = 3;`, `a.set(); b.set(); ${say("a.n", "b.n", "n")}`);
    assert.deepEqual(run(source, files), [1, 2, 3]);
});

test("module lists and dicts work from both sides", () => {
    const lib = `public xs: list<num> = [1]; public d: dict<str, num> = {"a": 1}; public proc grow() -> void { xs.add(2); d["b"] = 2; }`;
    const body = `lib.grow(); lib.xs.add(3); lib.xs[1] = 9; lib.d["c"] = 3; ${say("lib.xs.length()", "lib.xs[1]", "lib.d.length()", "lib.d.contains(\"b\")")} for (x, lib.xs) { ${say("x")} }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, body), { "lib.knip": lib }), [3, 9, 3, true, 9, 2, 3]);
});

test("a module can pass its list to a list param, and the importer can too", () => {
    const lib = `public xs: list<num> = [1, 2]; public proc total(l: list<num>) -> num { private t: num = 0; for (x, l) { t += x; } return t; } public proc own() -> num { return total(xs); }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, say("lib.own()", "lib.total(lib.xs)")), { "lib.knip": lib }), [3, 3]);
});

test("module structs and struct lists hold state", () => {
    const lib = `struct P { x: num = 0, y: num = 0 } public p: P = P(x = 1); public ps: list<P> = [];
        public proc store() -> void { ps.add(P(x = p.x, y = 7)); p.x = 2; }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, `lib.store(); ${say("lib.p.x", "lib.ps.length()", "lib.ps[1].y")}`), { "lib.knip": lib }), [2, 1, 7]);
});

test("a module initializer that needs blocks runs before the user's scripts", () => {
    const lib = `public n: num = 2 + 3; public xs: list<num> = [n, n + 1];`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, say("lib.n", "lib.xs[2]")), { "lib.knip": lib }), [5, 6]);
});

test("one module's state reaches another that imports it", () => {
    const files = { "store.knip": `public n: num = 0;`, "user.knip": `import "./store.knip"; public proc bump() -> void { store.n += 1; }` };
    assert.deepEqual(run(inFlag(`import "./user.knip"; import "./store.knip";`, `user.bump(); user.bump(); ${say("store.n")}`), files), [2]);
});

test("a proc touching module state builds even when nothing calls it", () => {
    const { errors, sb3 } = compileToSb3(inFlag(`import "./lib.knip";`, ""), withFiles({ "lib.knip": `private n: num = 0; public proc bump() -> void { n += 1; }` }));
    assert.ok(sb3, errors.map((e) => e.message).join("\n"));
});

test("never-written literals fold, inside the module and out, and add no variable", () => {
    const lib = `public limit: num = 10; private half: num = 5; public proc sum() -> num { return limit + half; }`;
    const { ir } = compileToIR(inFlag(`import "./lib.knip";`, say("lib.limit", "lib.sum()")), withFiles({ "lib.knip": lib }));
    assert.deepEqual([...ir!.variables.keys()].filter((name) => name.startsWith("lib.")), []);
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, say("lib.limit", "lib.sum()")), { "lib.knip": lib }), [10, 15]);
});

test("a proc local shadows its module's constant", () => {
    const lib = `public limit: num = 10; public proc f() -> num { private limit: num = 1; return limit; }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, say("lib.f()")), { "lib.knip": lib }), [1]);
});

test("enumerate over a struct list binds the index and the fields", () => {
    const decls = `struct P { x: num = 0, y: num = 0 } public ps: list<P> = [P(x = 1, y = 2), P(x = 3, y = 4)];`;
    assert.deepEqual(run(`${decls} sprite Cat { events.onFlag() { for ((i, p), enumerate(ps)) { looks.say(f"{i}:{p.x},{p.y}"); } } }`), ["1:1,2", "2:3,4"]);
    assert.deepEqual(run(`${decls} sprite Cat { events.onFlag() { for (i, enumerate(ps)) { looks.say(f"{i}"); } } }`), [1, 2]);
});

test("enumerate works on a struct list param and a module's struct list", () => {
    const lib = `struct P { x: num = 0 } public ps: list<P> = [P(x = 5)];
        public proc total(l: list<P>) -> num { private t: num = 0; for ((i, p), enumerate(l)) { t += i * p.x; } return t; }`;
    assert.deepEqual(run(inFlag(`import "./lib.knip";`, say("lib.total(lib.ps)")), { "lib.knip": lib }), [5]);
});

const buildErrors = (source: string, files: Record<string, string>): string[] =>
    compileToIR(source, withFiles(files)).errors.filter((e) => e.severity === "error").map((e) => e.message);

test("a builds proc inlined into an importer still sees its own module's struct list", () => {
    const lib = `
        struct Item { n: num = 0 }
        private items: list<Item> = [];
        public proc first(@lower = "builds") -> num { return items[1].n; }
        public proc nth(@lower = "builds", i: num) -> num { return items[i].n + first(); }
    `;
    const main = `import "./lib.knip"; sprite A { private v: num = 0; events.onFlag() { v = lib.nth(1); } }`;
    assert.deepEqual(buildErrors(main, { "lib.knip": lib }), []);
});

test("an importer can read a struct field typed by an enum in that struct's module", () => {
    const lib = `
        public enum Kind { A, B }
        struct Item { kind: Kind = Kind.A }
        public items: list<Item> = [];
    `;
    const main = `import "./lib.knip"; sprite A { events.onFlag() {
        if (lib.items[1].kind == lib.Kind.B) { lib.items[1].kind = lib.Kind.A; }
    } }`;
    assert.deepEqual(buildErrors(main, { "lib.knip": lib }), []);
});

test("an error lowering a module's proc names that module's file", () => {
    const lib = `
        private a: list<num> = [];
        private b: list<num> = [];
        public proc f() -> void { a = b; }
    `;
    const main = `import "./lib.knip"; sprite A { events.onFlag() { lib.f(); } }`;
    const [message] = buildErrors(main, { "lib.knip": lib });
    assert.match(message!, /lib\.knip:4:/);
});

test("a sprite in an imported file is an error, not silently dropped", () => {
    const main = `import "./lib.knip"; sprite A { }`;
    assert.match(buildErrors(main, { "lib.knip": `sprite B { }` }).join(), /sprite can only be declared/);
});

test("one struct name with two shapes across files is an error; the same shape is fine", () => {
    const one = `struct P { x: num = 0 } public proc f() -> void { }`;
    const other = `struct P { y: num = 0 } public proc g() -> void { }`;
    const main = `import "./one.knip"; import "./other.knip"; sprite A { }`;
    assert.match(buildErrors(main, { "one.knip": one, "other.knip": other }).join(), /different fields/);
    assert.deepEqual(buildErrors(main, { "one.knip": one, "other.knip": one }), []);
});

test("statements after clone.delete() or forever warn that they never run", () => {
    const warned = (body: string): boolean =>
        compileToIR(`sprite A { events.onFlag() { ${body} } }`).errors.some((e) => e.severity === "warning" && /nothing after this runs/.test(e.message));
    assert.equal(warned(`clone.delete(); looks.show();`), true);
    assert.equal(warned(`forever { wait(1); } looks.show();`), true);
    assert.equal(warned(`looks.show(); clone.delete();`), false);
    assert.equal(warned(`if (1 == 1) { clone.delete(); } looks.show();`), false);
});

test("a target only gets the global procs its scripts reach", () => {
    const lib = `
        public n: num = 0;
        public proc inner() -> void { n += 1; }
        public proc outer() -> void { inner(); }
        public proc unused() -> void { n -= 1; }
    `;
    const main = `import "./lib.knip";
        sprite A { events.onFlag() { lib.outer(); } }
        sprite B { events.onFlag() { looks.show(); } }
        stage { events.onFlag() { looks.nextBackdrop(); } }`;
    const { sb3 } = compileToSb3(main, withFiles({ "lib.knip": lib }));
    const project = JSON.parse(strFromU8(unzipSync(sb3!)["project.json"]!)) as { targets: { name: string; blocks: unknown }[] };
    const procsOf = (name: string): string[] =>
        Object.values(project.targets.find((t) => t.name === name)!.blocks as Record<string, { opcode: string; mutation?: { proccode: string } }>)
            .filter((b) => b.opcode === "procedures_prototype")
            .map((b) => b.mutation!.proccode)
            .sort();
    assert.deepEqual(procsOf("A"), ["inner", "outer"]);
    assert.deepEqual(procsOf("B"), []);
    assert.deepEqual(procsOf("Stage"), []);
});
