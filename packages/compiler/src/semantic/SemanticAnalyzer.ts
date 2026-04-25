/**
 * @fileoverview Contains the semantic analysis logic for the Katnip compiler, including type checking and symbol resolution.
 */

import type { ExpressionNode } from "../parser/AST-nodes.js";
import type { Scope, ScopeEntry } from "./SymbolTable.js";

class SemanticAnalyzer {
    globalScope: Scope = {};
    spriteScope: Scope = {};

    resolveType(node: ExpressionNode): String {
        switch (node.type) {
            case "Literal": return node.valueType
            case "InterpolatedString": return "String"
            case "BinaryExpression":
                const type1: String = this.resolveType(node.left);
                const type2: String = this.resolveType(node.right);
                if (type1 === type2) {
                    return type1;
                } else {
                    return ""; // ERROR
                }
            case "CallExpression":
                // Check for registered procedure
                return "";
            case "IndexerAccess":
                // Check for registered object
                return "";
            case "SliceAccess":
                // Check for registered object
                return "";
            case "UnaryExpression":
                // Make sure type is of int
                return "";
            case "MemberExpression":
                // Check for registered object
                return "";
            case "ListExpression":
                const listType: String = this.resolveType(node.elements[0]);
                const sameList: Boolean = node.elements.every(item => this.resolveType(item) === listType)

                if (sameList) {
                    return `List<${listType}>`;
                } else {
                    return ""; // ERROR
                }
            case "DictExpression":
                const keyType: String = this.resolveType(node.entries[0].key);
                const valueType: String = this.resolveType(node.entries[0].value);
                const sameDict: Boolean = node.entries.every(item => this.resolveType(item.key) === keyType && this.resolveType(item.value) === valueType);

                if (sameDict) {
                    return `Dict<${keyType},${valueType}>`
                } else {
                    return ""; // ERROR
                }
            case "TupleExpression":
                const tupleType: String = node.elements.map(item => this.resolveType(item)).join(",");
                return tupleType ?? "";
            case "EmptyExpression":
                return ""; // dont error
            case "ErrorToken":
                return ""; // ERROR
            default:
                return ""; // ERROR
        }
    }
}