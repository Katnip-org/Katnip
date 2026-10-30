import { strFromU8, unzipSync } from "fflate";

import type { Sb3Project } from "../codegen/SB3TypeDefs.js";
import { Decompiler } from "./Decompiler.js";

/** Decompiles .sb3 bytes to .knip source. Stage variables become top-level globals, each sprite a `sprite` block. */
export function decompileSb3(sb3: Uint8Array): string {
    const files = unzipSync(sb3, { filter: (f) => f.name === "project.json" });
    const json = files["project.json"];
    if (!json) throw new Error("not an sb3: project.json is missing");
    return decompileProject(JSON.parse(strFromU8(json)) as Sb3Project);
}

export function decompileProject(project: Sb3Project): string {
    return new Decompiler().decompile(project);
}
