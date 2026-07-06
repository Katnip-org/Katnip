# Katnip for VS Code

Language support for the **Katnip** language (`.knip`) ~ compiles to Scratch SB3.

## Features

- **Live diagnostics** — lexer, parser, and semantic errors shown inline as you type (powered by the Katnip compiler).
- **Syntax highlighting** — keywords, types, decorators, numbers, strings (including f-strings), and comments.

## Getting started

1. Install the extension, then reload your extensions.
2. Create a new file with ending `.knip` and you're done! If you wish to compile your projects, download the compiler from npm:

    `npm install -g @Katnip-org/Katnip`

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `katnip.check.trigger` | `onType` | When to re-check files: `onType` or `onSave`. |
| `katnip.check.debounce` | `250` | Delay in ms after the last keystroke before re-checking (`onType` only). |

## License

Apache-2.0
