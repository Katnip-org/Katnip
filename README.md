# Katnip

A compiler for the Katnip language (`.knip`), targeting Scratch SB3.

## Setup

```
npm install
```

## Build

Build the compiler:

```
npm run build -w @katnip/compiler
```

## CLI

Type-check a `.knip` file (reports lexer, parser, and semantic errors):

```
node packages/compiler/build/cli.js check examples/all.knip
```

Also available: `parse <src> <out.json>` and `tokenize <src> <out.json>`.

## VS Code extension

Build the `.vsix` (rebuilds + vendors the compiler, then packages):

```
npm run package -w katnip-vscode
```

Install it into VS Code and reload:

```
code --install-extension packages/vscode/katnip-vscode-0.0.1.vsix --force
```

Run `Developer: Reload Window`, then open any `.knip` file for live diagnostics.
