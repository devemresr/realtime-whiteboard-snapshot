import Redis from 'ioredis';
import HeartbeatService from '../services/heartBeatService';
import { REDIS_KEYS } from '../constants/redisConstants';
import { BatchProcessingConfig, BatchProcessingInput } from '../types';
import { RoomResponsibilityService } from '../services/snapshotServices/roomResponsibilityService';
import { SnapshotDataService } from '../services/snapshotServices/snapshotDataService';
import { SnapshotPersistenceService } from '../services/snapshotServices/snapshotPersistenceService';
import { Logger } from '../utils/logger';
import RoomLockManager from '../managers/roomLockManager';

class SnapshotController {
	private readonly config: BatchProcessingConfig;
	private heartBeatService: HeartbeatService;
	private redis: Redis;
	private serverId: string;
	private snapshotTimer: NodeJS.Timeout | null;
	private logger: Logger;
	private lockService: RoomLockManager;
	private responsibilityService: RoomResponsibilityService;
	private dataService: SnapshotDataService;
	private persistenceService: SnapshotPersistenceService;

	constructor(
		PORT: string,
		config: BatchProcessingInput,
		heartBeatService: HeartbeatService,
		redis: Redis
	) {
		this.redis = redis;

		const derivedServerId = process.env.PORT
			? `server-${process.env.PORT}`
			: `server-${PORT}`;
		this.serverId = derivedServerId;

		this.heartBeatService = heartBeatService;
		this.snapshotTimer = null;
		this.logger = new Logger(this.serverId, true);

		this.config = {
			strokeCountThreshold: 100,
			timeoutMs: 3000,
			...config,
		};

		this.lockService = new RoomLockManager(redis, this.serverId);
		this.responsibilityService = new RoomResponsibilityService(
			heartBeatService,
			this.serverId
		);
		this.dataService = new SnapshotDataService(redis);
		this.persistenceService = new SnapshotPersistenceService(redis);
	}

	public async start(): Promise<void> {
		this.snapshotTimer = setInterval(() => this.createSnapshots(), 2000);
		await this.createSnapshots();
		this.logger.info('Snapshot controller started');
	}

	public async stop(): Promise<void> {
		if (this.snapshotTimer) {
			clearInterval(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.logger.info('Snapshot controller stopped');
	}

	private async createSnapshots(): Promise<void> {
		try {
			const activeRooms = await this.getActiveRoomIds();
			console.log('activeRooms', activeRooms);

			this.logger.debug('Processing active rooms', {
				count: activeRooms.length,
			});

			for (const roomId of activeRooms) {
				await this.processRoom(roomId);
			}
		} catch (error) {
			this.logger.error('Error in createSnapshots', error);
		}
	}

	private async processRoom(roomId: string): Promise<void> {
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

				this.logger.debug('Server is responsible for room', { roomId });

				const lockResult = await this.lockService.acquireLock(roomId);

				if (!lockResult) {
					this.logger.debug('Failed to acquire lock', { roomId });
					return;
				}
				const { lockValue } = lockResult;

				await this.handleSnapshot(roomId, lockValue);
				return;
			} catch (error) {
				this.logger.error(`Process room attempt ${attempt} failed`, error, {
					roomId,
				});
				await this.redis.unwatch();

				if (attempt === maxRetries) {
					this.logger.error(
						`Failed to process room after ${maxRetries} attempts`,
						null,
						{ roomId }
					);
				}
			}
		}
	}

	private async handleSnapshot(
		roomId: string,
		lockValue: string
	): Promise<void> {
		try {
			const { inflightData, persistedData, persistedKeys } =
				await this.dataService.getRoomData(roomId);

			if (inflightData.length === 0 && persistedData.length === 0) {
				await this.removeFromActiveRooms(roomId);
				this.logger.warn('No data found for room, removed from active rooms', {
					roomId,
				});
				return;
			}

			const allData = [...inflightData, ...persistedData];
			const sortedData = this.dataService.orderStrokesPackages(allData);

			this.logger.info('Persisting snapshot', {
				roomId,
				eventCount: sortedData.length,
			});

			await this.persistenceService.persistSnapshot(
				roomId,
				sortedData,
				persistedKeys,
				inflightData
			);

			this.logger.info('Snapshot persisted successfully', { roomId });
		} catch (error) {
			this.logger.error('Error handling snapshot', error, { roomId });
			throw error;
		} finally {
			await this.lockService.releaseLockIfOwned(roomId, lockValue);
		}
	}

	private async getActiveRoomIds(): Promise<string[]> {
		return await this.redis.smembers(
			REDIS_KEYS.activeRooms.snapshotPendingActiveRooms()
		);
	}

	private async removeFromActiveRooms(roomId: string): Promise<void> {
		await this.redis.srem(
			REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
			roomId
		);
	}
}

export default SnapshotController;
