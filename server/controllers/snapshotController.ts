import Redis from 'ioredis';
import stableHash from '../utils/stableHash';
import HeartbeatService from '../services/heartBeatService';
import Snapshot from '../schemas/Snapshot';
import { REDIS_KEYS } from '../constants/redisConstants';
import sizeof from 'object-sizeof';
import { parseRedisFields } from '../utils/parseRedisFields';
import { nanoid } from 'nanoid';
import { cleanupScript } from '../scripts/redis/cleanupScript';
import { gzip as gzipCallback } from 'zlib';
import { promisify } from 'util';
import { cacheSnapshotScript } from '../scripts/redis/cacheSnapshotScript';

interface BatchProcessingConfig {
	strokeCountThreshold: number;
	timeoutMs: number;
	consumerGroup: string;
}
interface BatchProcessingInput {
	strokeCountThreshold?: number;
	timeoutMs?: number;
	consumerGroup: string;
}

interface RoomBatchData {
	strokeCount: number;
	strokesData: string[];
	isTimedOut: boolean;
}
interface Stroke {
	x: number;
	y: number;
	timestamp: number;
}

interface RoomDataBase {
	roomId: string;
	strokes: Stroke[];
	strokeId: string;
	packageSequenceNumber: number;
	isLastPackage?: boolean;
	strokeSequenceNumber: number;
	packageId: string;
	redisMessageId: string;
}

class SnapshotController {
	private readonly config: BatchProcessingConfig;
	private heartBeatService: HeartbeatService;
	private PORT;
	private redis: Redis;
	private serverId: string;
	private snapshotTimer: any;
	private cleanupTimer: any;

	constructor(
		PORT: string,
		config: BatchProcessingInput,
		heartBeatService: HeartbeatService,
		redis: Redis
	) {
		this.redis = redis;
		this.PORT = PORT;
		// Server ID priority: process.env.PORT (if set) → config.port (from CLI flag)
		// This allows multiple dev instances sharing the same .env to have unique IDs
		// based on their --port flag. Production should use explicit SERVER_ID env vars.
		const derivedServerId = process.env.PORT
			? `server-${process.env.PORT}`
			: undefined;
		this.serverId = derivedServerId ?? `server-${this.PORT}`;
		this.heartBeatService = heartBeatService;
		this.snapshotTimer = null;
		this.cleanupTimer = null;

		this.config = {
			strokeCountThreshold: 100,
			timeoutMs: 3 * 1000, // after timeout runs out and if it didnt hit to threshold amount we batchwrite it
			...config,
		};
	}

	public async start() {
		this.snapshotTimer = setInterval(
			async () => await this.createSnapshots(),
			10 * 1000
		);
		this.createSnapshots();
	}

	private async createSnapshots() {
		const activeRooms = await this.getActiveRoomIds();

		console.log('activeRooms', activeRooms);

		for (let activeRoom of activeRooms) {
			await this.checkRoomResponsibility(activeRoom);
		}
	}

