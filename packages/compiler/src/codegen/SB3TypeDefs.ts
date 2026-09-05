

// --- Primitives ---
export type Scalar = string | number | boolean;

export type Uid = string;
export type BlockId = Uid;
export type VariableId = Uid;
export type BroadcastId = Uid;
export type CommentId = Uid;

// --- Assets ---
export const COSTUME_FORMATS = ["svg", "png", "jpg", "jpeg", "bmp", "gif"] as const;
export const SOUND_FORMATS = ["wav", "mp3"] as const;

export type CostumeDataFormat = (typeof COSTUME_FORMATS)[number];
export type SoundDataFormat = (typeof SOUND_FORMATS)[number];

export interface Costume {
    name: string;
    assetId: string;
    dataFormat: CostumeDataFormat;
    md5ext?: string;
    bitmapResolution?: number;
    rotationCenterX?: number;
    rotationCenterY?: number;
}

export interface Sound {
    name: string;
    assetId: string;
    dataFormat: SoundDataFormat;
    md5ext?: string;
    rate?: number;
    sampleCount?: number;
}

// --- Lists / Variables / Broadcasts ---
export type VariableEntry =
    | [name: string, value: Scalar]
    | [name: string, value: Scalar, isCloud: true];

export type ListEntry = [name: string, value: Scalar[]];

export type BroadcastMap = Record<BroadcastId, string>;
export type VariableMap = Record<VariableId, VariableEntry>;
export type ListMap = Record<VariableId, ListEntry>;

// --- Block Primitives ---
export const PrimitiveType = {
    MathNum: 4,
    PositiveNum: 5,
    WholeNum: 6,
    IntegerNum: 7,
    Angle: 8,
    Color: 9,
    Text: 10,
    Broadcast: 11,
    Variable: 12,
    List: 13,
} as const;
export type PrimitiveType = (typeof PrimitiveType)[keyof typeof PrimitiveType];

export type NumPrimitive = [type: 4 | 5 | 6 | 7 | 8, value: string | number];
/** #rrggbb */
export type ColorPrimitive = [type: 9, value: string];
export type TextPrimitive = [type: 10, value: string];
export type BroadcastPrimitive = [type: 11, name: string, id: BroadcastId];

export type VariablePrimitive =
    | [type: 12, name: string, id: VariableId]
    | [type: 12, name: string, id: VariableId, x: number, y: number];
export type ListPrimitive =
    | [type: 13, name: string, id: VariableId]
    | [type: 13, name: string, id: VariableId, x: number, y: number];

export type Primitive =
    | NumPrimitive
    | ColorPrimitive
    | TextPrimitive
    | BroadcastPrimitive
    | VariablePrimitive
    | ListPrimitive;

// --- Inputs / Fields ---
/** 1 -> shadow only, 2 -> no shadow (a real block, or empty), 3 -> block obscuring a shadow. */
export type InputShadowState = 1 | 2 | 3;

export type InputSlot = BlockId | Primitive;
 
export type Input =
    | [shadow: 1, value: InputSlot]
    | [shadow: 2, value: InputSlot | null]
    | [shadow: 3, value: InputSlot, obscuredShadow: InputSlot | null];

export type Field = [value: string | null] | [value: string | null, id: Uid | null];

// --- Mutations ---
export interface ProcedureCallMutation {
    tagName: "mutation";
    children: [];
    proccode: string;
    argumentids: string;
    warp: string | boolean;
}
 
export interface ProcedurePrototypeMutation extends ProcedureCallMutation {
    argumentnames: string;
    argumentdefaults: string;
}

export interface StopMutation {
    tagName: "mutation";
    children: [];
    hasnext: string | boolean;
}
 
export type Mutation =
    | ProcedureCallMutation
    | ProcedurePrototypeMutation
    | StopMutation;

// --- Blocks ---
export interface Block {
    opcode: string;
    next: BlockId | null;
    parent: BlockId | null;
    inputs: Record<string, Input>;
    fields: Record<string, Field>;
    shadow: boolean;
    topLevel: boolean;
    x?: number;
    y?: number;
    comment?: CommentId;
    mutation?: Mutation;
}

export type TopLevelPrimitive =
    | [type: 12, name: string, id: VariableId, x: number, y: number]
    | [type: 13, name: string, id: VariableId, x: number, y: number];

