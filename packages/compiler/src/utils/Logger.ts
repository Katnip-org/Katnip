import { pc } from "./colors.js";

export enum KatnipLogType {
    Info = "INFO",
    Warn = "WARN",
    Error = "ERROR",
    Debug = "DEBUG"
}

export class KatnipLog {
    constructor(
        public type: KatnipLogType,
        public message: string,
        public location?: { line: number; column: number },
        public timestamp: Date = new Date()
    ) {}
}

export class Logger {
    enabled: boolean = false;
    logs: KatnipLog[] = [];

    private formatters: Record<KatnipLogType, (msg: string) => string> = {
        [KatnipLogType.Info]: (msg) => pc.cyan(msg),
        [KatnipLogType.Warn]: (msg) => pc.yellow(msg),
        [KatnipLogType.Error]: (msg) => pc.red(msg),
        [KatnipLogType.Debug]: (msg) => pc.gray(msg)
    };

    private sanitizeForLog(value: any): string {
        if (typeof value === "string") {
            return JSON.stringify(value); // \n and \r etc are escaped
        }
        return String(value);
    }

    print(log: KatnipLog) {
        if (this.enabled) {
            const baseMessage =
                `${log.timestamp} - [${log.type}] ${this.sanitizeForLog(log.message)}` +
                (log.location ? ` at line ${log.location.line}, column ${log.location.column}` : "");
            console.log(this.formatters[log.type](baseMessage));
            this.write(baseMessage);
        }
    }

    protected write(_msg: string): void {}

    log(log: KatnipLog) {
        this.logs.push(log);
        this.print(log);
    }

    enable() { this.enabled = true; }
    disable() { this.enabled = false; }
}
