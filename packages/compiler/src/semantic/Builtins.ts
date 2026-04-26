/**
 * @fileoverview Built-in namespace and function signatures for semantic type resolution.
 * Add new namespaces/functions here - the semantic analyzer picks them up automatically.
 *
 * Type helpers:
 *   T.num, T.str, T.bool, T.void - primitives
 *   T.list(elem) - list<elem>
 *   T.dict(key, val) - dict<key, val>
 *   T.tuple(a, b, ...) - tuple of elements
 *   T.tv("T") - generic type variable named T
 *
 * Member helpers:
 *   fn(sig, ...) - callable member (one or more overloads)
 *   val(type) - value member (property access, e.g. const.pi)
 *   ns({ ... }) - nested namespace (e.g. motion.x)
 *   valns(type, { ... }) - value member with nested namespace (e.g. motion.x.set)
 *   p(name, type) - parameter in a function signature
 */

import type { InternalType } from "./InternalType.js";

// -- Interfaces --

export interface BuiltinParam {
    name: string;
    type: InternalType;
}

export interface BuiltinFunctionSignature {
    params: BuiltinParam[];
    returnType: InternalType;
}

export type BuiltinMember =
    | { kind: "value";     type: InternalType; members?: BuiltinNamespace }
    | { kind: "function";  overloads: BuiltinFunctionSignature[] }
    | { kind: "namespace"; members: BuiltinNamespace }

export type BuiltinNamespace = Record<string, BuiltinMember>;

export interface BuiltinFunction {
    overloads: BuiltinFunctionSignature[];
}

// -- Types --

const T = {
    num: { kind: "primitive", name: "num"  } as InternalType,
    str: { kind: "primitive", name: "str"  } as InternalType,
    bool: { kind: "primitive", name: "bool" } as InternalType,
    void: { kind: "primitive", name: "void" } as InternalType,
    list: (element: InternalType): InternalType => ({ kind: "list", element }),
    dict: (key: InternalType, value: InternalType): InternalType => ({ kind: "dict", key, value }),
    tuple: (...elements: InternalType[]): InternalType => ({ kind: "tuple", elements }),
    tv: (name: string): InternalType => ({ kind: "typevar", name }),
    oneOf: (...values: (string | number)[]): InternalType => {
        if (values.length === 0) throw new Error("oneOf() requires at least one value");
        return values.slice(1).reduce<InternalType>(
            (acc, v) => ({ kind: "union", left: acc, right: { kind: "literal", value: v } }),
            { kind: "literal", value: values[0] }
        );
    },
};

// -- Members --

const fn = (...overloads: BuiltinFunctionSignature[]): BuiltinMember => ({ kind: "function", overloads });
const val = (type: InternalType): BuiltinMember => ({ kind: "value", type });
const valns = (type: InternalType, members: BuiltinNamespace): BuiltinMember => ({ kind: "value", type, members });
const ns = (members: BuiltinNamespace): BuiltinMember => ({ kind: "namespace", members });
const p = (name: string, type: InternalType): BuiltinParam => ({ name, type });

// -- Built-ins --

export const builtinFunctions: Record<string, BuiltinFunction> = {
    range: { overloads: [
        { params: [p("end", T.num)], returnType: T.list(T.num) },
        { params: [p("start", T.num), p("end", T.num)], returnType: T.list(T.num) },
        { params: [p("start", T.num), p("end", T.num), p("step", T.num)], returnType: T.list(T.num) },
    ]},
    enumerate: { overloads: [
        { params: [p("iterable", T.list(T.tv("T")))], returnType: T.list(T.tuple(T.num, T.tv("T"))) },
    ]},
};

// -- Namespaces/general functions --

export const builtinValues: Record<string, InternalType> = {
    true: { kind: "primitive", name: "bool" },
    false: { kind: "primitive", name: "bool" },
};

// Methods available on typed variables, keys are InternalType kind.
// "T" typevar resolves to the list's element type at call sites.
export const typeMethods: Record<string, BuiltinNamespace> = {
    list: {
        length: fn({ params: [], returnType: T.num }),
        contains: fn({ params: [p("item", T.tv("T"))], returnType: T.bool }),
        indexOf: fn({ params: [p("item", T.tv("T"))], returnType: T.num }),
        get: fn({ params: [p("index", T.num)], returnType: T.tv("T") }),
        push: fn({ params: [p("item", T.tv("T"))], returnType: T.void }),
        insert: fn({ params: [p("index", T.num), p("item", T.tv("T"))], returnType: T.void }),
        remove: fn({ params: [p("index", T.num)], returnType: T.void }),
        clear: fn({ params: [], returnType: T.void }),
        set: fn({ params: [p("index", T.num), p("item", T.tv("T"))], returnType: T.void }),
        show: fn({ params: [], returnType: T.void }),
        hide: fn({ params: [], returnType: T.void }),
    },
    str: {
        length: fn({ params: [], returnType: T.num }),
        contains: fn({ params: [p("substring", T.str)], returnType: T.bool }),
        charAt: fn({ params: [p("index", T.num)], returnType: T.str }),
        join: fn({ params: [p("other", T.str)], returnType: T.str }),
    },
};