	private async checkRoomResponsibility(roomId: string): Promise<void> {
		const maxRetries = 3;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// Watch for server topology changes
				const ACTIVE_SERVERS_KEY = process.env.ACTIVE_SERVERS_KEY!;
				const ACTIVE_SERVER_DATA = process.env.ACTIVE_SERVER_DATA!;
				await this.redis.watch(ACTIVE_SERVERS_KEY, ACTIVE_SERVER_DATA);

				// Check if we're responsible (outside transaction)
				const isResponsible = await this.isMyRoom(roomId);
				if (!isResponsible) {
					await this.redis.unwatch();
					return;
				}

				console.log('serverId', this.serverId, 'isResponsible for:', roomId);

				// Prepare lock acquisition
				const lockKeyPrefix = process.env.SERVER_TYPE;
				const lockKey = `${lockKeyPrefix}lock:room:${roomId}`;
				const lockValue = `${process.pid}-${Date.now()}`;

				// Execute transaction with lock acquisition
				const multi = this.redis.multi();
				multi.set(lockKey, lockValue, 'EX', 3, 'NX');
				const result = await multi.exec();
				if (result === null) {
					// Server topology changed while checking responsibility and lock acquisation
					console.log('topology changed');
					continue;
				}

				// Check if we acquired the lock (first command in transaction)
				const lockAcquired = result[0][1]; // [error, result] tuple
				console.log('lockAcquired', lockAcquired);

				if (!lockAcquired) {
					console.log(
						this.serverId,
						' COULDNT acquire the lock another server acquired it for the room: ',
						roomId
					);
					return; // Another server is handling it
				}
				await this.persistSnapshot(roomId, lockKey, lockValue);

				return;
			} catch (error) {
				console.error(
					`Process room ${roomId} attempt ${attempt} failed:`,
					error
				);
				await this.redis.unwatch();
				if (attempt === maxRetries + 1) {
					console.error(
						`Failed to process room ${roomId} after ${maxRetries} attempts`
					);
				}
			}
		}
	}

	// ========== Room Management ==========
	private async isMyRoom(roomId: string) {
		try {
			const serverStatus = await this.getActiveServers();
			const { activeServers } = serverStatus;
			if (activeServers.length === 0) return null;
			console.log('activeServers', activeServers);

			const myserverIndex = activeServers.findIndex(
				(server: any) => server.id === this.serverId
			);
			if (myserverIndex === -1) {
				console.log('this server failed to give heartbeat');
				return;
			}

			// the assignments wont change till the cycle renews
			const cycle_number = Math.floor(Date.now() / (10 * 1000));
			console.log('cycle_number', cycle_number);
			const responsibleIndex =
				stableHash(`${roomId}-${cycle_number}`) % activeServers.length;

			return responsibleIndex === myserverIndex;
		} catch (error) {
			console.error('Error determining server responsibility:', error);
			return false;
		}
	}

	private async getSnapshotData(roomId: string) {
		const [inflightAwaitingProcessingData, persistedAwaitingSnapshotData] =
			await this.getRoomData(roomId);

		const parsedInflightAwaitingProcessingData = parseRedisFields(
			inflightAwaitingProcessingData
		);
		const parsedPersistedAwaitingSnapshotData = parseRedisFields(
			persistedAwaitingSnapshotData
		);

		const transformData = (data: Record<string, any>, isPersisted: boolean) => {
			if (Object.keys(data).length === 0) return [];

			return Object.values(data).map((item) => {
				return { ...item, isPersisted };
			});
		};

		const transformedInflightAwaitingProcessingData = transformData(
			parsedInflightAwaitingProcessingData,
			false
		);
		const transformedPersistedAwaitingSnapshotData = transformData(
			parsedPersistedAwaitingSnapshotData,
			true
		);

		if (
			transformedInflightAwaitingProcessingData.length === 0 &&
			transformedPersistedAwaitingSnapshotData.length === 0
		) {
			await this.removeFromActiveRooms(roomId);
			throw new Error(
				`Corrupted room data retrieval - investigate. roomId: ${roomId}`
			);
		}

		const persistedAwaitingSnapshotDataKeys = Object.keys(
			parsedPersistedAwaitingSnapshotData
		);

		return {
			transformedInflightAwaitingProcessingData,
			transformedPersistedAwaitingSnapshotData,
			persistedAwaitingSnapshotDataKeys,
		};
	}

	private orderStrokesPackages(values: any[]) {
		const groupedByStrokeId = values.reduce(
			(acc, msg) => {
				const strokeId = msg.strokeId;
				if (!acc[strokeId]) {
					acc[strokeId] = [];
				}
				acc[strokeId].push(msg);
				return acc;
			},
			{} as Record<string, typeof values>
		);

		const sortedGroups = Object.values(groupedByStrokeId).map((group: any) => {
			if (group.length === 1) return group;
			return group.sort(
				(a: any, b: any) => a.packageSequenceNumber - b.packageSequenceNumber
			);
		});

		return sortedGroups.flat();
	}

	private async persistSnapshot(
		roomId: string,
		lockKey: string,
		lockValue: string
	) {
		try {
			const {
				transformedInflightAwaitingProcessingData,
				transformedPersistedAwaitingSnapshotData,
				persistedAwaitingSnapshotDataKeys,
			} = await this.getSnapshotData(roomId);

			const allValues = [
				...transformedInflightAwaitingProcessingData,
				...transformedPersistedAwaitingSnapshotData,
			];
			if (!allValues) {
				console.error('No snapshot data available for room:', roomId);
				return;
			}
			console.log('allValues', allValues);

			const sortedData = this.orderStrokesPackages(allValues);
			const snapshotId = `snapshot_${roomId}_${Date.now()}_${nanoid(10)}`;

			const result = await Snapshot.insertOne({
				snapshotId,
				roomId,
				roomsData: sortedData,
			});

			await this.cacheSnapshot(snapshotId, roomId, sortedData);

			console.log(
				'snapshot persistence result for the room: ',
				roomId,
				'the snapshotId: ',
				snapshotId
				// 'the result: ',
				// result
			);

			await this.cleanup(
				persistedAwaitingSnapshotDataKeys,
				transformedInflightAwaitingProcessingData,
				roomId
			);
			return result;
		} catch (error) {
			console.error('Error persisting snapshot:', error);
		} finally {
			await this.releaseLockIfOwned(lockKey, lockValue);
		}
	}

	private async releaseLockIfOwned(
		lockKey: string,
		lockValue: string
	): Promise<void> {
		const releaseLockIfOwnedScript = `
		if redis.call("GET", KEYS[1]) == ARGV[1] then
			return redis.call("DEL", KEYS[1])
		else
			return 0
		end
	`;
		try {
			await this.redis.eval(releaseLockIfOwnedScript, 1, lockKey, lockValue);
		} catch (error) {
			console.error('Failed to release lock:', error);
		}
	}
	private async cacheSnapshot(
		snapshotId: string,
		roomId: string,
		sortedData: any
	) {
		const gzip = promisify(gzipCallback);
		const compressedSnapshot = await gzip(JSON.stringify(sortedData));
		const compressedSnapshotBase64 = compressedSnapshot.toString('base64');

		// since lua doesnt handle buffer type sent base64 string
		const res = await this.redis.eval(
			cacheSnapshotScript,
			3,
			REDIS_KEYS.roomData.snapshotMetaData(roomId),
			REDIS_KEYS.roomData.snapshotsIds(roomId),
			REDIS_KEYS.roomData.cachedSnapshots(roomId),
			Date.now(),
			compressedSnapshotBase64,
			snapshotId,
			sortedData.length
		);
		if (res !== 1) throw new Error('caching snapshot failed');
		return true;
	}

	private async cleanup(
		persistedAwaitingSnapshotDataKeys: string[],
		inflightAwaitingProcessingData: string[],
		roomId: string
	) {
		const cleanUpResult = await this.redis.eval(
			cleanupScript,
			5,
			REDIS_KEYS.roomData.inflightAwaitingProcessing(roomId),
			REDIS_KEYS.roomData.persistedAwaitingSnapshot(roomId),
			REDIS_KEYS.roomData.snapshottedAwaitingPersist(roomId),
			REDIS_KEYS.roomData.inflightAwaitingProcessingMetaData(roomId),
			REDIS_KEYS.roomData.snapshotMetaData(roomId),
			JSON.stringify(persistedAwaitingSnapshotDataKeys),
			JSON.stringify(inflightAwaitingProcessingData),
			this.getSnapshotPendingActiveRoomsKey(),
			roomId,
			Date.now()
		);
		if (!cleanUpResult) {
			throw new Error(`cleanup failed for room: ${roomId}`);
		}
		console.log('cleanUpResult', cleanUpResult);
	}

	// ========== Redis Helper Methods ==========
	private async getRoomData(roomId: string) {
		const getRoomDataScript = `
		local inflightAwaitingProcessing = KEYS[1]
		local persistedAwaitingSnapshot = KEYS[2]
		local inflightData = redis.call('HGETALL', inflightAwaitingProcessing)
		local persistedData = redis.call('HGETALL', persistedAwaitingSnapshot)
		return {inflightData, persistedData}
		`;
		return (await this.redis.eval(
			getRoomDataScript,
			2,
			REDIS_KEYS.roomData.inflightAwaitingProcessing(roomId),
			REDIS_KEYS.roomData.persistedAwaitingSnapshot(roomId)
		)) as [string[], string[]];
	}

	private getSnapshotPendingActiveRoomsKey() {
		return REDIS_KEYS.activeRooms.snapshotPendingActiveRooms();
	}

	private async getActiveRoomIds(): Promise<string[]> {
		return await this.redis.smembers(this.getSnapshotPendingActiveRoomsKey());
	}

	private async removeFromActiveRooms(roomId: string): Promise<void> {
		await this.redis.srem(this.getSnapshotPendingActiveRoomsKey(), roomId);
	}

	private async getActiveServers() {
		return await this.heartBeatService.getActiveServers();
	}
}

export default SnapshotController;
