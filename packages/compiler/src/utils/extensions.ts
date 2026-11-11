/**
 * Opcode prefixes Scratch itself owns: its built-in block categories (scratch-vm's `motion`,
 * `control`, `operator`, ...) plus the `math_*` shadow primitives. A proc pointing `@opcode` at one
 * of these is not naming an extension, so it never needs declaring.
 */
export const CORE_CATEGORIES: readonly string[] = [
    "motion",
    "looks",
    "sound",
    "event",
    "control",
    "sensing",
    "operator",
    "data",
    "procedures",
    "argument_reporter",
    "math",
];

/**
 * Opcode prefixes the Scratch VM itself ships, so a project can use their blocks without naming
 * them. Every other prefix has to be declared in the source with `extension <name> = "<url>";`.
 *
 * Keys are the opcode prefix, which is also the id that goes in `project.json.extensions` and
 * `project.json.extensionURLs`.
 */
export const KNOWN_EXTENSION_IDS = [
    "pen",
    "music",
    "text2speech",
    "translate",
    "videoSensing",
    "makeymakey",
    "microbit",
    "ev3",
    "boost",
    "wedo2",
    "gdxfor",
] as const;

export type KnownExtension = (typeof KNOWN_EXTENSION_IDS)[number];

/** The owning extension of a scratch block opcode: `pen_penDown` -> `pen`. */
export const opcodePrefix = (opcode: string): string => opcode.split("_")[0] as string;

/** One argument of a declared extension's block, in the order the extension's body lists them. */
export interface DeclaredBlockArg {
    /** The extension's own argument name; it is the sb3 input key, so the case has to match. */
    name: string;
    /** Whether the `.knip` param is a number, which only picks the empty slot's shadow. */
    numeric: boolean;
}

/** A block a declared extension contributes: opcode -> its arguments in order. */
export type DeclaredBlocks = Map<string, DeclaredBlockArg[]>;

/** What `extension <name> = "<url>";` declared. */
export interface DeclaredExtension {
    /** Where to fetch the extension from, or null for one the VM already ships. */
    url: string | null;
    blocks: DeclaredBlocks;
}
