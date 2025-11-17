type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
	roomId?: string;
	serverId?: string;
	[key: string]: any;
}

export class Logger {
	private enableDebug: boolean;
	private serverId: string;

	constructor(serverId: string, enableDebug = false) {
		this.serverId = serverId;
		this.enableDebug = enableDebug || process.env.DEBUG_LOGS === 'true';
	}

	private format(
		level: LogLevel,
		message: string,
		context?: LogContext
	): string {
		const timestamp = new Date().toISOString();
		const ctx = context ? ` | ${JSON.stringify(context)}` : '';
		return `[${timestamp}] [${level.toUpperCase()}] [${this.serverId}] ${message}${ctx}`;
	}

	debug(message: string, context?: LogContext) {
		if (this.enableDebug) {
			console.log(this.format('debug', message, context));
		}
	}

	info(message: string, context?: LogContext) {
		console.log(this.format('info', message, context));
	}

	warn(message: string, context?: LogContext) {
		console.warn(this.format('warn', message, context));
	}

	error(message: string, error?: Error | unknown, context?: LogContext) {
		const errorContext =
			error instanceof Error
				? { ...context, error: error.message, stack: error.stack }
				: { ...context, error };
		console.error(this.format('error', message, errorContext));
	}
}
