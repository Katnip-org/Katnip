# Katnip – CHANGELOG

All notable changes to this project are documented here.

This changelog is organized into versioned "eras" that reflect architectural and philosophical shifts in Katnip’s evolution.

Commits are listed chronologically (oldest ⇒ newest). Commit hashes reference the main history and the `next-gen` TypeScript rewrite branch.

---

# 0.x — Scratch Interpreter Era (Python)

## v0.1.0 — Interpreter Genesis  
**Commits:** `6a9fe05` ⇒ `ab27c15`  
**Dates:** 2024-12-04

### Summary
Katnip begins not as a language, but as a Scratch project interpreter.

### Architecture
- Python-based runtime.
- Direct parsing of `.sb3` project JSON.
- Manual traversal of Scratch block graph.
- Opcode-based execution model:
  - `stack`
  - `reporter`
  - `hat`
  - `cap`
- Early GUI integration via TurboWarp editor display.

### Technical Characteristics
- Execution logic centered around `opcode` dispatch.
- Explicit modeling of Scratch substack behavior.
- No tokenizer.
- No parser.
- No AST.
- No grammar.

Katnip at this stage is a Scratch VM reimplementation layer.

---

## v0.2.0 — Full Block Coverage & Structural Hardening  
**Commits:** `96bef08` ⇒ `d791ee2`  
**Dates:** 2024-12-04 ⇒ 2024-12-07

### Summary
Interpreter becomes functionally complete for core Scratch blocks.

### Major Changes
- Reporter, stack, and cap blocks fully supported.
- Substack duplication bug resolved.
- Added nearly all Scratch blocks into `commands.txt`.
- Menu/option blocks encoded with `{}` syntax.
- Comment support added.
- Custom block groundwork introduced.

### Architectural Notes
- Execution engine stabilizes.
- Interpreter handles nested block stacks.
- Increasing complexity in opcode branching logic.

This is the peak of the “execute Scratch faithfully” phase.

---

## v0.3.0 — Control Flow Completion  
**Commits:** `6159a9f` ⇒ `5ba9f61`  
**Dates:** 2024-12-08 ⇒ 2024-12-13

### Summary
Control flow becomes complete and release-ready.

### Major Changes
- Comment fixes.
- Full `if` / `else` implementation.
- Release milestone commit (`DONE! Else implemented.`).
- README introduced.

### Significance
Interpreter reaches functional completeness.
Custom blocks planned next.
This marks the end of purely execution-focused development.

---

## v0.4.0 — Project Structuring & Web Integration  
**Commits:** `eed50a4` ⇒ `37c4ea9`  
**Dates:** 2024-12-13 ⇒ 2025-01-22

### Summary
Project reorganized and prepared for public exposure.

### Major Changes
- Directory restructuring.
- Cross-platform path handling via `os.path.join`.
- Flask web app added.
- Web-based editor introduced.
- File overhaul and architecture rearrangement.

### Significance
Katnip begins shifting from internal tool to public-facing project.
Structural reorganization suggests scaling ambitions.

---

## v0.5.0 — Tokenizer Emergence (Language Begins)  
**Commits:** `8a58319` ⇒ `60c2d3b`  
**Dates:** 2025-01-23 ⇒ 2025-02-09

### Summary
The conceptual shift from interpreter to language begins.

### Major Changes
- Tokenizer implemented.
- Error system refactored into class structure.
- Typing syntax introduced.
- Parser work initiated.

### Architectural Shift
From:
    Executing Scratch block graphs

To:
    Parsing structured source text

This is the birth of Katnip as a programming language.

---

## v0.6.0 — Typing & Parser Foundations  
**Commits:** `a7a5b38` ⇒ `b367d28`  
**Dates:** 2025-02-24 ⇒ 2025-04-18

### Summary
Parser and typing systems expand.

### Major Changes
- Typing support expanded.
- Tokenizer improvements.
- Structural parsing progress.

The language begins gaining identity separate from Scratch.

---

# 1.x — TypeScript Rewrite (next-gen branch)

The `next-gen` branch diverges and moves Katnip into a full compiler architecture implemented in TypeScript.

---

## v1.0.0-alpha — TypeScript Project Initialization  
**Commit:** `7d015d9`  
**Date:** 2025-08-03

### Major Changes
- Full TypeScript project setup.
- New directory structure.
- Lexer implementation in TS.
- Basic CLI commands added.

### Architectural Shift
- Static typing enforced at language implementation level.
- Clear separation between CLI and compiler logic.
- Beginning of modular compiler pipeline.

This marks the generational rewrite.

---

