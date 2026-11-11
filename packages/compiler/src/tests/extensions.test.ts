import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean, formatErrors } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import { SB3Generator } from "../codegen/SB3Generator.js";
import { isBlock, type Sb3Project } from "../codegen/SB3TypeDefs.js";

function build(source: string): Sb3Project {
    const result = compile(source, { stdlib: true });
    expectClean(result);
    return new SB3Generator().generate(new IRGenerator(result.analyzer).generate(result.ast));
}

const errors = (source: string): string => {
    const result = compile(source, { stdlib: true });
    return result.reporter.hasErrors() ? formatErrors(result.reporter) : "";
};

/** One websocket-shaped block, declared, used by a sprite. */
const ws = `
extension websocket = "https://extensions.turbowarp.org/websocket.js";
proc connect(@opcode = "websocket_connect", url: str) -> void {}
sprite Cat {
    events.onFlag() { connect("wss://example.com"); }
}
`;

test("a declared extension is listed in extensions with its URL", () => {
    const project = build(ws);
    assert.deepEqual(project.extensions, ["websocket"]);
    assert.deepEqual(project.extensionURLs, { websocket: "https://extensions.turbowarp.org/websocket.js" });
});

test("extensionURLs is left out entirely when nothing needs fetching", () => {
    const project = build(`sprite Cat { events.onFlag() { pen.down(); } }`);
    assert.deepEqual(project.extensions, ["pen"]);
    assert.equal(project.extensionURLs, undefined);
});

test("Scratch's own extensions need no declaration", () => {
    const project = build(`sprite Cat { events.onFlag() { pen.setSize(2); } }`);
    assert.deepEqual(project.extensions, ["pen"], "still listed in project.json, just not declared");
});

test("a declaration without a URL is for an extension the VM already ships", () => {
    const project = build(`
        extension pen;
        sprite Cat { events.onFlag() { pen.down(); } }
    `);
    assert.deepEqual(project.extensions, ["pen"]);
    assert.equal(project.extensionURLs, undefined, "a builtin has nothing to fetch");
});

test("an undeclared prefix is an error naming the extension to declare", () => {
    const message = errors(`
        proc poke(@opcode = "pokehub_send", text: str) -> void {}
        sprite Cat { events.onFlag() { poke("hi"); } }
    `);
    assert.match(message, /pokehub_send/);
    assert.match(message, /extension pokehub = "<url>"/);
});

test("declaring one extension does not licence another", () => {
    const message = errors(`
        extension websocket = "https://example.com/ws.js";
        proc poke(@opcode = "pokehub_send", text: str) -> void {}
        sprite Cat { events.onFlag() { poke("hi"); } }
    `);
    assert.match(message, /pokehub/);
});

test("a URL that is not http(s) is rejected, because a local path dies with the project", () => {
    const message = errors(`
        extension websocket = "./ws.js";
        sprite Cat { events.onFlag() { looks.say("hi"); } }
    `);
    assert.match(message, /http\(s\)/);
});

test("the same prefix cannot point at two extensions", () => {
    const message = errors(`
        extension websocket = "https://a.example/ws.js";
        extension websocket = "https://b.example/ws.js";
        sprite Cat { events.onFlag() { looks.say("hi"); } }
    `);
    assert.match(message, /already declared/);
});

test("repeating a declaration unchanged is allowed", () => {
    expectClean(
        compile(
            `
        extension websocket = "https://a.example/ws.js";
        sprite Cat { events.onFlag() { looks.say("hi"); } }
    `,
            { stdlib: true },
        ),
    );
});

test("'extension' still works as an ordinary name", () => {
    const project = build(`
        private extension: str = "plain";
        sprite Cat { events.onFlag() { looks.say(extension); } }
    `);
    assert.deepEqual(project.extensions, []);
});

test("an imported file's declaration counts for the whole project", () => {
    const result = compile(
        `import "websocket.knip" as websocket;
         sprite Cat { events.onFlag() { websocket.connect("wss://x"); } }`,
        {
            stdlib: true,
            files: {
                "/proj/websocket.knip": `
                    extension websocket = "https://extensions.turbowarp.org/websocket.js";
                    public proc connect(@opcode = "websocket_connect", url: str) -> void {}
                `,
            },
        },
    );
    expectClean(result);
    const project = new SB3Generator().generate(new IRGenerator(result.analyzer).generate(result.ast));
    assert.deepEqual(project.extensions, ["websocket"]);
    assert.deepEqual(project.extensionURLs, { websocket: "https://extensions.turbowarp.org/websocket.js" });
});

test("a reporter extension block is as tall as Scratch's own when the stack is laid out", () => {
    // Two scripts: a custom reporter in the first must not make the second overlap it.
    const project = build(`
        extension websocket = "https://example.com/ws.js";
        proc last(@opcode = "websocket_lastMessage") -> str { return ""; }
        sprite Cat {
            events.onFlag() { looks.say(last()); }
            events.onFlag() { looks.say("second script"); }
        }
    `);
    const ys = Object.values(project.targets[1]!.blocks)
        .filter(isBlock)
        .filter((b) => b.topLevel)
        .map((b) => b.y!)
        .sort((a, b) => a - b);
    assert.equal(new Set(ys).size, ys.length, "two top-level scripts stacked on the same row would overlap");
});
