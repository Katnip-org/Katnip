import type { Token } from "../lexer/Token.js";

interface BindingPower {
    lbp: number;   // left-binding power
    rbp: number;   // right-binding power
}

export const bindingPowerTable: Record<string, BindingPower> = {
  // logical operators; left associative
  "||": { lbp: 20, rbp: 20 },
  "&&": { lbp: 30, rbp: 30 },
  "!|": { lbp: 25, rbp: 25 },
  "!&": { lbp: 25, rbp: 25 },
  "!^": { lbp: 25, rbp: 25 },
  "^":  { lbp: 25, rbp: 25 },

  // comparison operators
  "==": { lbp: 45, rbp: 45 },
  "<":  { lbp: 50, rbp: 50 },
  ">":  { lbp: 50, rbp: 50 },
  "<=": { lbp: 50, rbp: 50 },
  ">=": { lbp: 50, rbp: 50 },

  // arithmetic operators
  "+":  { lbp: 60, rbp: 60 },
  "-":  { lbp: 60, rbp: 60 },
  "*":  { lbp: 70, rbp: 70 },
  "/":  { lbp: 70, rbp: 70 },
  "%":  { lbp: 70, rbp: 70 },

  // right associative
  "**": { lbp: 80, rbp: 79 },

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
