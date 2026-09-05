import { md5 } from "js-md5";

import type { AST } from "../parser/AST-nodes.js";
import { specifierSpan, type AssetReader } from "../semantic/ModuleLoader.js";
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
