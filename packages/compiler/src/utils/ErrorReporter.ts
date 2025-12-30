import pc from "picocolors";

interface KatnipErrorData {
    line: number;
    column: number;
    length?: number;
}

export class KatnipError {
    public stackTrace?: string;

    constructor(
        public source: string,      // e.g. "Lexer", "Parser"
        public message: string,     // error message
        public location: KatnipErrorData,
        captureStack: boolean = true
    ) {
        if (captureStack) {
            const err = {} as Error & { stack?: string };
            Error.captureStackTrace(err, KatnipError);
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

    print() {
        for (const err of this.errors) {
            console.error(this.format(err));
        }
    }

    private format(err: KatnipError): string {
        const { line, column, length } = err.location;
        const sourceLine = this.sourceLines[line - 1] || "";
        const gutterWidth = String(this.sourceLines.length).length;

        const lineNumber = pc.gray(line.toString().padStart(gutterWidth, " "));
        const gutter = `${lineNumber} ${pc.gray("|")}`;
        const underline =
            " ".repeat(column - 1) + pc.red("^".repeat(length || 1));

        let output =
            `${pc.red(pc.bold(`${err.source} Error:`))} ${pc.yellow(err.message)}\n` +
            `  at ${pc.cyan(`line ${line}, column ${column}`)}\n\n` +
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
