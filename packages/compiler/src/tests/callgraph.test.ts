import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCalls } from "../semantic/CallGraph.js";
import { compile, expectClean } from "./helpers.js";

/** Map of proc name -> resolved return strategy (undefined for void/builtin). */
function strategies(source: string, opts?: { stdlib?: boolean }): Map<string, string | undefined> {
    const result = compile(source, opts);
    expectClean(result);
    const out = new Map<string, string | undefined>();
    for (const [decl, sig] of result.analyzer.procSignatures) {
        out.set(decl.name, sig.meta?.retResolved);
    }
    return out;
}

test("collectCalls finds calls in every expression position", () => {
    const { ast } = compile(`
        proc f() -> void {
            private a = g(h(1)) + 2;
            if (g(3) == 0) { k(); }
            xs.remove(g(4));
        }
    `);
    const calls = collectCalls(ast.body);
    // g(h(1)), h(1), g(3), k(), xs.remove(...), g(4)
    assert.equal(calls.length, 6);
});

test("acyclic chain a -> b -> c resolves everything to var", () => {
    const result = strategies(`
        proc c(x: num) -> num { return x + 1; }
        proc b(x: num) -> num { return c(x) + 1; }
        proc a(x: num) -> num { return b(x) + 1; }
    `);
    assert.deepEqual([...result.values()], ["var", "var", "var"]);
});

test("three-proc cycle forces vstack on every member", () => {
    const result = strategies(`
        proc a(n: num) -> num { if (n < 1) { return 0; } return b(n - 1); }
        proc b(n: num) -> num { return c(n); }
        proc c(n: num) -> num { return a(n); }
    `);
    assert.deepEqual([...result.values()], ["vstack", "vstack", "vstack"]);
});

test("self-recursion counts as a cycle", () => {
    const result = strategies(`
        proc f(n: num) -> num { if (n < 1) { return 0; } return f(n - 1); }
    `);
    assert.equal(result.get("f"), "vstack");
});

test("a proc outside the cycle stays var even when it calls into one", () => {
    const result = strategies(`
        proc loop(n: num) -> num { if (n < 1) { return 0; } return loop(n - 1); }
        proc caller(n: num) -> num { return loop(n) + 1; }
    `);
    assert.equal(result.get("loop"), "vstack");
    assert.equal(result.get("caller"), "var");
});

test("diamond call graph (no cycle) stays var", () => {
    const result = strategies(`
        proc bottom(x: num) -> num { return x; }
        proc left(x: num) -> num { return bottom(x); }
        proc right(x: num) -> num { return bottom(x); }
        proc top(x: num) -> num { return left(x) + right(x); }
    `);
    assert.deepEqual([...result.values()], ["var", "var", "var", "var"]);
});

test("explicit @ret pins the strategy on acyclic procs", () => {
    const result = strategies(`
        proc pinned(@ret = "vstack", x: num) -> num { return x; }
        proc chosen(@ret = "var", x: num) -> num { return x; }
    `);
    assert.equal(result.get("pinned"), "vstack");
    assert.equal(result.get("chosen"), "var");
});

test("void procs and builtins get no return strategy", () => {
    const result = compile(
        `
        proc doThing() -> void { console.log("x"); }
    `,
        { stdlib: true },
    );
    expectClean(result);
    const sig = [...result.analyzer.procSignatures.values()][0];
    assert.equal(sig.meta?.retResolved, undefined);
});

test("stdlib calls do not create cycle edges", () => {
    // f calls reporters/commands only: still acyclic -> var
    const result = strategies(
        `
        private xs = [1];
        proc f() -> num { console.log("x"); return xs.length() + 1; }
    `,
        { stdlib: true },
    );
    assert.equal(result.get("f"), "var");
});

test("mutual recursion detected through an expression argument", () => {
    const result = strategies(`
        proc a(n: num) -> num { if (n < 1) { return 0; } return b(a(n - 1)); }
        proc b(n: num) -> num { return n; }
    `);
    assert.equal(result.get("a"), "vstack"); // self-recursive via its own argument
    assert.equal(result.get("b"), "var"); // called by a, but in no cycle
});
