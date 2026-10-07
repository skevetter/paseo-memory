export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LogLevel = keyof Logger;

export function formatLine(level: LogLevel, tag: string, message: string): string {
  return `${level} [${tag}] ${message}\n`;
}

export function createLogger(tag: string): Logger {
  return {
    info: (message) => process.stdout.write(formatLine("info", tag, message)),
    warn: (message) => process.stderr.write(formatLine("warn", tag, message)),
    error: (message) => process.stderr.write(formatLine("error", tag, message)),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const LINE = /^(info|warn|error) (?:\[[\w-]+\] )?(.*)$/s;

export function parseLine(line: string, fallback: LogLevel): { level: LogLevel; message: string } {
  const match = LINE.exec(line);
  const level = match?.[1];
  if (level === "info" || level === "warn" || level === "error") return { level, message: match?.[2] ?? "" };
  return { level: fallback, message: line };
}
