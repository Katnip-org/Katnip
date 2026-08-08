# Katnip Features

Status of every language and toolchain feature, tracked against the compiler pipeline:
**lexer → parser → semantic analyzer → IR → SB3 codegen**.

| Emoji | Meaning |
| :---: | --- |
| 🟢 | Done; reaches real Scratch blocks in a built `.sb3` |
| 🟡 | Partial; implemented at some stages, named per row |
| 🔴 | Not implemented, or implemented only far enough to type-check |

Last verified against `main` with 146 passing tests and a clean
`node packages/compiler/build/cli.js build examples/codegen.knip`.

---

## Pipeline

- 🟢 **Lexer**; hand-written state machine, operator trie for multi-character tokens, tracks line/column for every token.
- 🟢 **Parser**; Pratt parser with a binding-power table, recovers from syntax errors into error nodes so analysis still runs.
- 🟢 **Semantic analyzer**; two-pass (hoist, then walk), scoped symbol table, structured `InternalType` with unions, tuples, generics.
- 🟡 **IR generator**; lowers everything Scratch-shaped, with named gaps below (structs, slices, `**`, imports, `katnip_*` builtins).
- 🟡 **SB3 codegen**; emits blocks, variables, lists, procs, extensions, packs to `.sb3`; throws on any opcode missing slot metadata.

---

## Types