## v1.1.0 — Lexer Formalization & Symbol Infrastructure  
**Commits:** `5dc5687` ⇒ `96f9f9e`  
**Dates:** 2025-08-03 ⇒ 2025-08-19

### Major Changes
- `SymbolTable` introduced and corrected.
- Exponential notation parsing fixes.
- Lexer structure overhaul to align with parser needs.
- Sanitized logging.
- Newline tokens introduced.

### Technical Improvements
- Multi-character operator consumption logic improved.
- Lexer now attempts maximal valid operator matching.
- Numeric literal validation enhanced.

Lexer transitions from ad-hoc scanner to structured front-end stage.

---

## v1.2.0 — Parser Construction Phase  
**Commits:** `2b0040a` ⇒ `1cc85a3`  
**Dates:** 2025-08-15 ⇒ 2025-08-16

### Major Changes
- `parseProcedureDefinition` implemented.
- Parser helper functions refactored.
- Enum parsing finalized.
- Grammar examples added.

### Architectural Notes
- Parser transitions from non-functional scaffold to operational system.
- Redundant token handling condensed.
- Style consistency enforced.

Katnip now has a recognizable grammar.

---

## v1.3.0 — Parser Stabilization & Error System  
**Commits:** `b3e3725` ⇒ `81a118f`  
**Dates:** 2025-12-26 ⇒ 2025-12-29

### Major Changes
- Fixed newline and EOL token issues.
- Fixed parameter consumption bugs.
- Resolved repeated symbol parsing issues.
- Introduced stack trace support for errors.

### Significance
Error reporting becomes developer-grade.
Parser reliability significantly improved.

---

## v1.4.0 — Pratt Parser & Operator System Refinement  
**Commits:** `44daecc` ⇒ `8566065`  
**Dates:** 2026-01-02 ⇒ 2026-01-31

### Major Changes
- Pratt parser binding table fixes.
- Consolidated assignment operator logic.
- Infix support for list indexing.
- Prefix dictionary support.
- Logger system replaced raw print statements.
- CLI debugger flag corrections.

### Technical Depth
- Binding power conflicts resolved.
- Operator parsing formalized.
- Assignment operators centralized.
- Structural grammar stability achieved.

This marks maturity of expression parsing.

---

## v1.5.0 — Advanced Language Features  
**Commits:** `9baa264` ⇒ `3a64e03`  
**Dates:** 2026-02-01 ⇒ 2026-02-15

### Major Features
- Tuple parsing implemented.
- Interpolated (f) strings fully integrated.
- For loops implemented.
- If / if-else statements implemented.
- While and do-while loops added.
- Named parameters supported.

### Architectural Significance
Katnip transitions from experimental language to expressive structured language.

Control flow is now:
- Structured
- Keyword-based
- Fully parsed
- AST-driven

Named parameters introduce higher-level abstraction semantics.

This is the first moment Katnip resembles a complete modern language frontend.

---

## v1.6.0 — Sprite Construct & Repo Discipline  
**Commit:** `b2cbeec`  
**Date:** 2026-02-18

### Summary
A short housekeeping release that closes the frontend era.

### Major Changes
- `sprite` construct added to the AST and parser.
- Pre-commit hooks introduced (`.githooks/`).
- Commit log tracking added.
- This changelog file created.

### Significance
The `sprite` keyword is the first construct that exists purely for Scratch’s benefit rather than the language’s — an early signal of where the compiler has to end up.

Then the repository goes quiet for four months.

---

# 2.x — Compiler Era (Making the Thing Real)

Between `b2cbeec` (2026-02-18) and `df46874` (2026-06-27) nothing is committed.

Everything built up to that point was a **frontend**. Text went in, an AST came out, and nothing ever ran. Katnip was a grammar with excellent error messages and no output.

2.x is the era where that changes. The project stops being an exercise in parsing and becomes something that can be installed, typed into an editor, and compiled into a file that actually opens in Scratch.

It happens in three movements:

1. **The middle gets built.** Semantic analysis, scope resolution, type inference, a real standard library.
2. **The project gets shipped.** npm package, VS Code extension, LSP diagnostics, license, README, syntax highlighting.
3. **The back end closes the loop.** IR lowering, then SB3 code generation, then a packed `.sb3` on disk.

By the end of 2.x, `katnip build hello.knip` produces a Scratch project that runs — which means Katnip has arrived back where it started in 0.x, from the opposite direction.

---

## v2.0.0 — Semantic Analysis  
**Commits:** `df46874` ⇒ `32047e0`  
**Dates:** 2026-06-27 ⇒ 2026-06-30

