import type { Token, TokenInfoFor, TokenPos, TokenType, ValuedToken } from "../lexer/Token.js";

interface BindingPower {
    lbp: number;   // left-binding power
    rbp: number;   // right-binding power
}

export const bindingPowerTable: Record<string, BindingPower> = {
  // logical operators
  "||": { lbp: 20, rbp: 19 },
  "&&": { lbp: 30, rbp: 29 },
  "!|": { lbp: 25, rbp: 24 },
  "!&": { lbp: 25, rbp: 24 },
  "!^": { lbp: 25, rbp: 24 },
  "^":  { lbp: 25, rbp: 24 },

  // comparison operators
  "==": { lbp: 45, rbp: 44 },
  "<":  { lbp: 50, rbp: 49 },
  ">":  { lbp: 50, rbp: 49 },
  "<=": { lbp: 50, rbp: 49 },
  ">=": { lbp: 50, rbp: 49 },

  // arithmetic operators
  "+":  { lbp: 60, rbp: 59 },
  "-":  { lbp: 60, rbp: 59 },
  "*":  { lbp: 70, rbp: 69 },
  "/":  { lbp: 70, rbp: 69 },
  "%":  { lbp: 70, rbp: 69 },

  // right associative
  "**": { lbp: 80, rbp: 81 },

  // unary operators
  "!":  { lbp: 0, rbp: 79 },
  "UnaryMinus": { lbp: 0, rbp: 79 }, // unary minus

  // access/call
  ".":  { lbp: 100, rbp: 100 }, // member access, non-associative
  "(": { lbp: 110, rbp: 110 }, // function call, non-associative
  "[": { lbp: 110, rbp: 110 }, // indexing, non-associative
};

export function getBindingPower(token: Token | null): BindingPower {
    if (!token) return { lbp: 0, rbp: 0 };

    const key = token.token.type;
    return bindingPowerTable[key] || { lbp: 0, rbp: 0 };
}
