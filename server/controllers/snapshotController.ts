import Redis from 'ioredis';
import HeartbeatService from '../services/heartBeatService';
import { REDIS_KEYS } from '../constants/redisConstants';
import { BatchProcessingConfig, BatchProcessingInput } from '../types';
import { RoomResponsibilityService } from '../services/snapshotServices/roomResponsibilityService';
import { SnapshotDataService } from '../services/snapshotServices/snapshotDataService';
import { SnapshotPersistenceService } from '../services/snapshotServices/snapshotPersistenceService';
import RoomLockManager from '../managers/roomLockManager';
import logger from '../utils/logger';

class SnapshotController {
	private readonly config: BatchProcessingConfig;
	private heartBeatService: HeartbeatService;
	private redis: Redis;
	private serverId: string;
	private snapshotTimer: NodeJS.Timeout | null;
	private lockService: RoomLockManager;
	private responsibilityService: RoomResponsibilityService;
	private dataService: SnapshotDataService;
	private persistenceService: SnapshotPersistenceService;

	constructor(
		PORT: number,
		config: BatchProcessingInput,
		heartBeatService: HeartbeatService,
		redis: Redis,
	) {
		this.redis = redis;

		const derivedServerId = process.env.PORT
			? `server-${process.env.PORT}`
			: `server-${PORT}`;
		this.serverId = derivedServerId;

		this.heartBeatService = heartBeatService;
		this.snapshotTimer = null;

		this.config = {
			strokeCountThreshold: 100,
			timeoutMs: 3000,
			...config,
		};

		this.lockService = new RoomLockManager(redis, this.serverId);
		this.responsibilityService = new RoomResponsibilityService(
			heartBeatService,
			this.serverId,
		);
		this.dataService = new SnapshotDataService(redis);
		this.persistenceService = new SnapshotPersistenceService(redis);
	}

	public async start(): Promise<void> {
		const log = logger.child({ serverId: this.serverId, method: 'start' });

		this.snapshotTimer = setInterval(() => this.createSnapshots(), 2000);
		await this.createSnapshots();
		log.info('Snapshot controller started');
	}

	public async stop(): Promise<void> {
		const log = logger.child({ serverId: this.serverId, method: 'stop' });

		if (this.snapshotTimer) {
			clearInterval(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		log.info('Snapshot controller stopped');
	}

	private async createSnapshots(): Promise<void> {
		const log = logger.child({
			serverId: this.serverId,
			method: 'createSnapshots',
		});

		try {
			const activeRooms = await this.getActiveRoomIds();

			if (activeRooms.length > 0) {
				log.info({ activeRooms: activeRooms }, 'Processing active rooms');
			}

			for (const roomId of activeRooms) {
				await this.processRoom(roomId);
			}
		} catch (error) {
			log.error({ error }, 'Error in createSnapshots');
		}
	}

	private async processRoom(roomId: string): Promise<void> {
		const log = logger.child({
			serverId: this.serverId,
			roomId,
			method: 'processRoom',
		});
		const maxRetries = 3;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const ACTIVE_SERVERS_KEY = process.env.ACTIVE_SERVERS_KEY!;
				const ACTIVE_SERVER_DATA = process.env.ACTIVE_SERVER_DATA!;
				await this.redis.watch(ACTIVE_SERVERS_KEY, ACTIVE_SERVER_DATA);

				const isResponsible =
					await this.responsibilityService.isResponsibleFor(roomId);

				if (!isResponsible) {
					await this.redis.unwatch();
					return;
				}

				log.debug('Server is responsible for room');

				const lockResult = await this.lockService.acquireLock(roomId);

				if (!lockResult) {
					log.debug('Failed to acquire lock');
					return;
				}
				log.debug(
					{ lockResult, roomId, server: this.serverId },
					'lock acquired',
				);
				const { lockValue } = lockResult;

				await this.handleSnapshot(roomId, lockValue);
				return;
			} catch (error) {
				log.error({ attempt, error }, `Process room attempt ${attempt} failed`);
				await this.redis.unwatch();

				if (attempt === maxRetries) {
					log.error(
						{ attempt: maxRetries, error },
						`Failed to process room after ${maxRetries} attempts`,
					);
				}
			}
		}
	}

	private async handleSnapshot(
		roomId: string,
		lockValue: string,
	): Promise<void> {
		const log = logger.child({
			serverId: this.serverId,
			roomId,
			method: 'handleSnapshot',
		});

		try {
			const { inflightData, persistedData, persistedKeys } =
				await this.dataService.getRoomData(roomId);

			if (inflightData.length === 0 && persistedData.length === 0) {
				await this.removeFromActiveRooms(roomId);
				log.warn('No data found for room, removed from active rooms');
				return;
			}

			const allData = [...inflightData, ...persistedData];
			const sortedData = this.dataService.orderStrokesPackages(allData);

			log.info({ eventCount: sortedData.length }, 'Persisting snapshot');

			await this.persistenceService.persistSnapshot(
				roomId,
				sortedData,
				persistedKeys,
				inflightData,
			);

			log.info('Snapshot persisted successfully');
		} catch (error) {
			log.error({ error }, 'Error handling snapshot');
			throw error;
		} finally {
			await this.lockService.releaseLockIfOwned(roomId, lockValue);
		}
	}

	private async getActiveRoomIds(): Promise<string[]> {
		return await this.redis.smembers(
			REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
		);
	}

	private async removeFromActiveRooms(roomId: string): Promise<void> {
		await this.redis.srem(
			REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
			roomId,
		);
	}
}

export default SnapshotController;
