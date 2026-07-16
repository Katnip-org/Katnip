import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean, formatErrors } from "./helpers.js";

/** Compiles and returns the joined error messages ("" when clean). */
function errorsOf(source: string, opts?: { stdlib?: boolean }): string {
    return formatErrors(compile(source, opts).reporter);
}

test("undefined identifiers are reported", () => {
    assert.match(errorsOf("temp x = missing;"), /'missing' is not defined/);
});

test("declaration type mismatch is reported", () => {
    assert.match(errorsOf(`temp x: num = "hello";`), /cannot be initialized/);
});

test("declaration needs a type or an initializer", () => {
    // The parser already requires `:` or `=` after the name.
    const result = compile("temp x;");
    assert.equal(result.reporter.hasErrors(), true);
});

test("assignment type mismatch is reported", () => {
    const errors = errorsOf(`
        temp x = 1;
        proc f() -> void { x = "str"; }
    `);
    assert.match(errors, /Cannot assign value of type 'str'/);
});

test("conditions must be bool", () => {
    assert.match(errorsOf("proc f() -> void { if (1) { } }"), /must be of type 'bool'/);
    assert.match(errorsOf("proc f() -> void { while (2) { } }"), /must be of type 'bool'/);
});

test("return outside a procedure is an error", () => {
    assert.match(errorsOf("return 1;"), /'return' can only be used inside a procedure/);
});

test("return type mismatch is reported", () => {
    assert.match(
        errorsOf(`proc f() -> num { return "s"; }`),
        /not assignable to return type 'num'/,
    );
});

test("call argument checking: missing, extra, unknown named", () => {
    const proc = "proc f(a: num, b: num) -> void { }\n";
    assert.match(errorsOf(proc + "proc g() -> void { f(1); }"), /Missing argument 'b'/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, 2, 3); }"), /at most 2 positional/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, c = 2); }"), /no parameter named 'c'/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, b = 2); f(1, 2); }"), /^$/);
});

test("argument type mismatch names the parameter", () => {
    const errors = errorsOf(`
        proc f(a: num) -> void { }
        proc g() -> void { f("s"); }
    `);
    assert.match(errors, /Argument 'a' expects num, got str/);
});

test("positional argument cannot follow a named argument", () => {
    const errors = errorsOf(`
        proc f(a: num, b: num) -> void { }
        proc g() -> void { f(a = 1, 2); }
    `);
    assert.match(errors, /Positional argument cannot follow a named argument/);
});

test("overloads select by arity", () => {
    const result = compile(`
        proc f(a: num) -> num { return a; }
        proc f(a: num, b: num) -> num { return a + b; }
        proc g() -> num { return f(1) + f(1, 2); }
    `);
    expectClean(result);
});

test("no matching overload is reported", () => {
    const errors = errorsOf(`
        proc f(a: num) -> void { }
        proc f(a: num, b: num) -> void { }
        proc g() -> void { f(1, 2, 3); }
    `);
    assert.match(errors, /No overload of 'f' matches/);
});

test("duplicate declarations conflict, procs may overload", () => {
    assert.match(errorsOf("temp x = 1;\ntemp x = 2;"), /already declared/);
    assert.match(errorsOf("proc f() -> void { }\nproc f(a: num) -> void { }"), /^$/);
});

test("hat blocks cannot be called, non-hats cannot be handlers", () => {
    const hat = `proc onthing(@opcode = "event_x", @hat) -> void { }\n`;
    assert.match(
        errorsOf(hat + "sprite s { proc g() -> void { onthing(); } }"),
        /hat block and can only be used as an event handler/,
    );
    assert.match(
        errorsOf("proc notahat() -> void { }\nsprite s { notahat() { } }"),
        /not a hat block/,
    );
    assert.match(errorsOf(hat + "sprite s { onthing() { } }"), /^$/);
});

test("handlers only at sprite top level", () => {
    const errors = errorsOf(`proc h(@opcode = "event_x", @hat) -> void { }\nh() { }`);
    assert.match(errors, /only appear at the top level of a sprite/);
});

test("unknown type annotations are reported", () => {
    assert.match(errorsOf("temp x: banana = 1;"), /Unknown type 'banana'/);
});

test("enum member access checks membership", () => {
    const decl = "enum Color { red, green }\n";
    assert.match(errorsOf(decl + "temp c: Color = Color.red;"), /^$/);
    assert.match(errorsOf(decl + "temp c: Color = Color.purple;"), /has no member 'purple'/);
});

test("'self' only valid inside a sprite", () => {
    assert.match(errorsOf("temp x = self.y;"), /'self' can only be used inside a sprite/);
});

test("@lower and @ret values are validated", () => {
    assert.match(
        errorsOf(`proc f(@lower = "bogus") -> void { }`),
        /@lower must be one of/,
    );
    assert.match(
        errorsOf(`proc f(@ret = "bogus") -> num { return 1; }`),
        /@ret must be one of/,
    );
    assert.match(errorsOf(`proc f(@ret = "vstack") -> num { return 1; }`), /^$/);
});

test("@lower = \"builds\" is rejected as unsupported", () => {
    assert.match(errorsOf(`proc f(@lower = "builds") -> num { return 1; }`), /not supported yet/);
});

test("list and dict returns on user procs are rejected", () => {
    assert.match(errorsOf("proc f() -> list<num> { return []; }"), /multi-size returns/);
    assert.match(errorsOf("proc f() -> dict<str, num> { return {}; }"), /multi-size returns/);
});

test("stdlib methods and namespaces resolve with types", () => {
    const result = compile(
        `
        temp xs = [1, 2, 3];
        proc f() -> void {
            temp has = xs.contains(2);
            temp n = xs.length();
            console.log("hi");
            wait(1);
        }
    `,
        { stdlib: true },
    );
    expectClean(result);
});

test("stdlib misuse: unknown members and non-methods", () => {
    assert.match(
        errorsOf(`proc f() -> void { console.bogus("x"); }`, { stdlib: true }),
        /Namespace 'console' has no member 'bogus'/,
    );
    assert.match(
        errorsOf(`temp n = 1;\nproc f() -> void { n.bogus(); }`, { stdlib: true }),
        /not a method of type 'num'/,
    );
});

test("for-loop destructuring width is checked", () => {
    const errors = errorsOf(
        `
        temp pairs = {"a": 1};
        proc f() -> void {
            for ((k, v, extra), pairs) { }
        }
    `,
        { stdlib: true },
    );
    assert.match(errors, /Cannot destructure/);
});

test("switch validates default placement and count", () => {
    assert.match(
        errorsOf(`
            proc f(x: num) -> void {
                switch (x) {
                    default { }
                    case (1) { }
                }
            }
        `),
        /'default' case not located at bottom/,
    );
    assert.match(
        errorsOf(`
            proc f(x: num) -> void {
                switch (x) {
                    default { }
                    default { }
                }
            }
        `),
        /2 or more 'default' cases/,
    );
});
