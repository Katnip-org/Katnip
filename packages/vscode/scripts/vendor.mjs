// Copies the built compiler (JS + stdlib + its runtime deps) into ./compiler so the packaged extension is fully self-contained
import { cp, rm, access, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = dirname(here); // packages/vscode
const compiler = join(ext, "..", "compiler"); // packages/compiler
const dest = join(ext, "compiler"); // packages/vscode/compiler

try {
    await access(join(compiler, "build", "index.js"));
} catch {
    console.error("Compiler is not built. Run `tsc` in packages/compiler first.");
    process.exit(1);
}

// Skip .map files: their `sources` point up-tree and make vsce try to package
// the whole repo. (.d.ts are kept — the extension's typecheck needs them.)
const noMaps = { recursive: true, filter: (src) => !src.endsWith(".map") };

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(join(compiler, "build"), join(dest, "build"), noMaps);
await cp(join(compiler, "stdlib"), join(dest, "stdlib"), { recursive: true });
await writeFile(join(dest, "package.json"), JSON.stringify({ type: "module" }) + "\n");

// `vsce package --no-dependencies` ships no node_modules, so the compiler's runtime deps have to come along by hand.
const require = createRequire(import.meta.url);
for (const name of ["fflate", "js-md5"]) {
    const pkg = dirname(require.resolve(`${name}/package.json`, { paths: [compiler] }));
    await cp(pkg, join(dest, "node_modules", name), noMaps);
}

console.log("Vendored compiler -> packages/vscode/compiler");
