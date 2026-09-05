import { strToU8, zipSync } from "fflate";

import { defaultCostumeMd5ext, defaultCostumeSvg } from "../assets.generated.js";
import type { AssetTable } from "./assets.js";
import type { Sb3Project } from "./SB3TypeDefs.js";

/**
 * Files are keyed by md5ext, so the same bytes used from several sprites land in the zip once.
 * `level` is deflate 0-9: 6 is the default, 1 is ~40% faster for a ~30% larger file, 0 stores uncompressed.
 */
export function packSb3(project: Sb3Project, assets: AssetTable = new Map(), level?: number): Uint8Array {
    return zipSync({
        "project.json": strToU8(JSON.stringify(project)),
        [defaultCostumeMd5ext]: strToU8(defaultCostumeSvg),
        ...Object.fromEntries([...assets.values()].map((a) => [a.md5ext, a.bytes])),
    }, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined });
}
