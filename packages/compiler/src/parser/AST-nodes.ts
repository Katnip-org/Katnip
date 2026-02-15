/**
 * @fileoverview Contains all the AST node interfaces for the Katnip parser.
 */

// Base node interfaces 
export interface AST {
    body: StatementNode[];
}

export interface NodeBase {
    type: string;
    loc: SourceLocation;
    comment?: CommentNode;
}

export interface SourceLocation {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

export interface CommentNode {
    type: "Comment";
    loc: SourceLocation;
    content: string;
    isExpanded: boolean;
}

export interface SingleTypeNode extends NodeBase {
    type: "Type";
    typeName: string;
    typeParams?: TypeNode[];
}

export interface UnionTypeNode extends NodeBase {
    type: "UnionType";
    left: TypeNode;
    right: TypeNode;
}

export type TypeNode = SingleTypeNode | UnionTypeNode;

// Procedure nodes 
export interface ProcedureDeclarationNode extends NodeBase {
    type: "ProcedureDeclaration";
    name: string;
    decorators: DecoratorNode[];
    parameters: ParameterNode[];
    returnType: TypeNode | null;
    body: StatementNode[];
}

export interface DecoratorNode extends NodeBase {
    type: "Decorator";
    name: string;
    value: ExpressionNode;
}

export interface ParameterNode extends NodeBase {
    type: "Parameter";
    name: string;
    paramType: TypeNode;
    default?: ExpressionNode;
}

// Enum Nodes 
export interface EnumDeclarationNode extends NodeBase {
    type: "EnumDeclaration";
    name: string;
    members: (string | number)[];
}

// Statement Nodes
export type StatementNode =
  | ExpressionStatementNode
  | VariableDeclarationNode
  | VariableAssignmentNode
  | HandlerStatementNode
  | IfStatementNode
  | WhileStatementNode
  | DoWhileStatementNode
  | ForStatementNode
  | ProcedureDeclarationNode
  | EnumDeclarationNode
  | ErrorStatementNode;

export interface BlockNode extends NodeBase {
    type: "Block";
    body: StatementNode[];
}

export interface BlockStatementBase extends NodeBase {
    body: BlockNode;
}

export interface HandlerStatementNode extends BlockStatementBase {
    type: "HandlerStatement";
    call: CallExpressionNode;
}

export interface ElifClauseNode extends NodeBase {
    type: "ElifClause";
    condition: ExpressionNode;
    block: BlockNode;
}

export interface IfStatementNode extends NodeBase {
    type: "IfStatement";
    condition: ExpressionNode;
    thenBlock: BlockNode;
    elifs: ElifClauseNode[];
    elseBlock: BlockNode | null;
}

export interface WhileStatementNode extends BlockStatementBase {
    type: "WhileStatement";
    condition: ExpressionNode;
}

export interface DoWhileStatementNode extends BlockStatementBase {
    type: "DoWhileStatement";
    condition: ExpressionNode;
}

export interface ForStatementNode extends BlockStatementBase {
    type: "ForStatement";
    pattern: (IdentifierExpressionNode | TupleExpressionNode);
    iterable: ExpressionNode;
}

export interface ExpressionStatementNode extends NodeBase {
    type: "ExpressionStatement";
    expression: ExpressionNode;
}

export enum VariableDeclarationType {
    private = "private",
    public = "public",
    temp = "temp"
}

export interface VariableDeclarationNode extends NodeBase {
    type: "VariableDeclaration";
    access: VariableDeclarationType;
    name: string;
    varType: TypeNode;
    initializer?: ExpressionNode;
}

export interface VariableAssignmentNode extends NodeBase {
    type: "VariableAssignment";
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface ErrorStatementNode extends NodeBase {
    type: "ErrorStatement";
    message: string;
}

// Expression Nodes 
export type ExpressionNode =
  | IdentifierExpressionNode
  | LiteralExpressionNode
  | InterpolatedStringExpressionNode
  | BinaryExpressionNode
  | CallExpressionNode
  | IndexerAccessNode
  | SliceAccessNode
  | UnaryExpressionNode
  | MemberExpressionNode
  | ListExpressionNode
  | DictExpressionNode
  | TupleExpressionNode
  | EmptyExpressionNode
  | ErrorExpressionNode;

export interface IdentifierExpressionNode extends NodeBase {
    type: "Identifier";
    name: string;
}

export interface LiteralExpressionNode extends NodeBase {
    type: "Literal";
    value: string | number | null;
    valueType: "String" | "Number" | "Null";
}

export interface InterpolatedStringExpressionNode extends NodeBase {
    type: "InterpolatedString";
    parts: (string | ExpressionNode)[];
}

export interface BinaryExpressionNode extends NodeBase {
    type: "BinaryExpression";
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface NamedArgumentNode extends NodeBase {
    type: "NamedArgument";
    name: string;
    value: ExpressionNode;
}

export interface CallExpressionNode extends NodeBase {
    type: "CallExpression";
    object: ExpressionNode;
    arguments: (ExpressionNode | NamedArgumentNode)[];
}

export interface IndexerAccessNode extends NodeBase {
    type: "IndexerAccess";
    object: ExpressionNode;
    index: ExpressionNode;
}

export interface SliceAccessNode extends NodeBase {
    type: "SliceAccess";
    object: ExpressionNode;
    start: ExpressionNode;
    end: ExpressionNode;
    step: ExpressionNode | null;
}

export interface UnaryExpressionNode extends NodeBase {
    type: "UnaryExpression";
    operator: string;
    argument: ExpressionNode;
}

export interface MemberExpressionNode extends NodeBase {
    type: "MemberExpression";
    object: ExpressionNode;
    property: IdentifierExpressionNode;
}

export interface ListExpressionNode extends NodeBase {
    type: "ListExpression";
    elements: ExpressionNode[];
}

export interface DictEntryNode {
    key: ExpressionNode;
    value: ExpressionNode;
}

export interface DictExpressionNode extends NodeBase {
    type: "DictExpression";
    entries: DictEntryNode[];
}

export interface TupleExpressionNode extends NodeBase {
    type: "TupleExpression";
    elements: ExpressionNode[];
}

export interface EmptyExpressionNode extends NodeBase {
    type: "EmptyExpression";
}

export interface ErrorExpressionNode extends NodeBase {
    type: "ErrorToken";
    value: string;
}