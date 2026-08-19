# Katnip

A typed programming language that compiles to Scratch. You write `.knip` files, run the
compiler, and get a `.sb3` project that opens in [Scratch](https://scratch.mit.edu) or [MistWarp](https://warp.mistium.com/editor) or [TurboWarp](https://turbowarp.org) and runs like any other project.

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

That builds into a real Scratch project: a stage variable `score`, a custom block `award`,
a green-flag script on the Cat sprite, and the pen extension enabled.

## Install

```bash
npm install -g @katnip-org/compiler
katnip build hello.knip
```

Node.js 20+. See the [documentation](https://docs.katnip.org/) to get started, or
[`@katnip-org/compiler`](https://www.npmjs.com/package/@katnip-org/compiler) for the CLI
and library reference.

## Build from source

```bash
pnpm install
pnpm build
node packages/compiler/build/cli.js help
```

Run the test suite (~180 tests across lexer, parser, semantic, IR, and codegen):

```bash
pnpm test
```

End-to-end example covering everything the compiler lowers today:

```bash
node packages/compiler/build/cli.js build examples/codegen.knip
```

## VS Code extension

Live diagnostics, highlighting, and autocomplete for `.knip` files. Build the `.vsix`
(rebuilds and vendors the compiler, then packages):

```bash
pnpm --filter katnip-vscode run package
code --install-extension packages/vscode/katnip-vscode-0.0.14.vsix --force
```

Run `Developer: Reload Window`, then open any `.knip` file.

## Repository layout

| Path | What's in it |
| --- | --- |
| `packages/compiler` | The compiler: lexer, parser, semantic analyzer, IR, SB3 codegen, CLI |
| `packages/compiler/stdlib` | The standard library, written in Katnip itself |
| `packages/vscode` | VS Code extension |
| `examples` | Sample `.knip` programs |
| `features.md` | Per-feature status against the pipeline |
| `CHANGELOG.md` | Version history, from Scratch interpreter to compiler |

## How it works

    source → lexer → parser → semantic analysis → IR → SB3 → .sb3

The frontend type-checks, the IR reconciles Katnip's semantics with what Scratch can
actually express (tuple returns, ranged `for`, `switch` -- none of which exist as blocks),
and the SB3 generator emits the block JSON that gets zipped into a `.sb3`.

Not yet lowered to blocks: structs, slices, `**`, and some `katnip_*` builtins.
[`features.md`](features.md) tracks the gaps.

## License

Apache-2.0 -- see [LICENSE](LICENSE) and [NOTICE](NOTICE).
