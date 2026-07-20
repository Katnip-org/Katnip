import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean, formatErrors } from "./helpers.js";

/** Compiles an entry at /proj/main.knip against a virtual file tree, returning joined errors. */
function errorsOf(source: string, files: Record<string, string> = {}): string {
    return formatErrors(compile(source, { files }).reporter);
}

const THING = `
    public proc double(n: num) -> num { return n * 2; }
    public answer: num = 42;
    private proc secret() -> num { return 1; }
`;

test("sibling import exposes public members", () => {
    expectClean(
        compile(
            `
            import "./thing.knip";
            proc main() -> void { temp x: num = thing.double(2); }
        `,
            { files: { "/proj/thing.knip": THING } },
        ),
    );
});

test("parent-relative import resolves", () => {
    const files = {
        "/proj/sub/otherthing.knip": THING,
        "/proj/nested/entry.knip": "",
    };
    // main.knip lives in /proj, so ../proj/sub is the same as ./sub
    expectClean(
        compile(
            `
            import "../proj/sub/otherthing.knip";
            proc main() -> void { temp x: num = otherthing.double(2); }
        `,
            { files },
        ),
    );
});

test("import binds under its alias", () => {
    const source = `
        import "./thing.knip" as util;
        proc main() -> void { temp x: num = util.double(2); }
    `;
    expectClean(compile(source, { files: { "/proj/thing.knip": THING } }));
    assert.match(errorsOf(source.replace("util.double", "thing.double"), { "/proj/thing.knip": THING }), /'thing' is not defined/);
});

test("public constants are importable", () => {
    expectClean(
        compile(`import "./thing.knip";\nproc main() -> void { temp x: num = thing.answer; }`, {
            files: { "/proj/thing.knip": THING },
        }),
    );
});

test("private members do not cross the file boundary", () => {
    assert.match(
        errorsOf(`import "./thing.knip";\nproc main() -> void { temp x: num = thing.secret(); }`, {
            "/proj/thing.knip": THING,
        }),
        /has no member 'secret'/,
    );
});

test("imports are not re-exported", () => {
    assert.match(
        errorsOf(`import "./a.knip";\nproc main() -> void { temp x: num = a.thing.double(2); }`, {
            "/proj/a.knip": `import "./thing.knip";\npublic proc f() -> void {}`,
            "/proj/thing.knip": THING,
        }),
        /has no member 'thing'/,
    );
});

test("a module can use its own imports", () => {
    expectClean(
        compile(`import "./a.knip";\nproc main() -> void { temp x: num = a.quad(2); }`, {
            files: {
                "/proj/a.knip": `import "./thing.knip";\npublic proc quad(n: num) -> num { return thing.double(thing.double(n)); }`,
                "/proj/thing.knip": THING,
            },
        }),
    );
});

test("an importing file's symbols are invisible inside the module", () => {
    assert.match(
        errorsOf(`import "./a.knip";\npublic temp shared: num = 1;`, {
            "/proj/a.knip": `public proc f() -> num { return shared; }`,
        }),
        /has errors/,
    );
});

test("unresolvable specifier is reported", () => {
    assert.match(errorsOf(`import "./nope.knip";`), /Cannot resolve module '\.\/nope\.knip'/);
});

test("import cycles are reported, not hung", () => {
    assert.match(
        errorsOf(`import "./a.knip";`, {
            "/proj/a.knip": `import "./b.knip";\npublic proc f() -> void {}`,
            "/proj/b.knip": `import "./a.knip";\npublic proc g() -> void {}`,
        }),
        /Circular import cycle through '\.\/a\.knip'/,
    );
});

test("the same module imported twice is analyzed once", () => {
    expectClean(
        compile(
            `
            import "./thing.knip";
            import "./thing.knip" as also;
            proc main() -> void { temp x: num = thing.double(also.answer); }
        `,
            { files: { "/proj/thing.knip": THING } },
        ),
    );
});

test("imports are rejected outside the top level", () => {
    assert.match(
        errorsOf(`sprite Cat { import "./thing.knip"; }`, { "/proj/thing.knip": THING }),
        /only allowed at the top level/,
    );
});
