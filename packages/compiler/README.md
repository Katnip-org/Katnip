# @katnip-org/compiler

Compiler and type-checker for the **Katnip** language (`.knip`) — a typed language that
compiles to Scratch. Source text in, a runnable `.sb3` out.

    source → lexer → parser → semantic analysis → IR → SB3 → .sb3

## Install

```bash
npm install -g @katnip-org/compiler
```

Requires Node.js 20+. Or run it without installing:

```bash
npx @katnip-org/compiler build path/to/file.knip
```

## Quick start

`hello.knip`:

```katnip
public score: num = 0;

proc award(points: num) -> void {
    score += points;
}

sprite Cat {
    events.onFlag() {
        pen.down();
        for (side, 4) {
            motion.forward(100);
            motion.turn(90);
            award(10);
        }
        pen.up();
        looks.say(f"Scored {score}!", 2);
    }
}
```

```bash
katnip check hello.knip     # type-check
katnip build hello.knip     # writes hello.sb3
```

Drag the `.sb3` onto [MistWarp](https://warp.mistium.com/editor) or [TurboWarp](https://turbowarp.org) or [scratch.mit.edu](https://scratch.mit.edu) and hit the flag.

## Commands

| Command | What it does |
| --- | --- |
| `katnip check <source>` | Lex, parse, and analyze; reports errors and warnings |
| `katnip build <source> [output]` | Compile to `.sb3` (defaults to the source path with a `.sb3` extension). `--compression 0-9` sets the zip level |
| `katnip decompile <source> [output]` | Turn a `.sb3` into `.knip` source (defaults to the source path with a `.knip` extension) |
| `katnip lower <source> [output]` | Emit the IR as JSON (stdout by default) |
| `katnip parse <source> <output.json>` | Write the AST as JSON |
| `katnip tokenize <source> <output.json>` | Write the token stream as JSON |
| `katnip help` | List commands |

## Library

```js
import { checkSource, compileToIR, compileToSb3, decompileSb3 } from "@katnip-org/compiler";
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("hello.knip", "utf8");

const errors = checkSource(source);          // readonly KatnipError[]

const { errors: buildErrors, sb3 } = compileToSb3(source);
if (sb3) writeFileSync("hello.sb3", sb3);    // sb3 is a Uint8Array

const knip = decompileSb3(readFileSync("hello.sb3"));   // .knip source
```

`sb3` (and `ir` from `compileToIR`) is absent when `errors` holds anything of severity
`"error"`; warnings do not stop a build.

Both accept `{ path, resolve }` to enable `import`s — `resolve(specifier, fromPath)`
returns `{ path, source }` or `null`. Pass `readAsset(specifier, fromPath)`, returning bytes or
`null`, to enable costumes, sounds and `import()` data files, and `compression` (0-9) to set
the zip level.

## What's supported

The pipeline is complete end to end: variables, procedures with overloads and defaults,
sprites and events, costumes and sounds, clones, lists and dicts, CSV and JSON data files,
enums, structs, imports, all the loop and branch forms, a decompiler, and a
standard library (`motion`, `looks`, `sensing`, `pen`, `events`, `clone`, `math`, `str`,
`list`, `dict`, `console`) written in Katnip itself.

Not yet lowered to blocks: `list.remove`, whole-list values, and the remaining `katnip_*`
builtins. They stop the build with an error. See
[`features.md`](https://github.com/Katnip-org/Katnip/blob/main/features.md) for the
per-feature status.

## Links

* Documentation: <https://docs.katnip.org>
* Website: <https://katnip.org>
* Source and issues: <https://github.com/Katnip-org/Katnip>

## License

Apache-2.0
