/**
 * @fileoverview Scratch wiring metadata for every opcode the compiler emits.
 * Slots are listed in .knip param order (including `self`); maps by param index;
 * Slot kinds mirror sb3 file structure:
 *  - input: any expression. `prim` is the shadow code under literals and overlaid reporters (4 num, 6 whole, 7 posint, 8 angle, 9 color, 10 str); omitted = boolean input, no shadow.
 *  - broadcast: input holding the [11, name, id] primitive; codegen must also register the name in the target's broadcasts map.
 *  - field: compile-time constant baked into the block. `ref` marks fields serialized as [name, id] into a target registry (variables/lists/broadcasts) instead of [value, null].
 *  - menu: input holding a shadow menu block; enum literals become the shadow's field value, dynamic expressions become a reporter over the shadow ([3, reporter, shadow]) with `default` left in the shadow.
 */

import type { ColorPrimitive, NumPrimitive, TextPrimitive } from "./SB3TypeDefs.js";

export type ShadowPrimitiveType = (NumPrimitive | ColorPrimitive | TextPrimitive)[0];

export type Slot =
    | { kind: "input"; name: string; prim?: ShadowPrimitiveType }
    | { kind: "broadcast"; name: string }
    | { kind: "field"; name: string; ref?: "variable" | "list" | "broadcast" }
    | { kind: "menu"; name: string; menuOpcode: string; menuField: string; default: string };

const input = (name: string, prim?: ShadowPrimitiveType): Slot => ({ kind: "input", name, prim });
const broadcast = (name: string): Slot => ({ kind: "broadcast", name });
const field = (name: string, ref?: "variable" | "list" | "broadcast"): Slot => ({ kind: "field", name, ref });
const menu = (name: string, menuOpcode: string, menuField: string, def: string): Slot =>
    ({ kind: "menu", name, menuOpcode, menuField, default: def });

