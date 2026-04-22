import { Redis } from 'ioredis';
import { getActiveServers } from '../scripts/redis/getActiveServersScript';
import heartbeatScript from '../scripts/redis/heartbeatScript';
import { safeJsonParse } from '../utils/parseRedisFields';
import pino from 'pino';

const logger = pino({ name: 'HeartbeatService' });

export interface ServerInfo {
	id: string;
	timestamp: number;
	status: 'healthy' | 'unhealthy';
	port: string | number;
	startupTime: number;
}

interface ActiveServersResult {
	activeServers: ServerData[];
	removedServers: ServerData[];
}

interface ServerData {
	id: string;
	timestamp: number;
	port: string;
	status: string;
	startupTime: string;
}

interface config {
	port: number;
	serverId?: string;
	HEARTBEAT_INTERVAL_MS?: number;
	SERVER_TIMEOUT_SECONDS?: number;
}

class HeartbeatService {
	private redis: Redis;
	private static instance: HeartbeatService | null = null;
	private serverId: string;

	private port: number;
	private serverStartupTime: number;
	private heartbeatInterval: NodeJS.Timeout | null = null;

	private HEARTBEAT_INTERVAL_MS: number;
	private SERVER_TIMEOUT_SECONDS: number;
	private ACTIVE_SERVERS_KEY: string;
	private ACTIVE_SERVER_DATA: string;
	private isStarted: boolean = false;

	private constructor(config: config, redisInstanceForCache: Redis) {
		this.redis = redisInstanceForCache;
		this.port = config.port;

		// Server ID priority: process.env.PORT (if set) → config.port (from CLI flag).
		// This allows multiple dev instances sharing the same .env to have unique IDs
		// based on their --port flag. Production should use explicit SERVER_ID env vars.
		const derivedServerId = process.env.PORT
			? `server-${process.env.PORT}`
			: undefined;
		this.serverId = derivedServerId ?? `server-${config.port}`;

		this.serverStartupTime = Date.now();
		this.HEARTBEAT_INTERVAL_MS = config?.HEARTBEAT_INTERVAL_MS ?? 10 * 1000;
		this.SERVER_TIMEOUT_SECONDS = config?.SERVER_TIMEOUT_SECONDS ?? 10;
		this.ACTIVE_SERVERS_KEY = process.env.ACTIVE_SERVERS_KEY!;
		this.ACTIVE_SERVER_DATA = process.env.ACTIVE_SERVER_DATA!;

		// Bind sendHeartbeat so it retains the correct `this` context when
		// passed as a setInterval callback.
		this.sendHeartbeat = this.sendHeartbeat.bind(this);

		logger.info(
			{
				serverId: this.serverId,
				port: this.port,
				heartbeatIntervalMs: this.HEARTBEAT_INTERVAL_MS,
				serverTimeoutSeconds: this.SERVER_TIMEOUT_SECONDS,
			},
			'HeartbeatService instance created',
		);
	}

	/**
	 * Returns the singleton instance of HeartbeatService, creating it on the
	 * first call. Subsequent calls ignore the config argument and return the
	 * existing instance, so always pass a valid config on first use.
	 */
	static getInstance(
		redisInstanceForCache: Redis,
		config: config,
	): HeartbeatService {
		logger.debug({ config }, 'getInstance called');

		if (!HeartbeatService.instance) {
			if (!config) {
				throw new Error(
					'HeartbeatService must be initialized with config on first call',
				);
			}
			HeartbeatService.instance = new HeartbeatService(
				config,
				redisInstanceForCache,
			);
		}
		return HeartbeatService.instance;
	}

	/**
	 * Starts the heartbeat service by sending an immediate heartbeat and then
	 * scheduling subsequent ones at HEARTBEAT_INTERVAL_MS. Throws if the
	 * initial heartbeat fails so the caller can handle startup errors.
	 */
	async start(): Promise<void> {
		try {
			// Send an immediate heartbeat so the server is registered in Redis
			// before the first scheduled interval fires.
			await this.sendHeartbeat();

			this.heartbeatInterval = setInterval(() => {
				this.sendHeartbeat();
			}, this.HEARTBEAT_INTERVAL_MS);

			this.isStarted = true;
			logger.info({ serverId: this.serverId }, 'Heartbeat service started');
		} catch (error) {
			logger.error(
				{ err: error, serverId: this.serverId },
				'Failed to start heartbeat service',
			);
			throw error;
		}
	}

