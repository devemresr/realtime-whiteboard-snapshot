import Redis from 'ioredis';
import mongoose from 'mongoose';
import { promisify } from 'util';
import { gzip as gzipCallback } from 'zlib';
import { nanoid } from 'nanoid';
import Snapshot from '../../schemas/Snapshot';
import RoomMetaData, { RoomMetaDataBase } from '../../schemas/RoomMetaData';
import { REDIS_KEYS } from '../../constants/redisConstants';
import { cacheSnapshotScript } from '../../scripts/redis/cacheSnapshotScript';
import writeOverMetaDataScript from '../../scripts/redis/writeOverMetaDataScript';
import { cleanupScript } from '../../scripts/redis/cleanupScript';
import {
	CleanupResult,
	CleanupResultTuple,
	TransformedRoomData,
} from '../../types';

const gzip = promisify(gzipCallback);

export class SnapshotPersistenceService {
	private redis: Redis;

	constructor(redis: Redis) {
		this.redis = redis;
	}

	async persistSnapshot(
		roomId: string,
		sortedData: TransformedRoomData[],
		persistedKeys: string[],
		inflightData: TransformedRoomData[]
	): Promise<any> {
		const session = await mongoose.startSession();
		session.startTransaction();

		try {
			const snapshotId = `snapshot_${roomId}_${Date.now()}_${nanoid(10)}`;
			const compressedSnapshot = await this.compressData(sortedData);

			await this.cacheSnapshot(snapshotId, roomId, compressedSnapshot);

			const result = await Snapshot.insertOne(
				{
					snapshotId,
					roomId,
					compressedSnapshotData: compressedSnapshot,
					snapshotTotalEventCount: sortedData.length,
				},
				{ session }
			);

			const cleanupResults = await this.cleanup(
				persistedKeys,
				inflightData,
				roomId
			);

			await RoomMetaData.findOneAndUpdate(
				{ roomId },
				{
					$set: {
						inflightAwaitingProcessingCount:
							cleanupResults.newInflightAwaitingProcessingCount,
						persistedAwaitingSnapshotCount:
							cleanupResults.newPersistedAwaitingSnapshotCount,
						snapshotTotalEventCount: cleanupResults.newSnapshotTotalEventCount,
						newEventsSinceSnapshot: cleanupResults.newEventsSinceSnapshot,
						snapshottedAwaitingPersistCount:
							cleanupResults.newSnapshottedAwaitingPersistCount,
						completedCount: cleanupResults.newCompletedCount,
						lastSnapshotAt: cleanupResults.timestamp,
						lastEventAt: cleanupResults.timestamp,
					},
					$inc: { snapshotCount: 1 },
				},
				{ upsert: true, session }
			);

			await session.commitTransaction();
			return result;
		} catch (error) {
			await session.abortTransaction();
			throw error;
		} finally {
			session.endSession();
		}
	}

	private async compressData(data: any): Promise<string> {
		const compressed = await gzip(JSON.stringify(data));
		return compressed.toString('base64');
	}

	private async cacheSnapshot(
		snapshotId: string,
		roomId: string,
		snapshotData: string
	): Promise<boolean> {
		const res = (await this.redis.eval(
			cacheSnapshotScript,
			2,
			REDIS_KEYS.roomData.roomMetaData(roomId),
			REDIS_KEYS.roomData.cachedSnapshots(roomId),
			snapshotData,
			snapshotId,
			roomId
		)) as any;

		if (res[0] === 0) {
			await this.getMetaDataFromDb(roomId);
			return this.cacheSnapshot(snapshotId, roomId, snapshotData);
		}

		return true;
	}

	private async getMetaDataFromDb(
		roomId: string
	): Promise<RoomMetaDataBase | null> {
		const maxRetries = 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const dbMeta = await RoomMetaData.findOne({ roomId });

				if (!dbMeta) {
					throw new Error('No metadata found in DB');
				}

				const metaData: RoomMetaDataBase = {
					totalEventsReceived: dbMeta.totalEventsReceived,
					inflightAwaitingProcessingCount:
						dbMeta.inflightAwaitingProcessingCount,
					snapshottedAwaitingPersistCount:
						dbMeta.snapshottedAwaitingPersistCount,
					snapshotTotalEventCount: dbMeta.snapshotTotalEventCount,
					roomId: dbMeta.roomId,
					persistedAwaitingSnapshotCount: dbMeta.persistedAwaitingSnapshotCount,
					completedCount: dbMeta.completedCount,
					snapshotCount: dbMeta.snapshotCount,
					lastSnapshotAt: dbMeta.lastSnapshotAt,
					createdAt: dbMeta.createdAt,
					lastEventAt: dbMeta.lastEventAt,
					lastPersistedAt: dbMeta.lastPersistedAt,
					version: dbMeta.version,
					lastErrorAt: 0,
					consecutiveErrors: 0,
					lastErrorType: dbMeta.lastErrorType,
					lastErrorMessage: dbMeta.lastErrorMessage,
				};

				await this.redis.eval(
					writeOverMetaDataScript,
					3,
					REDIS_KEYS.roomData.roomMetaData(roomId),
					REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
					REDIS_KEYS.activeRooms.persistencePendingActiveRooms(),
					roomId,
					JSON.stringify(metaData)
				);

				return metaData;
			} catch (error) {
				if (attempt < maxRetries - 1) {
					await new Promise((resolve) =>
						setTimeout(resolve, (attempt + 1) * 1000)
					);
				}
			}
		}

		return null;
	}

	private async cleanup(
		persistedKeys: string[],
		inflightData: TransformedRoomData[],
		roomId: string
	): Promise<CleanupResult> {
		const result = (await this.redis.eval(
			cleanupScript,
			5,
			REDIS_KEYS.roomData.inflightAwaitingProcessing(roomId),
			REDIS_KEYS.roomData.persistedAwaitingSnapshot(roomId),
			REDIS_KEYS.roomData.snapshottedAwaitingPersist(roomId),
			REDIS_KEYS.roomData.roomMetaData(roomId),
			REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
			JSON.stringify(persistedKeys),
			JSON.stringify(inflightData),
			roomId
		)) as CleanupResultTuple;

		return this.toCleanupResult(result);
	}

	private toCleanupResult([
		successfullCleanupIds,
		newInflightAwaitingProcessingCount,
		newPersistedAwaitingSnapshotCount,
		newCompletedCount,
		newSnapshottedAwaitingPersistCount,
		newSnapshotTotalEventCount,
		newEventsSinceSnapshot,
		timestamp,
	]: CleanupResultTuple): CleanupResult {
		return {
			successfullCleanupIds,
			newInflightAwaitingProcessingCount,
			newPersistedAwaitingSnapshotCount,
			newCompletedCount,
			newSnapshottedAwaitingPersistCount,
			newSnapshotTotalEventCount,
			newEventsSinceSnapshot,
			timestamp,
		};
	}
}
