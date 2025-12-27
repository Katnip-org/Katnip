import type { Token, TokenInfoFor, TokenPos, TokenType, ValuedToken } from "../lexer/Token.js";

interface BindingPower {
    lbp: number;   // left-binding power
    rbp: number;   // right-binding power
}

export const bindingPowerTable: Record<string, BindingPower> = {
  // logical operators
  "OR": { lbp: 20, rbp: 19 },
  "AND": { lbp: 30, rbp: 29 },
  "NOR": { lbp: 25, rbp: 24 },
  "NAND": { lbp: 25, rbp: 24 },
  "XNOR": { lbp: 25, rbp: 24 },
  "Caret":  { lbp: 25, rbp: 24 },

  // comparison operators
  "EqualsTo": { lbp: 45, rbp: 44 },
  "LeftChevron":  { lbp: 50, rbp: 49 },
  "RightChevron":  { lbp: 50, rbp: 49 },
  "LessThanOrEqualsTo": { lbp: 50, rbp: 49 },
  "GreaterThanOrEqualsTo": { lbp: 50, rbp: 49 },

  // arithmetic operators
  "Plus":  { lbp: 60, rbp: 59 },
  "Minus":  { lbp: 60, rbp: 59 },
  "Asterisk":  { lbp: 70, rbp: 69 },
  "FwdSlash":  { lbp: 70, rbp: 69 },
  "Percent":  { lbp: 70, rbp: 69 },

  // right associative
  "Power": { lbp: 80, rbp: 81 },

  // unary operators
  "Exclamation":  { lbp: 0, rbp: 79 }, // logical not
  "UnaryMinus": { lbp: 0, rbp: 79 }, // unary minus

  // access/call
  "Dot":  { lbp: 100, rbp: 100 }, // member access, non-associative
  "ParenOpen": { lbp: 110, rbp: 110 }, // function call, non-associative
};

export function getBindingPower(token: Token | null): BindingPower {
    if (!token) return { lbp: 0, rbp: 0 };

    const key = token.token.type;
    return bindingPowerTable[key] || { lbp: 0, rbp: 0 };
}