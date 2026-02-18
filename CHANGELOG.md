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

Katnip’s trajectory:
Scratch interpreter ⇒ Structured tokenizer ⇒ Parser ⇒ Typed compiler frontend ⇒ Modern language foundation.

---

Future entries should follow semantic versioning within the 1.x line as IR, semantic analysis, lowering, and code generation mature further.
