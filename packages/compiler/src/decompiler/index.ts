import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

import type { Sb3Project } from "../codegen/SB3TypeDefs.js";
import { Decompiler } from "./Decompiler.js";

/** Decompiles .sb3 bytes to .knip source. Stage variables become top-level globals, each sprite a `sprite` block. */
export function decompileSb3(sb3: Uint8Array): string {
    return decompileProject(readProject(unzipSync(sb3, { filter: (f) => f.name === "project.json" })));
}

export function decompileProject(project: Sb3Project): string {
    return new Decompiler().decompile(project);
}

/** Decompiles .sb3 bytes to a .kpkg: a zip of main.knip plus every costume and sound under assets/. */
export function decompileSb3ToKpkg(sb3: Uint8Array): Uint8Array {
    const files = unzipSync(sb3);
    const decompiler = new Decompiler(true);
    const pkg: Zippable = { "main.knip": strToU8(decompiler.decompile(readProject(files))) };
    for (const { path, md5ext } of decompiler.assets) {
        const bytes = files[md5ext];
        if (!bytes) throw new Error(`not a full sb3: asset ${md5ext} is missing`);
        pkg[path.slice(2)] = bytes;
    }
    return zipSync(pkg);
}

function readProject(files: Record<string, Uint8Array>): Sb3Project {
    const json = files["project.json"];
    if (!json) throw new Error("not an sb3: project.json is missing");
    return JSON.parse(strFromU8(json)) as Sb3Project;
}
