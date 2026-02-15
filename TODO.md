# Project TODO List

## High priority
- [x] Implement utils
- [x] Implement parser
- [ ] Implement semantic analysis
- [ ] Implement ir
- [ ] Implement codegen
- [x] Imlement better cli

## Feature enhancements
- [ ] AST Patches; Macros

## Misc
- [x] Add list and dictionary literal functionality to expression parsing
- [ ] Implement comment attaching funcitonality
- [x] Overhaul token system. Use enums, and change overall interface with them
- [ ] Fix redudant "src" pass in inside of `lexer.ts`
- [x] Fix allowing named argument inputs to procs
- [x] Fix 'else' and 'elif' keywords (aka implement logic or them)
- [x] Finish implementing interpolated strings in parser