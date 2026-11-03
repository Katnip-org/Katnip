import { test } from "node:test";
import assert from "node:assert/strict";
import { getHover, getMemberCompletions } from "../index.js";

const source = `public score: num = 0;
proc award(points: num, bonus: num = 1) -> void { score += points; }
sprite Cat {
    private config: dict<str, num> = {"a": 1};
    events.onFlag() {
        award(score);
        for (key, config.keys()) { looks.say(key, 1); }
    }
}`;

function at(line: number, word: string, offset = 0) {
    const column = source.split("\n")[line - 1]!.indexOf(word) + offset + 1;
    return getHover(source, line, column);
}

test("hover shows a call's signature and a value's type", () => {
    assert.equal(at(6, "award"), "proc award(points: num, bonus: num = ...) -> void");
    assert.equal(at(6, "score"), "score: num");
    assert.equal(at(7, "keys"), "proc keys() -> list<K>");
    assert.equal(at(7, "config"), "config: dict<str: num>");
    assert.match(at(7, "say")!, /^proc say\(/);
    assert.equal(at(7, "key,", 0), null);
    assert.equal(at(7, "looks"), null);
});

test("hover finds nothing off a name, or in unparseable source", () => {
    assert.equal(getHover(source, 6, 1), null);
    assert.equal(getHover("sprite {{{", 1, 1), null);
});

function members(body: string) {
    const lines = `public d: dict<str, num> = {"a": 1};
enum Color { RED, BLUE }
struct P { x: num, y: num }
public ps: list<P> = [];
public p: P = P(x = 1, y = 2);
public s: str = "a";
sprite Cat {
    events.onFlag() {
        ${body}
        looks.say("after", 1);
    }
}`;
    const column = `        ${body}`.indexOf("|") + 1;
    const names = getMemberCompletions(lines.replace("|", ""), 9, column);
    return names?.map((m) => m.name) ?? null;
}

test("member completion lists namespaces, enums, methods and fields while the line is unfinished", () => {
    assert.ok(members("events.|")!.includes("onFlag"));
    assert.ok(members("events.onF|")!.includes("onFlag"));
    assert.deepEqual(members("Color.|"), ["RED", "BLUE"]);
    assert.deepEqual(members("d.|")!.sort(), ["contains", "keys", "length", "merge", "values"]);
    assert.ok(members("looks.say(d.|")!.includes("keys"));
    assert.ok(members("d.keys().|")!.includes("add"));
    assert.deepEqual(members("p.|"), ["x", "y"]);
    assert.ok(members("ps.|")!.includes("x") && members("ps.|")!.includes("add"));
    assert.ok(members("sensing.TouchTarget.|")!.length > 0);
    assert.equal(members("loo|"), null);
});