### Summary
The compiler grows a middle. `SemanticAnalyzer.ts` goes from empty to roughly 700 lines in a single day.

### Major Changes
- `SemanticAnalyzer` implemented with a `visit()` dispatch over AST nodes.
- `SymbolTable` rebuilt for real scope resolution.
- `InternalTypes` introduced — the compiler’s own type vocabulary, separate from surface syntax.
- Variable hoisting at the shared namespace of the declaring file.
- Handler statements, for statements, return statements, boolean literals.
- First sketch of switch statements (exhaustiveness and `fallthrough` deferred).
- `proc` / `enum` modifiers; `private` re-permitted.
- Parser now emits a real `BlockNode` for procedure bodies.

### Bug Fixes
- Lexer comment bug where `#!` and `#[]#` comments leaked their contents.
- Node end-location tracking and error caret lengths corrected.

### Architectural Notes
The parser had been producing a tree nobody inspected. Semantic analysis is the first stage that asks whether the tree *means* anything — and it immediately exposes location-tracking and scope bugs the parser had been quietly carrying.

---

## v2.1.0 — Type Inference & The Standard Library  
**Commits:** `d4cacfd` ⇒ `53adcbf`  
**Dates:** 2026-06-29 ⇒ 2026-07-05

### Summary
Types become inferred rather than merely declared, and Katnip gains a standard library written in Katnip.

### Major Changes
- Type inference implemented across expressions.
- Call expression resolution and argument collection.
- Tuple types added to the parser; named argument parsing fixed.
- Procedure resolution against declared signatures.
- `StdlibLoader` implemented.
- Standard library authored as `.knip` source: `prelude`, `motion`, `looks`, `events`, `control`, `sensing`, `pen`, `math`, `str`, `list`, `dict`, `console`, `clone`.

### Bug Fixes
- Enums now work correctly with binary operators.

### Architectural Significance
The stdlib is written **in Katnip**, not in TypeScript. The language is now expressive enough to describe its own surface area, and Scratch’s block vocabulary is exposed as ordinary callable procedures rather than special-cased compiler knowledge.

Semantic analysis is declared tentatively done.

---

## v2.2.0 — Publishing & Tooling  
**Commits:** `8914e28` ⇒ `cab8132`  
**Dates:** 2026-07-05 ⇒ 2026-07-06

### Summary
Katnip becomes installable. This is the point where it stops being a folder and starts being a product.

### Major Changes
- Published to npm as `@katnip-org/compiler`.
- VS Code extension package created (`katnip-vscode`).
- TextMate grammar for syntax highlighting.
- Language configuration (brackets, comments, auto-closing).
- Extension surfaces compiler errors as native editor diagnostics.
- `help` command added to the CLI.
- Apache 2.0 `LICENSE` and `NOTICE` added at root and per package.
- READMEs written for the repo, the compiler, and the extension.
- Minimal in-house `picocolors` implementation to avoid import errors.

### Significance
Every change here is about someone *else* using the thing. Licensing, packaging, documentation, editor integration — none of it makes the compiler better, and all of it makes the compiler usable.

The hand-rolled colors implementation is characteristic of the era: a dependency removed rather than added, because the package now has to install cleanly on other people’s machines.

---

## v2.3.0 — Portability & Hardening  
**Commits:** `6a73f73` ⇒ `02a3b97`  
**Dates:** 2026-07-11

### Summary
Consequences of publishing. A single day of fixes driven entirely by the compiler running somewhere other than the author’s machine.

### Major Changes
- Stdlib `.knip` files embedded into generated source (`gen-stdlib.mjs`, `stdlib.generated.ts`) — no filesystem reads at runtime.
- `tsconfig.core.json` split out for a browser-safe build target.
- Three sequential bugfixes for web use.
- `noUnusedLocals` enabled; dead code removed; lexer tech debt paid down.
- Forward-progress guard added to the lexer.
- Token consumption checks tightened in the parser.

### Technical Notes
The forward-progress guard is the important one: a lexer that fails to advance hangs the browser tab rather than printing an error. Filesystem-free stdlib loading is the same category of change — assumptions that were free on a developer machine become bugs the moment the compiler runs in a sandbox.

---

## v2.4.0 — Modules, Structs & The Test Suite  
**Commits:** `f2451d8` ⇒ `0280121`  
**Dates:** 2026-07-16 ⇒ 2026-07-22

### Summary
The language gains composition, and the project gains a safety net.

