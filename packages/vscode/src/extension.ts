import * as vscode from "vscode";

import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { KatnipError, ImportResolver, AssetReader } from "../compiler/build/index.js" with { "resolution-mode": "import" };

const fileResolver: ImportResolver = (specifier, fromPath) => {
    const resolved = path.resolve(
        path.dirname(fromPath),
        specifier.endsWith(".knip") ? specifier : `${specifier}.knip`,
    );
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === resolved);
    if (open) return { path: resolved, source: open.getText() };
    try {
        return { path: resolved, source: readFileSync(resolved, "utf8") };
    } catch {
        return null;
    }
};

const fileAssetReader: AssetReader = (specifier, fromPath) => {
    try {
        return readFileSync(path.resolve(path.dirname(fromPath), specifier));
    } catch {
        return null;
    }
};

type Compiler = typeof import("../compiler/build/index.js", { with: { "resolution-mode": "import" } });

let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let compilerPromise: Promise<Compiler> | undefined;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function loadCompiler(context: vscode.ExtensionContext): Promise<Compiler> {
    const entry = vscode.Uri.joinPath(context.extensionUri, "compiler", "build", "index.js").toString();
    return (compilerPromise ??= import(entry) as Promise<Compiler>);
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("Katnip");
    diagnostics = vscode.languages.createDiagnosticCollection("katnip");
    context.subscriptions.push(output, diagnostics);
    output.appendLine("Katnip extension activated.");

    const run = (doc: vscode.TextDocument) => check(context, doc);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(run),
        vscode.workspace.onDidSaveTextDocument(run),
        vscode.workspace.onDidChangeTextDocument((e) => scheduleCheck(context, e.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
        vscode.languages.registerCompletionItemProvider("katnip", { provideCompletionItems: complete }),
        vscode.commands.registerCommand("katnip.build", () => build(context)),
    );
    vscode.workspace.textDocuments.forEach(run);
}

export function deactivate(): void {
    diagnostics?.dispose();
    output?.dispose();
}

async function check(context: vscode.ExtensionContext, doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== "katnip") return;
    try {
        const { checkSource } = await loadCompiler(context);
        // A debounced or first-load check can land after the document closed; don't resurrect its diagnostics.
        if (doc.isClosed) return;
        const errors = await checkSource(doc.getText(), { path: doc.uri.fsPath, resolve: fileResolver, readAsset: fileAssetReader });
        diagnostics.set(doc.uri, errors.map((err) => toDiagnostic(doc, err)));
        output.appendLine(`Checked ${doc.uri.fsPath}: ${errors.length} diagnostic(s).`);
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        output.appendLine(`Check FAILED for ${doc.uri.fsPath}:\n${detail}`);
    }
}

async function build(context: vscode.ExtensionContext): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== "katnip") {
        vscode.window.showErrorMessage("Katnip: open a .knip file to build.");
        return;
    }

    try {
        const { compileToSb3 } = await loadCompiler(context);
        const { errors, sb3 } = await compileToSb3(doc.getText(), {
            path: doc.uri.fsPath,
            resolve: fileResolver,
            readAsset: fileAssetReader,
        });
        diagnostics.set(doc.uri, errors.map((err) => toDiagnostic(doc, err)));

        if (!sb3) {
            vscode.window.showErrorMessage(`Katnip: build failed, ${errors.length} error(s).`);
            return;
        }

        const target = doc.uri.with({ path: `${doc.uri.path.replace(/\.knip$/, "")}.sb3` });
        await vscode.workspace.fs.writeFile(target, sb3);
        output.appendLine(`Built ${target.fsPath}`);
        vscode.window.showInformationMessage(`Katnip: built ${path.basename(target.fsPath)}`);
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        output.appendLine(`Build FAILED for ${doc.uri.fsPath}:\n${detail}`);
        vscode.window.showErrorMessage("Katnip: build failed, see the Katnip output channel.");
    }
}

function scheduleCheck(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
    if (doc.languageId !== "katnip") return;
    const cfg = vscode.workspace.getConfiguration("katnip");
    if (cfg.get<string>("check.trigger") !== "onType") return;

    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => check(context, doc), cfg.get<number>("check.debounce", 250)));
}

const KEYWORDS = [
    "if", "elif", "else", "for", "while", "do", "forever", "repeat", "return", "switch", "case", "default",
    "proc", "enum", "struct", "sprite", "stage", "private", "public", "import", "costume", "sound", "as",
    "true", "false",
    "num", "str", "bool", "list", "dict", "void",
];

// TODO: regex scan of the open file; swap for compiler symbol table when cross-file completion matters
const DECL = /\b(?:proc|enum|struct|sprite)\s+(\w+)|\b(?:private|public)\s+(\w+)/g;

function complete(doc: vscode.TextDocument): vscode.CompletionItem[] {
    const items = KEYWORDS.map((k) => new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword));
    const seen = new Set<string>();
    for (const m of doc.getText().matchAll(DECL)) {
        const name = m[1] ?? m[2];
        if (name && !seen.has(name)) {
            seen.add(name);
            items.push(new vscode.CompletionItem(
                name,
                m[1] ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable,
            ));
        }
    }
    return items;
}

// Katnip columns are 1-based code points; VS Code wants 0-based UTF-16 offsets, so astral chars (emoji) count twice.
function toPosition(doc: vscode.TextDocument, line: number, column: number): vscode.Position {
    if (line < 1 || line > doc.lineCount) return new vscode.Position(Math.max(line - 1, 0), Math.max(column - 1, 0));
    const text = doc.lineAt(line - 1).text;
    let offset = 0;
    for (let i = 1; i < column; i++) {
        if (offset < text.length && text.codePointAt(offset)! > 0xffff) {
            offset += 2;
        } else {
            offset += 1;
        }
    }
    return new vscode.Position(line - 1, offset);
}

function toDiagnostic(doc: vscode.TextDocument, err: KatnipError): vscode.Diagnostic {
    // IR/codegen errors carry no span; anchor them at the top of the file.
    const loc: NonNullable<KatnipError["location"]> = err.location ?? { line: 1, column: 1 };
    const { line, column, length, endLine, endColumn } = loc;
    const start = toPosition(doc, line, column);
    let end: vscode.Position;
    if (length != null) {
        end = toPosition(doc, line, column + length);
    } else if (endLine != null && endColumn != null) {
        end = toPosition(doc, endLine, endColumn);
    } else {
        end = toPosition(doc, line, column + 1);
    }

    const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        err.message,
        err.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
    );
    diag.source = `katnip:${err.source.toLowerCase()}`;
    return diag;
}