	/**
	 * Writes a heartbeat entry to Redis for this server. Uses a Lua script
	 * (heartbeatScript) to atomically update the sorted set (ACTIVE_SERVERS_KEY)
	 * and hash (ACTIVE_SERVER_DATA) and to clean up stale servers in one round
	 * trip. The sorted set score is the server's startup time so that ordering
	 * is stable across restarts — position stability is required by the
	 * consistent-hash routing algorithm used by consumers of getActiveServers().
	 */
	private async sendHeartbeat() {
		try {
			// Use Unix seconds so the Lua script can compare against Redis TTL-style timestamps.
			const timestamp = Math.floor(Date.now() / 1000);
			const serverInfo: ServerInfo = {
				id: this.serverId,
				timestamp,
				status: 'healthy',
				port: this.port,
				startupTime: this.serverStartupTime,
			};

			const rawResults = (await this.redis.eval(
				heartbeatScript,
				2,
				this.ACTIVE_SERVERS_KEY,
				this.ACTIVE_SERVER_DATA,
				this.serverStartupTime.toString(), // ZADD score — stable sort key
				this.serverId, // ARGV[2] — hash field and set member
				JSON.stringify(serverInfo), // ARGV[3] — server metadata payload
				this.SERVER_TIMEOUT_SECONDS, // ARGV[4] — stale-server cleanup threshold
			)) as string;

			const results = JSON.parse(rawResults);

			logger.debug(
				{ serverId: this.serverId, timestamp, results },
				'Heartbeat sent',
			);

			// TODO: if removedServers is non-empty, fire a Slack alert here.
		} catch (error) {
			logger.error(
				{ err: error, serverId: this.serverId },
				'Failed to send heartbeat',
			);
			return [];
		}
	}

	/**
	 * Queries Redis for all currently active servers and any servers that were
	 * removed since the last check (i.e. those whose heartbeat has expired).
	 * Returns empty arrays if the service has not been started yet.
	 */
	async getActiveServers(): Promise<ActiveServersResult> {
		try {
			if (!this.isStarted) {
				logger.warn(
					{ serverId: this.serverId },
					'getActiveServers called before service started — returning empty result',
				);
				return {
					activeServers: [] as ServerData[],
					removedServers: [] as ServerData[],
				};
			}

			// The Lua script returns a two-element array: [activeServers, removedServers],
			// each being an array of JSON-serialised ServerData strings.
			const rawResults = (await this.redis.eval(
				getActiveServers,
				2,
				this.ACTIVE_SERVERS_KEY,
				this.ACTIVE_SERVER_DATA,
				this.SERVER_TIMEOUT_SECONDS,
			)) as string[][];

			const [activeServers = [], removedServers = []] = rawResults;
			const result = {
				activeServers: activeServers.map((item) =>
					safeJsonParse(item),
				) as ServerData[],
				removedServers: removedServers.map((item) =>
					safeJsonParse(item),
				) as ServerData[],
			};

			logger.debug(
				{
					serverId: this.serverId,
					rawResults,
					activeCount: result.activeServers.length,
					removedCount: result.removedServers.length,
				},
				'Active servers fetched',
			);

			return result;
		} catch (error) {
			logger.error(
				{ err: error, serverId: this.serverId },
				'Failed to get active servers',
			);
			return {
				activeServers: [] as ServerData[],
				removedServers: [] as ServerData[],
			};
		}
	}

	/**
	 * Stops the heartbeat service: clears the interval and removes this server
	 * from the Redis active-server registry so other instances stop routing to it
	 * immediately rather than waiting for the timeout to expire.
	 */
	async stop(): Promise<void> {
		try {
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}

			// Eagerly deregister so peers don't keep routing to a stopped server
			// during the SERVER_TIMEOUT_SECONDS grace window.
			await this.removeServer();

			logger.info({ serverId: this.serverId }, 'Heartbeat service stopped');
		} catch (error) {
			logger.error(
				{ err: error, serverId: this.serverId },
				'Failed to stop heartbeat service',
			);
		}
	}

	/**
	 * Removes this server's entry from both the sorted set and the hash in a
	 * single atomic Lua script execution, then returns the number of servers
	 * still registered.
	 */
	private async removeServer(): Promise<void> {
		try {
			const removeScript = `
				redis.call('ZREM', KEYS[1], ARGV[1])
				redis.call('HDEL', KEYS[2], ARGV[1])
				return redis.call('ZCARD', KEYS[1])
			`;

			const remainingCount = await this.redis.eval(
				removeScript,
				2,
				this.ACTIVE_SERVERS_KEY,
				this.ACTIVE_SERVER_DATA,
				this.serverId,
			);

			logger.info(
				{ serverId: this.serverId, remainingServers: remainingCount },
				'Server removed from active registry',
			);
		} catch (error) {
			logger.error(
				{ err: error, serverId: this.serverId },
				'Failed to remove server from registry',
			);
		}
	}

	/**
	 * Returns a lightweight snapshot of this server's identity for use in
	 * routing decisions or health-check responses.
	 */
	getServerInfo(): { id: string; port: string | number; startupTime: number } {
		return {
			id: this.serverId,
			port: this.port,
			startupTime: this.serverStartupTime,
		};
	}
}

export default HeartbeatService;