### Major Changes
- `ModuleLoader` and import resolution implemented.
- `CallGraph` with cycle detection and return-strategy resolution.
- Struct declarations with field validation and struct literal parsing.
- Enum member values.
- `scratchDefs.ts` — opcode slot table mapping Scratch blocks to their argument shapes.
- Stdlib expanded: events, sensing, looks, variable and list blocks.
- LSP autocompletion in the VS Code extension.
- **Test suite introduced**: lexer, parser, semantic, callgraph, imports, and IR tests.

### Architectural Notes
Cycle detection exists because Scratch has no call stack — recursion and mutual recursion have to be resolved at compile time into a return strategy, not deferred to a runtime that cannot support them. This is the first design decision forced by the target platform rather than by the language.

`scratchDefs` is the compiler’s first concrete knowledge of Scratch’s actual wire format.

### Significance
Before this point, every regression was found by running an example by hand. The test suite marks the transition from a project being explored to a project being maintained.

---

## v2.5.0 — IR Generation  
**Commits:** `a225003` ⇒ `51d0233`  
**Dates:** 2026-07-21 ⇒ 2026-08-06

### Summary
The AST is lowered into an intermediate representation. The compiler finally has a back half.

### Major Changes
- `IRGenerator` implemented — from nothing to roughly 600 lines across the phase.
- Procedure lowering with explicit return plans (scalar and tuple returns).
- Builds procs and related operators.
- `elif`, `for` (with range support), and `switch` lowering.
- Return handling reworked.
- IR test coverage expanded substantially.

### Architectural Significance
IR is where Katnip’s semantics and Scratch’s capabilities are reconciled. Structured constructs the language offers freely — tuple returns, ranged for loops, switch — have no direct equivalent in Scratch, and lowering is where each one is rewritten into something the target can express.

The “return plan” abstraction exists for exactly this reason: Scratch procedures do not return values, so every return has to be lowered into variable writes decided at compile time.

---

## v2.6.0 — SB3 Code Generation — The Loop Closes  
**Commits:** `e644889` ⇒ `4cd682b`  
**Dates:** 2026-08-06 ⇒ 2026-08-09

### Summary
Katnip emits a real `.sb3` file. Source text in, runnable Scratch project out.

### Major Changes
- `SB3Generator` implemented — IR lowered to Scratch block JSON.
- `SB3TypeDefs` describing the Scratch 3.0 project format.
- `pack.ts` — zips `project.json` with a default costume into a valid `.sb3` via `fflate`.
- `katnip build <source>` compiles straight to `.sb3`.
- `katnip lower <source>` emits IR as JSON for inspection.
- Lists and dictionaries supported with initial contents.
- Boolean handling corrected across both IR and SB3 generators.
- Enum literal coercion with improved mismatch diagnostics.
- `KatnipError` integrated across all compiler stages for uniform error reporting.
- Stdlib math expanded, including `pow`; prelude casts updated.
- Scope and extension-loading bugs fixed.
- Codegen tests added; suite now spans roughly 180 tests across nine files.
- Git hooks removed; package versions bumped for release.

### Significance
This is the commit range the whole project has been walking toward since 2024.

0.x read `.sb3` files and interpreted them. 2.6 writes `.sb3` files from source. The pipeline is complete end to end:

    source ⇒ lexer ⇒ parser ⇒ semantic analysis ⇒ IR ⇒ SB3 ⇒ .sb3

Katnip is no longer a language that describes Scratch. It is a compiler that produces it.

---

# Summary of Evolution

0.x:
- Execution-first mindset.
- Reverse engineering Scratch’s runtime.
- Interpreter complexity drives abstraction pressure.
- Tokenizer introduced.
- Parser begins.

1.x:
- Full rewrite in TypeScript.
- Formal compiler pipeline emerges.
- Lexer and parser structured and stabilized.
- Pratt parsing implemented.
- Advanced language constructs added.
- Error reporting matured.
- Control flow completed.

2.x:
- Semantic analysis, scope resolution, and type inference implemented.
- Standard library written in Katnip itself.
- Published to npm; VS Code extension with highlighting, diagnostics, and autocomplete.
- Hardened for environments other than the author’s machine.
- Modules, imports, structs, and call graph analysis added.
- Test suite established.
- IR lowering implemented.
- SB3 code generation completed — the compiler produces runnable Scratch projects.

Katnip’s trajectory:
Scratch interpreter ⇒ Structured tokenizer ⇒ Parser ⇒ Typed compiler frontend ⇒ Modern language foundation ⇒ Complete compiler emitting Scratch.

The 1.x line built a language that could be read.
The 2.x line built a compiler that could be used.

---

Future entries should follow semantic versioning within the 2.x line as the standard library, optimization passes, and Scratch feature coverage mature further.
