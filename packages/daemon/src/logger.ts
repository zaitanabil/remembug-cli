/**
 * Tiny append-only logger.
 *
 * Two destinations:
 *   - `daemon.log` for the orchestration pipeline (span resolved, draft
 *     outcome, errors)
 *   - `scrubber.log` for redaction counts (types only, never values)
 *
 * Level is controlled by `REMEMBUG_LOG=info|debug` (default: info). Every
 * line is one JSON object so the file is grep-friendly without being
 * fragile to commas in messages.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  logsDir: string;
  level?: LogLevel;
}

export class Logger {
  private readonly logsDir: string;
  private readonly minLevel: number;

  constructor(options: LoggerOptions) {
    this.logsDir = options.logsDir;
    const envLevel = (process.env.REMEMBUG_LOG as LogLevel | undefined) ?? options.level ?? 'info';
    this.minLevel = LEVELS[envLevel] ?? LEVELS.info;
    mkdirSync(this.logsDir, { recursive: true });
  }

  daemon(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    this.write('daemon.log', level, message, fields);
  }

  scrubber(message: string, fields: Record<string, unknown> = {}): void {
    this.write('scrubber.log', 'info', message, fields);
  }

  private write(
    file: 'daemon.log' | 'scrubber.log',
    level: LogLevel,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < this.minLevel) return;
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...fields,
      }) + '\n';
    try {
      appendFileSync(join(this.logsDir, file), line);
    } catch {
      // Logging must never crash the daemon.
    }
  }
}
