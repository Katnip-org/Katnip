import { md5 } from "js-md5";

import type { AST, CallExpressionNode, ExpressionNode, LiteralExpressionNode, SourceLocation } from "../parser/AST-nodes.js";
import { specifierSpan, type AssetReader, type ImportedModule } from "../semantic/ModuleLoader.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";

export interface ResolvedAsset {
    assetId: string;
    md5ext: string;
    dataFormat: string;
    bytes: Uint8Array;
}

/** Keyed by the specifier as written, which is how the IR refers back to an asset. */
export type AssetTable = Map<string, ResolvedAsset>;

/** Reads every costume/sound declared in the file's sprites. Missing files are reported like unresolvable imports. */
export function loadAssets(ast: AST, fromPath: string, read: AssetReader, reporter: ErrorReporter): AssetTable {
    const table: AssetTable = new Map();
    for (const stmt of ast.body) {
        if (stmt.type !== "SpriteDeclaration") continue;
        for (const decl of stmt.body.body) {
            if (decl.type !== "AssetDeclaration" || table.has(decl.specifier)) continue;
            const bytes = read(decl.specifier, fromPath);
            if (!bytes) {
                reporter.add(new KatnipError("Asset", `Cannot find ${decl.kind} '${decl.specifier}'`, specifierSpan(decl)));
                continue;
            }
            const assetId = md5(bytes);
            const dataFormat = decl.specifier.split(".").pop()!.toLowerCase();
            table.set(decl.specifier, { assetId, md5ext: `${assetId}.${dataFormat}`, dataFormat, bytes });
        }
    }
    return table;
}

type Scalar = string | number | boolean;

/** Swaps every `import("./file.json")` / `import("./file.csv")` expression for the list or dict literal */
export function loadData(ast: AST, fromPath: string, read: AssetReader, reporter: ErrorReporter): void {
    const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        for (const [key, child] of Object.entries(node)) {
            if (key === "loc") continue;
            if (isDataImport(child)) (node as Record<string, unknown>)[key] = dataLiteral(child, fromPath, read, reporter);
            else visit(child);
        }
    };
    visit(ast);
}

export function loadImportedData(modules: ImportedModule[], read: AssetReader): void {
    for (const module of modules) {
        loadData(module.ast, module.sourcePath, read, module.reporter);
        loadImportedData(module.imports, read);
    }
}

function isDataImport(node: unknown): node is CallExpressionNode {
    const call = node as CallExpressionNode | null;
    return call?.type === "CallExpression" && call.object.type === "Identifier" && call.object.name === "import";
}

function dataLiteral(call: CallExpressionNode, fromPath: string, read: AssetReader, reporter: ErrorReporter): ExpressionNode {
    const fail = (message: string, loc: SourceLocation): ExpressionNode => {
        reporter.add(new KatnipError("Asset", message, specifierSpan({ specifierLoc: loc })));
        return { type: "ErrorToken", value: "", loc: call.loc };
    };

    const arg = call.arguments[0];
    if (call.arguments.length !== 1 || arg?.type !== "Literal" || typeof arg.value !== "string")
        return fail("import() takes one quoted path to a .json or .csv file", call.loc);

    const path = arg.value;
    const format = path.split(".").pop()!.toLowerCase();
    if (format !== "json" && format !== "csv") return fail(`import() loads .json or .csv files, not '${path}'`, arg.loc);

    const bytes = read(path, fromPath);
    if (!bytes) return fail(`Cannot resolve '${path}'`, arg.loc);
    const text = new TextDecoder().decode(bytes);
    const lit = (value: Scalar): LiteralExpressionNode => ({ type: "Literal", value, valueType: valueTypeOf(value), loc: call.loc });

    if (format === "csv") {
        const cells = csvCells(text);
        if (!cells) return fail(`'${path}' must be a single row or a single column to load as a list`, arg.loc);
        return { type: "ListExpression", elements: cells.map((cell) => lit(cellValue(cell))), loc: call.loc };
    }

    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return fail(`Invalid JSON in '${path}': ${(err as Error).message}`, arg.loc);
    }
    const flatErr = `'${path}' must be a flat array or a flat object of strings, numbers and booleans`;
    if (Array.isArray(data)) {
        if (!data.every(isScalar)) return fail(flatErr, arg.loc);
        return { type: "ListExpression", elements: data.map(lit), loc: call.loc };
    }
    if (!data || typeof data !== "object" || !Object.values(data).every(isScalar)) return fail(flatErr, arg.loc);
    return {
        type: "DictExpression",
        entries: Object.entries(data as Record<string, Scalar>).map(([key, value]) => ({ key: lit(key), value: lit(value) })),
        loc: call.loc,
    };
}

function isScalar(value: unknown): value is Scalar {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function valueTypeOf(value: Scalar): LiteralExpressionNode["valueType"] {
    if (typeof value === "number") return "Number";
    if (typeof value === "boolean") return "Boolean";
    return "String";
}

function cellValue(cell: string): Scalar {
    if (cell.trim() !== "" && !Number.isNaN(Number(cell))) return Number(cell);
    return cell;
}

function csvCells(text: string): string[] | null {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let wasQuoted = false;

    const endCell = () => {
        // Whitespace around an unquoted cell is padding; inside quotes it is data
        if (wasQuoted) row.push(cell);
        else row.push(cell.trim());
        cell = "";
        wasQuoted = false;
    };
    const endRow = () => {
        endCell();
        if (row.length > 1 && row[row.length - 1] === "") row.pop();
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
            wasQuoted = true;
        } else if (char === ",") {
            endCell();
        } else if (char === "\n") {
            endRow();
        } else if (char !== "\r") {
            cell += char;
        }
    }
    endRow();

    if (rows.length === 1) return rows[0]!;
    if (rows.every((r) => r.length === 1)) return rows.map((r) => r[0]!);
    return null;
}
