# Katnip Features

Status of every language and toolchain feature, tracked against the compiler pipeline:
**lexer → parser → semantic analyzer → IR → SB3 codegen**.

| Emoji | Meaning |
| :---: | --- |
| 🟢 | Done; reaches real Scratch blocks in a built `.sb3` |
| 🟡 | Partial; implemented at some stages, named per row |
| 🔴 | Not implemented, or implemented only far enough to type-check |

Last verified against `main` (compiler `0.1.25`, VS Code extension `0.1.25`) with a green
`node --test` run of 298 cases, 295 passing and 3 `todo` cases pinning the gaps below, and a clean `katnip build` of `examples/all.knip`,
`examples/assets.knip` and `examples/codegen.knip`.

The practical "what do I write instead" version is [Known gaps](https://docs.katnip.org/reference/known-gaps/).

---

## Pipeline

* 🟢 **Lexer**; hand-written state machine, operator trie for multi-character tokens,
  tracks line/column for every token.
  * 🟢 Interpolation nesting; a stack of string frames, so an interpolation may contain a
    string of either quote style, or another f-string.
  * 🟢 Unterminated string literals are reported instead of running off the end of the file.
* 🟢 **Parser**; Pratt parser with a binding-power table, recovers from syntax errors into
  error nodes so analysis still runs. Comments between tokens of a multi-line statement are
  skipped.
* 🟢 **Semantic analyzer**; two-pass (hoist, then walk), scoped symbol table, structured
  `InternalType` with unions, tuples, generics.
* 🟡 **IR generator**; lowers everything Scratch-shaped, with named gaps below, and reports anything it has no lowering for rather than dropping it.
* 🟡 **SB3 codegen**; emits blocks, variables, lists, procs, extensions, packs to `.sb3`;
  throws on any opcode missing slot metadata.

## Types

* 🟢 **Primitives**; `num`, `str`, `bool`, `void`, plus `any`.
* 🟢 **Collections**; `list<T>`, `dict<K, V>` as first-class annotated types.
* 🟢 **Tuple types**; `(num, num)`, checked structurally and used to size proc return
  frames.
* 🟢 **Union types**; `Target | str`, with assignability in both directions.
* 🟢 **Enums**; nominal, compared by name so two enums sharing a member never collide.
* 🟢 **Enum literal coercion**; a *literal* whose value is one of an enum's member values
  is assignable to that enum, so `pen.setAttr("color", 10)` and
  `pen.setAttr(pen.ColorParam.COLOR, 10)` compile to the same blocks. The rule lives in
  `isAssignable`, so it covers arguments, initializers, assignments, returns, struct
  fields, list and dict elements, and `case` labels alike. A literal that misses is
  rejected with the enum's member list and a did-you-mean.
  * 🔴 A **non-literal** of the backing type; a variable, a call, a concatenation, is not
    assignable, and there is no `Enum(x)` cast to force one; the diagnostic points at the
    member form instead. See [Known gaps](https://docs.katnip.org/reference/known-gaps/#no-cast-to-an-enum).
* 🟢 **Type inference**; every expression gets a type; annotations are optional on
  declarations with an initializer. Mixed list and dict literals infer a union.
* 🟢 **Generic stdlib typevars**; `T`, `K`, `V` bind from receivers and arguments, so
  `zip`/`enumerate`/`list.contains` return concrete types.
* 🟢 **Structs**; nominal record types, lowered to one column per field.

## Declarations

* 🟢 **Variables**; `public` and `private` access modifiers, with or without a type
  annotation.
  * 🟢 The modifier picks the owner, wherever the declaration is written: `public` is
    stage-owned and visible to every sprite, `private` belongs to whatever encloses it. Two
    sprites claiming one `public` name is an error.
  * 🟢 Sprite members shadowing a global are renamed `Sprite_name` at codegen, since Scratch
    cannot represent the collision.
  * 🟢 A variable declared inside a proc becomes a mangled global; scope-less by design, so
    recursion still clobbers it.
* 🟢 **Procedures**; `proc name(params) -> Type { ... }`, with bodies lowered into
  `procedures_definition` blocks.
  * 🟢 Overloading by parameter list; dispatch resolved by argument types. Two overloads
    with the same parameter types are a redeclaration error.
  * 🟢 Parameters are read-only; assigning to one (or to a struct parameter's field) is an
    error.
  * 🟢 Default parameter values.
  * 🟢 Named arguments; `motion.goTo(y = 0, x = 0)` routes by name, not position.
  * 🟢 Methods; a first parameter named `self` makes the proc callable as
    `receiver.method()`.
  * 🟢 Warp; on by default for user procs, `@warp` decorator overrides.
* 🟢 **Sprites**; `sprite Name { ... }` holding members, procs, and event handlers.
* 🟢 **Enums**; implicit members fold to the qualified `"Enum.member"`, explicit values are
  kept verbatim for sb3 fields and menus. A coerced literal folds to the identical value,
  so it takes the same lowering path as the member reference.
  * 🟢 Enums declared inside a namespace; `motion.RotationStyle.LEFT_RIGHT` resolves and
    folds; the enum stays out of global scope, so the bare `RotationStyle` is still
    undefined.
* 🟢 **Access control across files**; only `public` symbols cross a file boundary; imports
  are not re-exported.
* 🟢 **Stage block**; `stage { ... }` fills in the stage target: costumes, variables, procs
  and handlers all land on the stage. `sprite stage { }` is a parse error.
* 🟢 **Asset declarations**; `costume "./file.svg" as name;` and `sound "./file.wav";` at a
  sprite's top level. The name defaults to the file stem; the extension is checked against
  Scratch's costume and sound formats; a missing file is reported against its path.

## Statements and control flow

* 🟢 **`if` / `elif` / `else`**; lowers to nested `control_if_else`.
* 🟢 **`while`**; lowers to `control_while`, condition taken as-is.
* 🟢 **`do { } while ( )`**; lowered by emitting the body once ahead of the loop, so it
  always runs at least once; note the body is duplicated in the output.
* 🟢 **`for` over a counter**; `for (i, 4)` lowers to `control_for_each`.
* 🟢 **`for` over a list**; binds each element by index.
* 🟢 **`for` over a string**; binds each letter through `operator_letter_of`.
* 🟢 **`for` over a dict**; `for ((key, value), d)` walks the keys and values columns
  together.
* 🟢 **`for` over `range()`**; folded into the loop counter with constant folding on
  literal `start`/`stop`/`step`, never built as a list. 1-based and stop-inclusive like
  Scratch's own counter, so `range(5)` yields `1 2 3 4 5`.
* 🟢 **`for` over `zip()` / `enumerate()`**; walked by index instead of built:
  `for ((a, b), zip(l1, l2))` reads both lists under one counter running
  `l1.length()` times; `for ((i, v), enumerate(l))` reuses the 1-based counter as the
  index, so it costs no extra block.
  * 🟡 A second list shorter than the first reads empty past its end, rather than the loop
    stopping early.
* 🟢 **`switch` / `case` / `default`**; lowers to an if/else chain; a case can hold several
  values.
  * 🟢 Case labels are checked against the switch value's type, so a label on an
    enum-typed value must be a member or a literal that coerces to one.
  * 🔴 Fallthrough keyword; not designed or implemented.
  * 🔴 Exhaustiveness checking over enums; a switch missing members is still not reported.
* 🟢 **`return`**; scalar and tuple frames, followed by `control_stop`.
* 🟢 **Event handlers**; `events.onFlag() { }` and friends, gated by the analyzer to sprite
  top level.
* 🟢 **Statement placement errors**; handlers, imports, and switch placement are checked,
  and a statement outside a handler stops the build.
* 🟢 **`forever`**; lowers to `control_forever`.
* 🟢 **`repeat`**; lowers to `control_repeat`; the count must be a `num`.

## Expressions and operators

* 🟢 **Decimal literals**; a whole number written with a point keeps it, so
  `math.random(0.0, 1.0)` stays fractional in Scratch, where `math.random(0, 1)` picks 0 or 1.
* 🟢 **Arithmetic**; `+`, `-`, `*`, `/`, `%`, and unary `-`.
* 🟢 **Comparison**; `==`, `!=`, `<`, `>`.
* 🟢 **Logic**; `&&`, `||`, and unary `!`, all requiring `bool` operands.
* 🟢 **Composed operators**; `!=`, `<=`, `>=`, `^`, `!&`, `!|`, `!^` have no Scratch block, so
  they come from `@lower = "builds"` stdlib procs inlined as nested reporters at each use
  site.
* 🟢 **Boolean shape coercion**; round reporters entering a hexagonal slot are wrapped
  automatically, and literals become a comparison.
* 🟢 **Compound assignment**; `+=`, `-=`, `*=`, `/=`, `%=`, including through a list or
  dict index.
* 🟢 **String concatenation**; `+` on strings lowers to `operator_join`.
* 🟢 **Interpolated strings**; `f"{name} scored {score}"` folds to a right-nested
  `operator_join` chain.
* 🟢 **Enum member access**; folded to a compile-time constant.
* 🟢 **Namespace constants**; `math.pi` folds to its literal.
* 🟢 **Power**; `**` and `**=` fold literals, and write out exponents 0 to 3 and 0.5 as plain
  blocks. Anything else calls `math.pow`, a warp proc added to the project only if used, which is
  exact for whole exponents.
* 🟢 **Several calls in one statement**; `f(1) + f(2)` keeps both results. A result held across
  a recursive call in the same statement can still be overwritten.

## Collections

* 🟢 **List literals**; all-literal contents bake straight into the project file, anything
  needing blocks is rebuilt by a green-flag script.
* 🟢 **Dict literals**; backed by two parallel Scratch lists, `name_keys` and `name_vals`.
* 🟢 **List indexing and assignment**; `scores[1]`, `scores[2] = ...`, `paws[1] += 1`.
* 🟢 **Dict indexing and assignment**; reads resolve the key column, writes replace in
  place or append when the key is missing.
* 🟢 **String indexing**; `s[1]` lowers to `operator_letter_of`.
* 🟢 **List monitors**; `show()` and `hide()` toggle the project's list monitors.
* 🟢 **Lists and dicts declared inside a script or proc**; hoisted and refilled on every
  run, rather than baked once like a top-level list.
* 🟢 **Data files**; `import("./file.csv")` and `import("./file.json")` become a list or dict
  literal at compile time. A CSV must be one row or one column, and JSON must be flat.
* 🟢 **Slices**; `s[1:5:2]` on a `str` or `list`, 1-based and stop-inclusive. A literal string
  slice of up to 8 letters becomes `letter of` and `join` blocks. List slices can
  initialize or replace a list, be walked by `for`, or take a method call.
* 🔴 **Whole-list values**; `a = b`, `private c = a` and `a + b` stop the build.

## Procedures and the return ABI

* 🟢 **Return strategy planning**; Tarjan SCC over the resolved call graph decides each
  proc's ABI.
  * 🟢 `var` strategy; non-cyclic procs write dedicated return variables.
  * 🟢 `vstack` strategy; procs in a call cycle push onto a per-proc Scratch list, so
    recursion returns correct values.
  * 🟢 `@ret = "auto" | "var" | "vstack"`; explicit `var` on a cyclic proc is a hard error,
    because its failure mode is silently wrong values.
* 🟢 **Recursion**; verified end to end with `fib` in `examples/codegen.knip`.
* 🟢 **Argument reporter kinds**; `%s`, `%n`, and `%b` all emitted from the declared
  parameter types.
* 🟢 **Tuple returns**; `(a, b) = f();` and `(a, b) = (b, a);` assign plain variables, on both
  return strategies.
* 🔴 **Tuple values**; storing a tuple in a variable or list, or reading one without a pattern,
  stops the build.
* 🔴 **List and dict returns**; explicitly rejected by the analyzer, since the frame width
  is not statically known.
* 🔴 **`@lower = "yields"` procs**; declared in the stdlib (`list.remove`,
  `console.input`) but the IR has no lowering for them.

## Decorators

* 🟢 `@opcode`; binds a proc to a raw Scratch opcode.
* 🟢 `@hat`; marks a proc usable only as an event handler; misuse is reported in both
  directions.
* 🟢 `@warp`; runs the proc without screen refresh.
* 🟢 `@lower`; one of `reporter`, `command`, `userproc`, `builds`; `yields` is accepted but
  unlowered.
* 🟢 `@proccode`; sets a user proc's Scratch custom-block label. One `%name` (or bare
  `%s`/`%n`/`%b`) placeholder per parameter, in declaration order; the declared parameter
  type picks the final spec. Checked, a wrong count or a reordered placeholder is an error.
* 🟢 `@operator`; binds a `builds` proc to a binary operator, so the IR routes that operator
  through it.
* 🟢 `@ret`; picks the return strategy.
* 🔴 `@doc`, `@constants`; parse, and nothing reads them.

## Modules

* 🟢 **Import resolution**; `import "./thing.knip";` and `import "../lib/thing.knip" as
  alias;`.
* 🟢 **Import graph walking**; each file read and parsed once; unresolvable paths and
  cycles are reported against the importing file.
* 🟢 **Host-supplied resolvers**; the CLI uses the filesystem, the editor uses open
  documents, so a browser playground can supply virtual files.
* 🟢 **Namespacing and visibility**; imported symbols live under a namespace, only `public`
  ones cross, and imports are never re-exported.
* 🟢 **Lowering imported code**; an imported proc is lowered into every target that calls
  it, transitively, and an imported value with a literal initializer folds at the use site.
* 🔴 **Imported module state**; mutable state declared in an imported module does not cross.
  Reading an imported list, or a value with no literal initializer, is a check error (*only
  members with a literal initializer are supported*). A proc that touches its own module's
  variable fails codegen with `undeclared variable` for any file importing that module, even
  if the proc is never called. Writing to an imported value stops the build.

## Structs

* 🟢 Parsed; fields with type annotations and/or defaults, `public` and `private`.
* 🟢 Analyzed; literal construction with defaults filled, missing and unknown fields
  reported, field reads and writes type-checked, struct-typed params and returns, struct
  lists with per-field column access, non-scalar fields and duplicate fields rejected.
* 🟢 Lowered; one variable per field for a lone struct, one parallel list per field for a
  `list<Struct>`. Literals, field reads and writes, whole-struct assignment, element reads
  and writes, `add`/`length`/`clear`/`show`/`hide`, `for` over a struct list, struct params
  (one input per field) and struct returns (one slot per field).
* 🔴 A whole struct as one value, `contains`/`indexOf`/`remove`/`merge` on a struct list, and
  structs from imported modules fail the build.

## Standard library

Bundled `.knip` declaration files, generated into the compiler at build time.

Menu parameters are typed by the enum alone where the Scratch menu is a closed set
(`ColorParam`, `RotationStyle`, `GraphicEffect`, `LayerPosition`, `LayerDirection`,
`NumberName`, `DragMode`, `TimeUnit`, `GreaterThanProperty`, `Key`), so a bare literal is
checked against the members. Six menus also list sprite, costume, or backdrop names, which
the compiler cannot enumerate, `Target`, `TouchTarget`, `DistanceTarget`, `ObjectTarget`,
`CloneTarget` and `Backdrop` keep an explicit `| str` arm for those, and are not checked.

* 🟢 **`prelude`** (no namespace); `wait`, `stop`, `len`, `showVariable`, `hideVariable`,
  the `Key` and `StopType` enums, `true`/`false`, and the `builds` operator procs.
* 🟢 **`events`**; `onFlag`, `onKey`, `onClick`, `onBackdropSwitch`, `onGreaterThan`,
  `onBroadcast`, `broadcast`, `broadcastAndWait`; computed broadcast names supported.
* 🟢 **`motion`**; movement, turning, `goTo`/`glideTo` overloads, pointing, x/y, edge
  bounce, rotation style.
* 🟢 **`looks`**; say/think with both overloads, costumes, backdrops, size, graphic
  effects, show/hide, layers.
* 🟢 **`sensing`**; touching, colors, distance, ask/answer, keys, mouse, drag mode,
  loudness, timer, `sensing_of`, date parts, online, username.
* 🟢 **`pen`**; down, up, clear, stamp, hex color, color params, size; the extension is
  declared in the project automatically.
* 🟢 **`clone`**; `onStart`, `create`, `delete`.
* 🟢 **`sound`**; `play`, `playUntilDone`, `stopAll`, effects, volume. The `sound` asset
  declaration still works; only `sound.` selects the namespace.
* 🟡 **`list`**; `add`, `contains`, `length`, `clear`, `indexOf`, `show`, `hide` are 🟢;
  `remove` is 🔴 (yields), `merge` is 🔴 (`katnip_list_merge`).
* 🟢 **`math`**; `pi`, `e`, `tau` fold to literals; the `MathOp` enum and `op` wrap
  `operator_mathop`, and `abs`, `floor`, `ceil`, `sqrt`, `sin`, `cos`, `tan`, `asin`,
  `acos`, `atan`, `ln`, `log`, `epow` are `builds` procs over it. `random`, `round` and `mod`
  bind their own blocks, and `pow` backs `**`. No `min` or `max` yet.
* 🟡 **`str`**; `contains` and `slice` are 🟢; the rest of the string surface is not written yet.
* 🔴 **`dict`**; `contains`, `length`, `keys`, `values`, `merge` all resolve to `katnip_*`
  opcodes with no codegen metadata, so all five stop the build.
* 🔴 **`console`**; `log`, `warn`, `error` are `katnip_*`; `input` is a yields proc.
* 🟢 **Casts**; `Num`, `Str` and `Bool` are `builds` procs that inline the value unchanged.
  They are type-checker assertions, not runtime conversions. `List` was removed from the
  prelude; there is no list cast.
* 🔴 **Helpers**; `typeof` and `motion.getPosition` have no codegen metadata; using one
  throws `no slot metadata`.
* 🟡 **Iteration helpers**; in a `for` header `range()`, `zip()` and `enumerate()` are 🟢,
  folded into the loop and never built. Used *as a value*, all three stop the build 🔴.

Every enum-typed parameter above is reachable two ways: the namespaced member
(`pen.ColorParam.COLOR`) or a literal that matches a member value (`"color"`). Only a
*computed* value is rejected, see [Known gaps](https://docs.katnip.org/reference/known-gaps/#no-cast-to-an-enum).

## Scratch project output

* 🟢 **Project structure**; stage plus one target per sprite, variables and lists declared
  on the right target, scripts laid out vertically.
* 🟢 **Custom procs**; proccode, argument ids, argument defaults, and warp mutation all
  emitted; signatures registered up front so forward calls resolve.
* 🟢 **Input shapes**; shadow primitives per slot kind (number, whole, positive, angle,
  color, string), menu shadows with dynamic-reporter overlay, broadcast primitives
  registered on the stage.
* 🟢 **Extension declaration**; opcode prefixes are detected and added to the project's
  extension list; `pen` is the only one with stdlib bindings today.
* 🟢 **Packing**; `fflate` zips `project.json`, the default costume and every declared
  asset into a `.sb3` that loads in Scratch and MistWarp.
* 🟢 **Assets**; declared costumes and sounds are keyed by md5, so one file used from
  several sprites lands in the zip once. Rotation centres and sample rates are left for
  Scratch to compute on load. A sprite with no `costume` keeps the default cat.
* 🔴 **Monitor layout**; monitors can be shown and hidden, but not positioned or styled.
* 🔴 **Comments in output**; nothing is written to the sb3 comment map.

## Comments

* 🟢 **Lexing**; six variants, single-line and multi-line, each in expanded, collapsed, and
  ignored forms; ignored ones are dropped at the lexer.
* 🔴 **Attaching to the AST**; `NodeBase.comment` exists but the parser discards comment
  tokens, so no comment ever reaches a node or the sb3 output.

## Tooling

* 🟢 **CLI**; `katnip tokenize`, `parse`, `check`, `lower`, `build`, `decompile`, `help`.
  * 🟡 `check` does not read `costume` or `sound` files, and `lower` reports them and data files
    as missing.
* 🟡 **Decompiler**; `katnip decompile` and `decompileSb3` turn a `.sb3` into `.knip` source.
  Types come back as `any`, costumes and sounds are not recovered, and blocks with no Katnip
  form become `# unsupported` comments.
* 🟢 **Error reporting**; source spans with line and column, colorized output, multiple
  errors per run; analysis continues past syntax errors so semantic errors surface alongside
  them.
* 🟢 **VS Code extension**; live diagnostics on type or on save with a configurable
  debounce, syntax highlighting, language configuration, keyword and same-file completion, and
  a `Katnip: Build .sb3` command.
* 🟢 **Warnings**; a non-blocking severity alongside errors; `no sprites declared, so this
  builds to an empty project` is the only one today.
* 🟢 **Tests**; `node --test` cases across lexer, parser, semantic, callgraph, imports, IR,
  and codegen, decompiler and API, plus 3 `todo` cases in `gaps.test.ts` that assert each gap on this page is
  still a gap, so closing one fails loudly. The imports case now passes.
* 🟢 **Public API**; `checkSource`, `compileToIR`, `compileToSb3`, `decompileSb3` and
  `decompileProject` exported for embedding, with pluggable import and asset readers.
* 🔴 **Language server**; the extension runs the compiler directly; no LSP, no type-aware
  completion, hover, or go-to-definition.
* 🔴 **Formatter**.
* 🔴 **Source maps**; no mapping from a Scratch block back to a `.knip` line.

---

## Nearest gaps, in rough order

1. Give the remaining `katnip_*` builtins real lowerings; `console`, `typeof`, `list.merge`
   and the dict methods are the widest hole.
2. Lower imported module variables and lists, so a module can own state.
3. Lower `@lower = "yields"` procs, unblocking `list.remove` and `console.input`.
4. Attach comments to the AST and emit them into the sb3 comment map.