export type BlockEntry = Block | TopLevelPrimitive;
export type BlockMap = Record<BlockId, BlockEntry>;

export function isBlock(entry: BlockEntry): entry is Block {
    return !Array.isArray(entry);
}

// --- Comments ---
export interface Comment {
    blockId: BlockId | null;
    x: number;
    y: number;
    width: number;
    height: number;
    minimized: boolean;
    text: string;
}

// --- Targets ---
export type RotationStyle = "all around" | "left-right" | "don't rotate";
export type VideoState = "on" | "off" | "on-flipped";
 
interface TargetBase {
  name: string;
  variables: VariableMap;
  lists: ListMap;
  broadcasts: BroadcastMap;
  blocks: BlockMap;
  comments: Record<CommentId, Comment>;
  currentCostume: number;
  costumes: Costume[];
  sounds: Sound[];
  volume: number;
  layerOrder: number;
}
 
export interface Stage extends TargetBase {
    isStage: true;
    name: "Stage";
    layerOrder: 0;
    tempo: number;
    videoTransparency: number;
    videoState: VideoState;
    textToSpeechLanguage: string | null;
    broadcasts: BroadcastMap;
}
 
export interface Sprite extends TargetBase {
    isStage: false;
    visible: boolean;
    x: number;
    y: number;
    size: number;
    direction: number;
    draggable: boolean;
    rotationStyle: RotationStyle;
}
 
export type Target = Stage | Sprite;

// --- Monitors ---
export type MonitorMode = "default" | "large" | "slider" | "list";
 
export interface Monitor {
    id: string;
    mode: MonitorMode;
    opcode: string;
    params: Record<string, string>;
    /** null for global monitors. */
    spriteName: string | null;
    value: Scalar | Scalar[];
    width: number;
    height: number;
    x: number;
    y: number;
    visible: boolean;
    sliderMin?: number;
    sliderMax?: number;
    isDiscrete?: boolean;
}

// --- Extensions ---
export type KnownExtension =
    | "pen"
    | "music"
    | "text2speech"
    | "translate"
    | "videoSensing"
    | "makeymakey"
    | "microbit"
    | "ev3"
    | "boost"
    | "wedo2"
    | "gdxfor";

export type ExtensionId = KnownExtension | (string & {});

// --- SB3 Project ---
export interface Platform {
  name: string;
  url?: string;
}

export interface Meta {
  semver: string;
  vm: string;
  agent?: string;
  platform?: Platform;
  [key: string]: unknown; // Accept other un-traditional fields.
}

export interface KatnipMeta extends Meta {
  platform: Platform;
  katnip_version: string;
  /** ISO 8601 */
  created: string;
  /** ISO 8601 */
  edited: string;
}

export interface Sb3Project {
    targets: Target[];
    monitors: Monitor[];
    extensions: ExtensionId[];
    meta: KatnipMeta;
}

// --- Presets ---
export function minimalProject(
    now: string = new Date().toISOString(),
    katnipVersion = "0.0.1",
): Sb3Project {
    return {
        targets: [],
        monitors: [],
        extensions: [],
        meta: {
        semver: "3.0.0",
        vm: "0.2.0",
        platform: { name: "Katnip", url: "https://katnip.org/" },
        katnip_version: katnipVersion,
        created: now,
        edited: now,
        },
    };
}
 
export function minimalStage(): Stage {
    return {
        isStage: true,
        name: "Stage",
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [
            {
                name: "backdrop1",
                dataFormat: "svg",
                assetId: "7cd16c437097f6dc4e4c0c4992d76473",
                md5ext: "7cd16c437097f6dc4e4c0c4992d76473.svg",
                rotationCenterX: 240,
                rotationCenterY: 180,
            },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: "on",
        textToSpeechLanguage: null,
    };
}
 
export function minimalSprite(name: string, layerOrder: number): Sprite {
    return {
        isStage: false,
        name,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [
            {
                name: "kartnap",
                bitmapResolution: 1,
                dataFormat: "svg",
                assetId: "7cd16c437097f6dc4e4c0c4992d76473",
                md5ext: "7cd16c437097f6dc4e4c0c4992d76473.svg",
                rotationCenterX: 0,
                rotationCenterY: 0,
            },
        ],
        sounds: [],
        volume: 100,
        layerOrder,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: "all around",
    };
}