- 🟢 **Primitives**; `num`, `str`, `bool`, `void`, plus `any`.
- 🟢 **Collections**; `list<T>`, `dict<K, V>` as first-class annotated types.
- 🟢 **Tuple types**; `(num, num)`, checked structurally and used to size proc return frames.
- 🟢 **Union types**; `Target | str`, with assignability in both directions.
- 🟢 **Enums**; nominal, compared by name so two enums sharing a member never collide.
- 🟢 **Type inference**; every expression gets a type; annotations are optional on declarations with an initializer.
- 🟢 **Generic stdlib typevars**; `T`, `K`, `V` bind from receivers and arguments, so `zip`/`enumerate`/`list.contains` return concrete types.
- 🟡 **Structs**; nominal record types; fully analyzed, not lowered (see [Structs](#structs)).

---

## Declarations

- 🟢 **Variables**; `public`, `private`, and `temp` access modifiers, with or without a type annotation.
  - 🟢 Top-level variables become stage-owned globals, visible from every sprite.
  - 🟢 Sprite members shadowing a global are renamed `Sprite_name` at codegen, since Scratch cannot represent the collision.
  - 🟢 `temp` inside a proc becomes a mangled global; scope-less by design, so recursion still clobbers it.
- 🟢 **Procedures**; `proc name(params) -> Type { ... }`, with bodies lowered into `procedures_definition` blocks.
  - 🟢 Overloading by parameter list; dispatch resolved by argument types.
  - 🟢 Default parameter values.
  - 🟢 Named arguments; `motion.goTo(y = 0, x = 0)` routes by name, not position.
  - 🟢 Methods; a first parameter named `self` makes the proc callable as `receiver.method()`.
  - 🟢 Warp; on by default for user procs, `@warp` decorator overrides.
- 🟢 **Sprites**; `sprite Name { ... }` holding members, procs, and event handlers.
- 🟢 **Enums**; implicit members fold to the qualified `"Enum.member"`, explicit values are kept verbatim for sb3 fields and menus.
- 🟢 **Access control across files**; only `public` symbols cross a file boundary; imports are not re-exported.
- 🔴 **Stage block**; no `stage { ... }` declaration; stage state is implied by top-level variables.

---

## Statements and control flow

- 🟢 **`if` / `elif` / `else`**; lowers to nested `control_if_else`.
- 🟢 **`while`**; lowers to `control_while`, condition taken as-is.
- 🟢 **`do { } while ( )`**; lowered by emitting the body once ahead of the loop, so it always runs at least once; note the body is duplicated in the output.
- 🟢 **`for` over a counter**; `for (i, 4)` lowers to `control_for_each`.
- 🟢 **`for` over a list**; binds each element by index.
- 🟢 **`for` over a string**; binds each letter through `operator_letter_of`.
- 🟢 **`for` over a dict**; `for ((key, value), d)` walks the keys and values columns together.
- 🟢 **`for` over `range()`**; folded into the loop counter with constant folding on literal `start`/`stop`/`step`, never built as a list.
- 🟢 **`switch` / `case` / `default`**; lowers to an if/else chain; a case can hold several values.
  - 🔴 Fallthrough keyword; not designed or implemented.
  - 🔴 Exhaustiveness checking over enums.
- 🟢 **`return`**; scalar and tuple frames, followed by `control_stop`.
- 🟢 **Event handlers**; `events.onFlag() { }` and friends, gated by the analyzer to sprite top level.
- 🟡 **Statement placement errors**; handlers, imports, and switch placement are checked, but statements the IR cannot place outside a sprite are silently dropped rather than reported.
- 🟡 **`forever` / `repeat`**; IR node kinds and codegen exist, no source syntax reaches them yet.

---

## Expressions and operators

- 🟢 **Arithmetic**; `+`, `-`, `*`, `/`, `%`, and unary `-`.
- 🟢 **Comparison**; `==`, `<`, `>`.
- 🟢 **Logic**; `&&`, `||`, and unary `!`.
- 🟢 **Composed operators**; `<=`, `>=`, `^`, `!&`, `!|`, `!^` have no Scratch block, so they come from `@lower = "builds"` stdlib procs inlined as nested reporters at each use site.
- 🟢 **Boolean shape coercion**; round reporters entering a hexagonal slot are wrapped automatically, and literals become a comparison.
- 🟢 **Compound assignment**; `+=`, `-=`, `*=`, `/=`, `%=`, including through a list or dict index.
- 🟢 **String concatenation**; `+` on strings lowers to `operator_join`.
- 🟢 **Interpolated strings**; `f"{name} scored {score}"` folds to a right-nested `operator_join` chain.
- 🟢 **Enum member access**; folded to a compile-time constant.
- 🟢 **Namespace constants**; `math.pi` folds to its literal.
- 🔴 **Power**; the `**` operator parses and type-checks, but has no opcode and no `builds` proc, so the IR silently lowers it to an empty literal. Do not use it yet.
- 🔴 **Power assignment**; `**=` has the same gap.

---

## Collections

- 🟢 **List literals**; all-literal contents bake straight into the project file, anything needing blocks is rebuilt by a green-flag script.
- 🟢 **Dict literals**; backed by two parallel Scratch lists, `name_keys` and `name_vals`.
- 🟢 **List indexing and assignment**; `scores[1]`, `scores[2] = ...`, `paws[1] += 1`.
- 🟢 **Dict indexing and assignment**; reads resolve the key column, writes replace in place or append when the key is missing.
- 🟢 **String indexing**; `s[1]` lowers to `operator_letter_of`.
- 🟢 **List monitors**; `show()` and `hide()` toggle the project's list monitors.
- 🔴 **Lists and dicts declared inside a script or proc**; only top-level and sprite-level declarations are lowered.
- 🔴 **Slices**; `s[1:5:2]` parses and gets a naive type, no lowering.

---

## Procedures and the return ABI

- 🟢 **Return strategy planning**; Tarjan SCC over the resolved call graph decides each proc's ABI.
  - 🟢 `var` strategy; non-cyclic procs write dedicated return variables.
  - 🟢 `vstack` strategy; procs in a call cycle push onto a per-proc Scratch list, so recursion returns correct values.
  - 🟢 `@ret = "auto" | "var" | "vstack"`; explicit `var` on a cyclic proc is a hard error, because its failure mode is silently wrong values.
- 🟢 **Recursion**; verified end to end with `fib` in `examples/codegen.knip`.
- 🟢 **Argument reporter kinds**; `%s`, `%n`, and `%b` all emitted from the declared parameter types.
- 🟡 **Tuple returns**; the multi-slot frame is emitted, but a call site only reads the first element; no destructuring on the receiving side.
- 🔴 **List and dict returns**; explicitly rejected by the analyzer, since the frame width is not statically known.
- 🔴 **`@lower = "yields"` procs**; declared in the stdlib (`list.remove`, `console.input`) but the IR has no lowering for them.

---

## Decorators

- 🟢 `@opcode`; binds a proc to a raw Scratch opcode.
- 🟢 `@hat`; marks a proc usable only as an event handler; misuse is reported in both directions.
- 🟢 `@warp`; runs the proc without screen refresh.
- 🟢 `@lower`; one of `reporter`, `command`, `userproc`, `builds`; `yields` is accepted but unlowered.
- 🟢 `@operator`; binds a `builds` proc to a binary operator, so the IR routes that operator through it.
- 🟢 `@ret`; picks the return strategy.

---

## Modules

- 🟢 **Import resolution**; `import "./thing.knip";` and `import "../lib/thing.knip" as alias;`.
- 🟢 **Import graph walking**; each file read and parsed once; unresolvable paths and cycles are reported against the importing file.
- 🟢 **Host-supplied resolvers**; the CLI uses the filesystem, the editor uses open documents, so a browser playground can supply virtual files.
- 🟢 **Namespacing and visibility**; imported symbols live under a namespace, only `public` ones cross, and imports are never re-exported.
- 🔴 **Lowering imported code**; the IR walks only the entry file, so calling an imported proc type-checks and then fails codegen with `call to unknown proc`. Imports are analysis-only today.

---

## Structs

- 🟢 Parsed; fields with type annotations and/or defaults, `public` and `private`.
- 🟢 Analyzed; literal construction with defaults filled, missing and unknown fields reported, field reads and writes type-checked, struct-typed params and returns, struct lists with per-field column access, non-scalar fields and duplicate fields rejected.
- 🔴 Lowered; struct literals, field reads, and field writes all no-op in the IR. Nothing struct-shaped survives to sb3.

---

## Standard library

Bundled `.knip` declaration files, generated into the compiler at build time.

- 🟢 **`prelude`** (no namespace); `wait`, `stop`, `len`, `showVariable`, `hideVariable`, the `Key` and `StopType` enums, `true`/`false`, and the `builds` operator procs.
- 🟢 **`events`**; `onFlag`, `onKey`, `onClick`, `onBackdropSwitch`, `onGreaterThan`, `onBroadcast`, `broadcast`, `broadcastAndWait`; computed broadcast names supported.
- 🟢 **`motion`**; movement, turning, `goTo`/`glideTo` overloads, pointing, x/y, edge bounce, rotation style.
- 🟢 **`looks`**; say/think with both overloads, costumes, backdrops, size, graphic effects, show/hide, layers.
- 🟢 **`sensing`**; touching, colors, distance, ask/answer, keys, mouse, drag mode, loudness, timer, `sensing_of`, date parts, online, username.
- 🟢 **`pen`**; down, up, clear, hex color, color params, size; the extension is declared in the project automatically.
- 🟢 **`clone`**; `onStart`, `create`, `delete`.
- 🟡 **`list`**; `add`, `contains`, `length`, `clear`, `indexOf`, `show`, `hide` are 🟢; `remove` is 🔴 (yields), `merge` is 🔴 (`katnip_list_merge`).
- 🟡 **`math`**; `pi`, `e`, `tau` fold to literals 🟢; `pow` is a stub with an empty body 🔴.
- 🟡 **`str`**; `contains` is 🟢; the rest of the string surface is not written yet.
- 🔴 **`dict`**; `contains`, `length`, `keys`, `values`, `merge` all resolve to `katnip_*` opcodes with no codegen metadata.
- 🔴 **`console`**; `log`, `warn`, `error` are `katnip_*`; `input` is a yields proc.
- 🔴 **Casts and helpers**; `Num`, `Str`, `Bool`, `List`, `typeof`, `zip`, `enumerate`, `motion.getPosition`, and `range()` used as a value all type-check but have no codegen metadata; using one throws `no slot metadata`.

---

## Scratch project output

- 🟢 **Project structure**; stage plus one target per sprite, variables and lists declared on the right target, scripts laid out vertically.
- 🟢 **Custom procs**; proccode, argument ids, argument defaults, and warp mutation all emitted; signatures registered up front so forward calls resolve.
- 🟢 **Input shapes**; shadow primitives per slot kind (number, whole, positive, angle, color, string), menu shadows with dynamic-reporter overlay, broadcast primitives registered on the stage.
- 🟢 **Extension declaration**; opcode prefixes are detected and added to the project's extension list; `pen` is the only one with stdlib bindings today.
- 🟢 **Packing**; `fflate` zips `project.json` plus the default costume into a `.sb3` that loads in Scratch and TurboWarp.
- 🔴 **Assets**; every sprite gets the same default costume; no costume, backdrop, or sound import.
- 🔴 **Monitor layout**; monitors can be shown and hidden, but not positioned or styled.
- 🔴 **Comments in output**; nothing is written to the sb3 comment map.

---

## Comments

- 🟢 **Lexing**; six variants, single-line and multi-line, each in expanded, collapsed, and ignored forms; ignored ones are dropped at the lexer.
- 🔴 **Attaching to the AST**; `NodeBase.comment` exists but the parser discards comment tokens, so no comment ever reaches a node or the sb3 output.

---

## Tooling

- 🟢 **CLI**; `katnip tokenize`, `parse`, `check`, `build`, `help`.
- 🟢 **Error reporting**; source spans with line and column, colorized output, multiple errors per run; analysis continues past syntax errors so semantic errors surface alongside them.
- 🟢 **VS Code extension**; live diagnostics on type or on save with a configurable debounce, syntax highlighting, language configuration, and a `Katnip: Build .sb3` command.
- 🟢 **Tests**; 146 `node --test` cases across lexer, parser, semantic, callgraph, imports, IR, and codegen.
- 🟢 **Public API**; `checkSource` and `compileToSb3` exported for embedding, with a pluggable import resolver.
- 🔴 **Language server**; the extension shells the compiler directly; no LSP, no completion, hover, or go-to-definition.
- 🔴 **Formatter**.
- 🔴 **Source maps**; no mapping from a Scratch block back to a `.knip` line.

---

## Nearest gaps, in rough order

1. Lower imported procs and variables, so `import` stops failing at codegen.
2. Give the `katnip_*` builtins real lowerings; casts, `console`, `typeof`, and the dict methods are the widest hole.
3. Lower structs; the analyzer is already complete for them.
4. Implement `**`, which today lowers silently to an empty literal.
5. Lower `@lower = "yields"` procs, unblocking `list.remove` and `console.input`.
6. Read tuple returns at a call site; the ABI already carries the extra slots.
7. Attach comments to the AST and emit them into the sb3 comment map.
</content>
</invoke>
