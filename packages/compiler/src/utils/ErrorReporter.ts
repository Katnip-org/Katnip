import { pc } from "./colors.js";

interface KatnipErrorData {
    line: number;
    column: number;
    length?: number;
    endLine?: number;
    endColumn?: number;
}

export class KatnipError extends Error {
    public stackTrace?: string;

    constructor(
        public source: string,      // e.g. "Lexer", "Parser"
        message: string,            // error message
        // Absent for IR/codegen: those run on lowered nodes with no source span.
        public location?: KatnipErrorData,
        captureStack: boolean = true
    ) {
        super(message);
        this.name = "KatnipError";
        // captureStackTrace is V8-only (Node/Chromium); cast avoids erors in other runtimes
        const captureStackTrace = (Error as { captureStackTrace?: (o: object, c?: unknown) => void }).captureStackTrace;
        if (captureStack && captureStackTrace) {
            const err = {} as Error & { stack?: string };
            captureStackTrace(err, KatnipError);
            this.stackTrace = err.stack;
        }
    }
}

export class ErrorReporter {
    private errors: KatnipError[] = [];
    private sourceLines: string[];

    constructor(
        source: string,
        private showStackTrace: boolean = false
    ) {
        this.sourceLines = source.split("\n");
    }

    add(error: KatnipError) {
        this.errors.push(error);
    }

    hasErrors(): boolean {
        return this.errors.length > 0;
    }

    getErrors(): readonly KatnipError[] {
        return this.errors;
    }

    print() {
        for (const err of this.errors) {
            console.error(this.format(err));
        }
    }

    private format(err: KatnipError): string {
        if (!err.location) {
            let output = `${pc.red(pc.bold(`${err.source} Error:`))} ${pc.yellow(err.message)}\n`;
            if (this.showStackTrace && err.stackTrace) {
                output +=
                    `\n${pc.gray("Internal stack trace:")}\n` +
                    pc.gray(this.formatStack(err.stackTrace));
            }
            return output;
        }

        const { line, column, length, endLine, endColumn } = err.location;
        const sourceLine = this.sourceLines[line - 1] || "";
        const gutterWidth = String(this.sourceLines.length).length;

        const lineNumber = pc.gray(line.toString().padStart(gutterWidth, " "));
        const gutter = `${lineNumber} ${pc.gray("|")}`;

        // Carets to draw, clamped so they never run past the visible line.
        const available = Math.max(1, sourceLine.length - (column - 1));
        let caretLen: number;
        if (length != null) {
            caretLen = length;
        } else if (endLine != null && endColumn != null) {
            // Same line -> exact span; spans lines -> underline to end of this line.
            caretLen = endLine === line ? endColumn - column : available;
        } else {
            caretLen = 1;
        }
        caretLen = Math.min(Math.max(1, caretLen), available);

        const underline =
            " ".repeat(column - 1) + pc.red("^".repeat(caretLen));

        let output =
          `${pc.red(pc.bold(`${err.source} Error:`))} ${pc.yellow(err.message)}\n` +
          `  at ${pc.cyan(`line ${line}, column ${column}`)}\n` +
          `  ${" ".repeat(gutterWidth)} ${pc.gray("|")}\n` +
          `  ${gutter} ${pc.white(sourceLine)}\n` +
          `  ${" ".repeat(gutterWidth)} ${pc.gray("|")} ${underline}\n`;

        if (this.showStackTrace && err.stackTrace) {
            output +=
                `\n${pc.gray("Internal stack trace:")}\n` +
                pc.gray(this.formatStack(err.stackTrace));
        }

        return output;
    }

    private formatStack(stack: string): string {
        return stack
            .split("\n")
            .slice(1)
            .filter(line => !line.includes("node_modules"))
            .map(line => `  ${line.trim()}`)
            .join("\n");
    }
}
