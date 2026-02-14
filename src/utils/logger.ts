// Logger utility for debugging

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

class Logger {
  private debugMode: boolean = false;
  private prefix: string = '[RaindropSync]';
  private logHistory: LogEntry[] = [];
  private maxHistorySize: number = 100;

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  isDebugMode(): boolean {
    return this.debugMode;
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `${this.prefix} [${timestamp}] [${level.toUpperCase()}] ${message}`;
  }

  private addToHistory(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    this.logHistory.push(entry);

    if (this.logHistory.length > this.maxHistorySize) {
      this.logHistory.shift();
    }
  }

  debug(message: string, data?: unknown): void {
    if (!this.debugMode) return;

    this.addToHistory('debug', message, data);

    if (data !== undefined) {
      console.log(this.formatMessage('debug', message), data);
    } else {
      console.log(this.formatMessage('debug', message));
    }
  }

  info(message: string, data?: unknown): void {
    this.addToHistory('info', message, data);

    if (data !== undefined) {
      console.info(this.formatMessage('info', message), data);
    } else {
      console.info(this.formatMessage('info', message));
    }
  }

  warn(message: string, data?: unknown): void {
    this.addToHistory('warn', message, data);

    if (data !== undefined) {
      console.warn(this.formatMessage('warn', message), data);
    } else {
      console.warn(this.formatMessage('warn', message));
    }
  }

  error(message: string, error?: unknown): void {
    this.addToHistory('error', message, error);

    if (error !== undefined) {
      console.error(this.formatMessage('error', message), error);
    } else {
      console.error(this.formatMessage('error', message));
    }
  }

  getHistory(): LogEntry[] {
    return [...this.logHistory];
  }

  clearHistory(): void {
    this.logHistory = [];
  }
}

export const logger = new Logger();
export default logger;