export const builtinNamespaces: Record<string, BuiltinNamespace> = {
    console: {
        breakpoint: fn({ params: [], returnType: T.void }),
        log: fn({ params: [p("value", T.str)], returnType: T.void }),
        warn: fn({ params: [p("value", T.str)], returnType: T.void }),
        error: fn({ params: [p("value", T.str)], returnType: T.void }),
        
        timer: ns({
            start: fn({ params: [p("name", T.str)], returnType: T.void }),
            stop: fn({ params: [p("name", T.str)], returnType: T.void }),
        })
    },

    const: {
        pi: val(T.num),
        e: val(T.num),
        tau: val(T.num),
        newline: val(T.str),
        true: val(T.bool),
        false: val(T.bool),
    },

    math: {
        pow: fn({ params: [p("base", T.num), p("exp", T.num)], returnType: T.num }),
        abs: fn({ params: [p("value", T.num)], returnType: T.num }),
        floor: fn({ params: [p("value", T.num)], returnType: T.num }),
        ceiling: fn({ params: [p("value", T.num)], returnType: T.num }),
        sqrt: fn({ params: [p("value", T.num)], returnType: T.num }),
        sin: fn({ params: [p("angle", T.num)], returnType: T.num }),
        cos: fn({ params: [p("angle", T.num)], returnType: T.num }),
        tan: fn({ params: [p("angle", T.num)], returnType: T.num }),
        asin: fn({ params: [p("value", T.num)], returnType: T.num }),
        acos: fn({ params: [p("value", T.num)], returnType: T.num }),
        atan: fn({ params: [p("value", T.num)], returnType: T.num }),
        ln: fn({ params: [p("value", T.num)], returnType: T.num }),
        log: fn({ params: [p("value", T.num)], returnType: T.num }),
        powE: fn({ params: [p("value", T.num)], returnType: T.num }),
        pow10: fn({ params: [p("value", T.num)], returnType: T.num }),
    },

    motion: {
        move: fn({ params: [p("steps", T.num)], returnType: T.void }),
        forward: fn({ params: [p("steps", T.num)], returnType: T.void }),
        turn: fn({ params: [p("degrees", T.num)], returnType: T.void }),
        
        goTo: fn({ params: [p("target", T.str)], returnType: T.void }),
        goToXY: fn({ params: [p("x", T.num), p("y", T.num)], returnType: T.void }),
        glideTo: fn({ params: [p("target", T.str), p("seconds", T.num)], returnType: T.void }),
        glideToXY: fn({ params: [p("x", T.num), p("y", T.num), p("seconds", T.num)], returnType: T.void }),
        
        changeX: fn({ params: [p("dx", T.num)], returnType: T.void }),
        changeY: fn({ params: [p("dy", T.num)], returnType: T.void }),

        ifOnEdgeBounce: fn({ params: [], returnType: T.void }),
        setRotationStyle: fn({ params: [p("style", T.oneOf("left-right", "don't rotate", "all around"))], returnType: T.void }),

        getPosition: fn({ params: [], returnType: T.tuple(T.num, T.num) }),
        x: valns(T.num, {
            set: fn({ params: [p("value", T.num)], returnType: T.void }),
            change: fn({ params: [p("value", T.num)], returnType: T.void }),
        }),
        y: valns(T.num, {
            set: fn({ params: [p("value", T.num)], returnType: T.void }),
            change: fn({ params: [p("value", T.num)], returnType: T.void }),
        }),
    },

    looks: {
        say: fn({ params: [p("message", T.str)], returnType: T.void }),
        timedSay: fn({ params: [p("message", T.str), p("seconds", T.num)], returnType: T.void }),
        think: fn({ params: [p("message", T.str)], returnType: T.void }),
        timedThink: fn({ params: [p("message", T.str), p("seconds", T.num)], returnType: T.void }),

        switchCostume: fn({ params: [p("costume", T.str)], returnType: T.void }),
        nextCostume: fn({ params: [], returnType: T.void }),
        switchBackdrop: fn({ params: [p("backdrop", T.str)], returnType: T.void }),
        nextBackdrop: fn({ params: [], returnType: T.void }),

        changeSize: fn({ params: [p("percent", T.num)], returnType: T.void }),
        setSize: fn({ params: [p("percent", T.num)], returnType: T.void }),

        effects: ns({
            set: fn({ params: [p("effect", T.str), p("value", T.num)], returnType: T.void }),
            change: fn({ params: [p("effect", T.str), p("value", T.num)], returnType: T.void }),
            clear: fn({ params: [], returnType: T.void }),
        }),

        show: fn({ params: [], returnType: T.void }),
        hide: fn({ params: [], returnType: T.void }),

        layer: valns(T.num, {
            goTo: fn({ params: [p("layer", T.oneOf("front", "back"))], returnType: T.void }),
            change: fn({ params: [p("layers", T.num)], returnType: T.void }),
        }),

        costume: ns({
            name: fn({ params: [], returnType: T.str }),
            number: fn({ params: [], returnType: T.num }),
        }),

        backdrop: ns({
            name: fn({ params: [], returnType: T.str }),
            number: fn({ params: [], returnType: T.num }),
        }),

        size: fn({ params: [], returnType: T.num }),
    },

    sounds: {
        play: fn({ params: [p("sound", T.str)], returnType: T.void }),
        playUntilDone: fn({ params: [p("sound", T.str)], returnType: T.void }),
        stop: fn({ params: [], returnType: T.void }),

        effects: ns({
            set: fn({ params: [p("effect", T.str), p("value", T.num)], returnType: T.void }),
            change: fn({ params: [p("effect", T.str), p("value", T.num)], returnType: T.void }),
            clear: fn({ params: [], returnType: T.void }),
        }),

        volume: valns(T.num, {
            set: fn({ params: [p("volume", T.num)], returnType: T.void }),
            change: fn({ params: [p("volume", T.num)], returnType: T.void }),
        })
    },

    control: {
        wait: fn({ params: [p("seconds", T.num)], returnType: T.void }),
        waitUntil: fn({ params: [p("condition", T.bool)], returnType: T.void }),
        stop: fn({ params: [p("option", T.oneOf("all", "this script", "other scripts in sprite"))], returnType: T.void }),

        clone: ns({
            create: fn({ params: [], returnType: T.void }),
            createOf: fn({ params: [p("sprite", T.str)], returnType: T.void }),
            delete: fn({ params: [], returnType: T.void }),
        })
    },

    sensing: {
        isTouching: fn({ params: [p("target", T.str)], returnType: T.bool }),
        isTouchingColor: fn({ params: [p("color", T.num)], returnType: T.bool }),
        isTouchingEdge: fn({ params: [], returnType: T.bool }),
        distanceTo: fn({ params: [p("target", T.str)], returnType: T.num }),
        
        ask: fn({ params: [p("question", T.str)], returnType: T.str }), // [NOTE] technically returns nothing, having an "answer" variable but we treat it as a function for simplicity
        answer: fn({ params: [], returnType: T.str }),

        isKeyPressed: fn({ params: [p("key", T.str)], returnType: T.bool }),

        mouse: ns({
            x: fn({ params: [], returnType: T.num }),
            y: fn({ params: [], returnType: T.num }),
            down: fn({ params: [], returnType: T.bool }),
        }),

        setDragMode: fn({ params: [p("mode", T.oneOf("draggable", "not draggable"))], returnType: T.void }),

        loudness: fn({ params: [], returnType: T.num }),
        timer: valns(T.num, {
            reset: fn({ params: [], returnType: T.void }),
        }),

        getAttr: fn(
            { params: [p("attr", T.oneOf("x position", "y position", "direction", "costume #", "size", "volume", "backdrop #")), p("target", T.str)], returnType: T.num },
            { params: [p("attr", T.oneOf("costume name", "backdrop name")), p("target", T.str)], returnType: T.str },
        ),

        time: ns({
            get: fn(
                { params: [p("timeType", T.oneOf("year", "month", "date", "day of week", "hour", "minute", "second"))], returnType: T.num },
            ),
            daysSince2000: fn({ params: [], returnType: T.num }),
        }),

        isOnline: fn({ params: [], returnType: T.bool }),
        username: fn({ params: [], returnType: T.str}),
    },

    op: {
        letter: fn({ params: [p("index", T.num), p("string", T.str)], returnType: T.str }),
        length: fn({ params: [p("string", T.str)], returnType: T.num }),
        contains: fn({ params: [p("string", T.str), p("substring", T.str)], returnType: T.bool }),
        round: fn({ params: [p("value", T.num)], returnType: T.num }),
    },

    pen: {
        clear: fn({ params: [], returnType: T.void }),
        stamp: fn({ params: [], returnType: T.void }),
        down: fn({ params: [], returnType: T.void }),
        up: fn({ params: [], returnType: T.void }),

        setHex: fn({ params: [p("color", T.num)], returnType: T.void }),

        setAttr: fn({ params: [p("attr", T.oneOf("color", "saturation", "brightness", "transparency", "size")), p("value", T.num)], returnType: T.void }),
        changeAttr: fn({ params: [p("attr", T.oneOf("color", "saturation", "brightness", "transparency", "size")), p("value", T.num)], returnType: T.void }),
    },
};
