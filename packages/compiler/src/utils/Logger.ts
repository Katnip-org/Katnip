import pc from "picocolors";

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

    print(log: KatnipLog) {
        if (this.enabled) {
            const formatter = this.formatters[log.type];
            const formattedMessage = formatter(
                `${log.timestamp} - [${log.type}] ${log.message}` +
                (log.location ? ` at line ${log.location.line}, column ${log.location.column}` : "")
            );
            console.log(formattedMessage);
        }
    }

    log(log: KatnipLog) {
        this.logs.push(log);
        this.print(log);
    }

    enable() { this.enabled = true; }
    disable() { this.enabled = false; }
}