export const opcodeSlots: Record<string, Slot[]> = {
    // events / control
    event_whenflagclicked: [],
    event_whenkeypressed: [field("KEY_OPTION")],
    event_whenthisspriteclicked: [],
    event_whenbackdropswitchesto: [field("BACKDROP")],
    event_whengreaterthan: [field("WHENGREATERTHANMENU"), input("VALUE", 4)],
    event_whenbroadcastreceived: [field("BROADCAST_OPTION", "broadcast")],
    event_broadcast: [broadcast("BROADCAST_INPUT")],
    event_broadcastandwait: [broadcast("BROADCAST_INPUT")],
    control_start_as_clone: [],
    control_create_clone_of: [menu("CLONE_OPTION", "control_create_clone_of_menu", "CLONE_OPTION", "_myself_")],
    control_delete_this_clone: [],
    control_wait: [input("DURATION", 4)],
    control_stop: [field("STOP_OPTION")],

    // motion
    motion_movesteps: [input("STEPS", 4)],
    motion_turnright: [input("DEGREES", 4)],
    motion_goto: [menu("TO", "motion_goto_menu", "TO", "_random_")],
    motion_gotoxy: [input("X", 4), input("Y", 4)],
    motion_glideto: [input("SECS", 4), menu("TO", "motion_glideto_menu", "TO", "_random_")],
    motion_glidesecstoxy: [input("SECS", 4), input("X", 4), input("Y", 4)],
    motion_pointindirection: [input("DIRECTION", 8)],
    motion_pointtowards: [menu("TOWARDS", "motion_pointtowards_menu", "TOWARDS", "_mouse_")],
    motion_changexby: [input("DX", 4)],
    motion_setx: [input("X", 4)],
    motion_changeyby: [input("DY", 4)],
    motion_sety: [input("Y", 4)],
    motion_ifonedgebounce: [],
    motion_setrotationstyle: [field("STYLE")],
    motion_xposition: [],
    motion_yposition: [],

    // looks
    looks_say: [input("MESSAGE", 10)],
    looks_sayforsecs: [input("MESSAGE", 10), input("SECS", 4)],
    looks_think: [input("MESSAGE", 10)],
    looks_thinkforsecs: [input("MESSAGE", 10), input("SECS", 4)],
    // costume/backdrop menu defaults are project-specific; codegen should swap in a real name
    looks_switchcostumeto: [menu("COSTUME", "looks_costume", "COSTUME", "costume1")],
    looks_nextcostume: [],
    looks_switchbackdropto: [menu("BACKDROP", "looks_backdrops", "BACKDROP", "backdrop1")],
    looks_nextbackdrop: [],
    looks_changesizeby: [input("CHANGE", 4)],
    looks_setsizeto: [input("SIZE", 4)],
    looks_changeeffectby: [field("EFFECT"), input("CHANGE", 4)],
    looks_seteffectto: [field("EFFECT"), input("VALUE", 4)],
    looks_cleargraphiceffects: [],
    looks_show: [],
    looks_hide: [],
    looks_gotofrontback: [field("FRONT_BACK")],
    looks_goforwardbackwardlayers: [field("FORWARD_BACKWARD"), input("NUM", 7)],
    looks_costumenumbername: [field("NUMBER_NAME")],
    looks_backdropnumbername: [field("NUMBER_NAME")],
    looks_size: [],

    // sensing
    sensing_touchingobject: [menu("TOUCHINGOBJECTMENU", "sensing_touchingobjectmenu", "TOUCHINGOBJECTMENU", "_mouse_")],
    sensing_touchingcolor: [input("COLOR", 9)],
    sensing_coloristouchingcolor: [input("COLOR", 9), input("COLOR2", 9)],
    sensing_distanceto: [menu("DISTANCETOMENU", "sensing_distancetomenu", "DISTANCETOMENU", "_mouse_")],
    sensing_askandwait: [input("QUESTION", 10)],
    sensing_answer: [],
    sensing_keypressed: [menu("KEY_OPTION", "sensing_keyoptions", "KEY_OPTION", "space")],
    sensing_mousedown: [],
    sensing_mousex: [],
    sensing_mousey: [],
    sensing_setdragmode: [field("DRAG_MODE")],
    sensing_loudness: [],
    sensing_timer: [],
    sensing_resettimer: [],
    sensing_of: [field("PROPERTY"), menu("OBJECT", "sensing_of_object_menu", "OBJECT", "_stage_")],
    sensing_current: [field("CURRENTMENU")],
    sensing_dayssince2000: [],
    sensing_online: [],
    sensing_username: [],

    // operators (emitted by IR lowering of Katnip operators)
    operator_add: [input("NUM1", 4), input("NUM2", 4)],
    operator_subtract: [input("NUM1", 4), input("NUM2", 4)],
    operator_multiply: [input("NUM1", 4), input("NUM2", 4)],
    operator_divide: [input("NUM1", 4), input("NUM2", 4)],
    operator_mod: [input("NUM1", 4), input("NUM2", 4)],
    operator_random: [input("FROM", 4), input("TO", 4)],
    operator_gt: [input("OPERAND1", 10), input("OPERAND2", 10)],
    operator_lt: [input("OPERAND1", 10), input("OPERAND2", 10)],
    operator_equals: [input("OPERAND1", 10), input("OPERAND2", 10)],
    operator_and: [input("OPERAND1"), input("OPERAND2")],
    operator_or: [input("OPERAND1"), input("OPERAND2")],
    operator_not: [input("OPERAND")],
    operator_join: [input("STRING1", 10), input("STRING2", 10)],
    operator_letter_of: [input("LETTER", 6), input("STRING", 10)],
    operator_length: [input("STRING", 10)],
    operator_contains: [input("STRING1", 10), input("STRING2", 10)],
    operator_round: [input("NUM", 4)],
    operator_mathop: [field("OPERATOR"), input("NUM", 4)],

    // variables / lists (fields hold the var/list name)
    data_setvariableto: [field("VARIABLE", "variable"), input("VALUE", 10)],
    data_changevariableby: [field("VARIABLE", "variable"), input("VALUE", 4)],
    data_showvariable: [field("VARIABLE", "variable")],
    data_hidevariable: [field("VARIABLE", "variable")],
    data_addtolist: [field("LIST", "list"), input("ITEM", 10)],
    data_deleteoflist: [field("LIST", "list"), input("INDEX", 7)],
    data_deletealloflist: [field("LIST", "list")],
    data_insertatlist: [field("LIST", "list"), input("ITEM", 10), input("INDEX", 7)],
    data_replaceitemoflist: [field("LIST", "list"), input("INDEX", 7), input("ITEM", 10)],
    data_itemoflist: [field("LIST", "list"), input("INDEX", 7)],
    data_itemnumoflist: [field("LIST", "list"), input("ITEM", 10)],
    data_lengthoflist: [field("LIST", "list")],
    data_listcontainsitem: [field("LIST", "list"), input("ITEM", 10)],
    data_showlist: [field("LIST", "list")],
    data_hidelist: [field("LIST", "list")],

    // pen
    pen_penDown: [],
    pen_penUp: [],
    pen_clear: [],
    pen_stamp: [],
    pen_setPenColorToColor: [input("COLOR", 9)],
    pen_setPenColorParamTo: [menu("COLOR_PARAM", "pen_menu_colorParam", "colorParam", "color"), input("VALUE", 4)],
    pen_changePenColorParamBy: [menu("COLOR_PARAM", "pen_menu_colorParam", "colorParam", "color"), input("VALUE", 4)],
    pen_setPenSizeTo: [input("SIZE", 4)],
    pen_changePenSizeBy: [input("SIZE", 4)],
};

/**
 * Opcodes that report a boolean, so their block is hexagonal.
 * A boolean input only accepts these shapes; anything round has to be compared against "true" first, 
 * or the editor rejects the connection outright.
 */
export const booleanOpcodes = new Set([
    "operator_gt",
    "operator_lt",
    "operator_equals",
    "operator_and",
    "operator_or",
    "operator_not",
    "operator_contains",
    "data_listcontainsitem",
    "sensing_touchingobject",
    "sensing_touchingcolor",
    "sensing_coloristouchingcolor",
    "sensing_keypressed",
    "sensing_mousedown",
    "sensing_online",
]);
