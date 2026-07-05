import * as vscode from "vscode";
import type { KatnipError } from "../compiler/build/index.js" with { "resolution-mode": "import" };

type Compiler = typeof import("../compiler/build/index.js", { with: { "resolution-mode": "import" } });
let compilerPromise: Promise<Compiler> | undefined;
const compiler = () => (compilerPromise ??= import("../compiler/build/index.js"));

let diagnostics: vscode.DiagnosticCollection;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
    diagnostics = vscode.languages.createDiagnosticCollection("katnip");
    context.subscriptions.push(diagnostics);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(check),
        vscode.workspace.onDidSaveTextDocument(check),
        vscode.workspace.onDidChangeTextDocument((e) => scheduleCheck(e.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    );
    vscode.workspace.textDocuments.forEach(check);
}

export function deactivate(): void {
    diagnostics?.dispose();
}

async function check(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== "katnip") return;
    const { checkSource } = await compiler();
    const errors = await checkSource(doc.getText());
    diagnostics.set(doc.uri, errors.map(toDiagnostic));
}

function scheduleCheck(doc: vscode.TextDocument): void {
    if (doc.languageId !== "katnip") return;
    const cfg = vscode.workspace.getConfiguration("katnip");
    if (cfg.get<string>("check.trigger") !== "onType") return;

    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => check(doc), cfg.get<number>("check.debounce", 250)));
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
