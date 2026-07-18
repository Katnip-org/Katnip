import * as vscode from "vscode";

import type { KatnipError } from "../compiler/build/index.js" with { "resolution-mode": "import" };

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
        const errors = await checkSource(doc.getText());
        diagnostics.set(doc.uri, errors.map(toDiagnostic));
        output.appendLine(`Checked ${doc.uri.fsPath}: ${errors.length} diagnostic(s).`);
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        output.appendLine(`Check FAILED for ${doc.uri.fsPath}:\n${detail}`);
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
    "if", "elif", "else", "for", "while", "do", "return", "switch", "case", "default",
    "proc", "enum", "sprite", "private", "public", "temp", "true", "false",
    "num", "str", "bool", "list", "dict", "void",
];

// TODO: regex scan of the open file; swap for compiler symbol table when cross-file completion matters
const DECL = /\b(?:proc|enum|sprite)\s+(\w+)|\b(?:private|public|temp)\s+(\w+)/g;

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

function toDiagnostic(err: KatnipError): vscode.Diagnostic {
    const { line, column, length, endLine, endColumn } = err.location;
    const start = new vscode.Position(line - 1, column - 1);
    let end: vscode.Position;
    if (length != null) {
        end = new vscode.Position(line - 1, column - 1 + length);
    } else if (endLine != null && endColumn != null) {
        end = new vscode.Position(endLine - 1, endColumn - 1);
    } else {
        end = new vscode.Position(line - 1, column);
    }

    const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        err.message,
        vscode.DiagnosticSeverity.Error,
    );
    diag.source = `katnip:${err.source.toLowerCase()}`;
    return diag;
}
