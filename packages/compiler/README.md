# @katnip-org/compiler

Compiler and type-checker for the **Katnip** language (`.knip`), targeting Scratch SB3.

## Install

```
npm install -g @katnip-org/compiler
```

Or run without installing:

```
npx @katnip-org/compiler check path/to/file.knip
```

## Usage

Type-check a file (reports lexer, parser, and semantic errors):

```
katnip check path/to/file.knip
```

Other commands:

```
katnip parse    <source> <output.json>   # write the AST as JSON
katnip tokenize <source> <output.json>   # write the token stream as JSON
```

## Library

```js
import { checkSource } from "@katnip-org/compiler";

const errors = await checkSource(sourceText); // readonly KatnipError[]
```

## License

Apache-2.0
