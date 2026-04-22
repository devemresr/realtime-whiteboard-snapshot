import Redis from 'ioredis';
import mongoose from 'mongoose';
import { promisify } from 'util';
import { gzip as gzipCallback } from 'zlib';
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
import logger from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

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
		inflightData: TransformedRoomData[],
	): Promise<any> {
		const log = logger.child({ roomId, method: 'persistSnapshot' });

		const session = await mongoose.startSession();
		session.startTransaction();

		try {
			const snapshotId = `snapshot_${roomId}_${Date.now()}_${uuidv4()}`;
			log.info(
				{ snapshotId, sortedDataCount: sortedData.length },
				'Starting snapshot persistence',
			);

			const compressedSnapshot = await this.compressData(sortedData);
			log.debug({ snapshotId }, 'Snapshot data compressed');

			await this.cacheSnapshot(snapshotId, roomId, compressedSnapshot);
			log.debug({ snapshotId }, 'Snapshot cached in Redis');

			const result = await Snapshot.insertOne(
				{
					snapshotId,
					roomId,
					compressedSnapshotData: compressedSnapshot,
					snapshotTotalEventCount: sortedData.length,
				},
				{ session },
			);
			log.info({ snapshotId }, 'Snapshot inserted into DB');

			const cleanupResults = await this.cleanup(
				persistedKeys,
				inflightData,
				roomId,
			);
			log.debug({ cleanupResults }, 'Cleanup completed');

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
				{ upsert: true, session },
			);
			log.info({ snapshotId }, 'Room metadata updated');

			await session.commitTransaction();
			log.info({ snapshotId }, 'Transaction committed successfully');
			return result;
		} catch (error) {
			await session.abortTransaction();
			log.error({ error }, 'Transaction aborted due to error');
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
		snapshotData: string,
	): Promise<boolean> {
		const log = logger.child({ roomId, snapshotId, method: 'cacheSnapshot' });

		log.debug('Evaluating cacheSnapshotScript against Redis');
		const res = (await this.redis.eval(
			cacheSnapshotScript,
			2,
			REDIS_KEYS.roomData.roomMetaData(roomId),
			REDIS_KEYS.roomData.cachedSnapshots(roomId),
			snapshotData,
			snapshotId,
			roomId,
		)) as any;

		if (res[0] === 0) {
			log.warn('Metadata missing during cache, fetching from DB and retrying');
			await this.getMetaDataFromDb(roomId);
			return this.cacheSnapshot(snapshotId, roomId, snapshotData);
		}

		log.debug('Snapshot cached successfully');
		return true;
	}

	private async getMetaDataFromDb(
		roomId: string,
	): Promise<RoomMetaDataBase | null> {
		const log = logger.child({ roomId, method: 'getMetaDataFromDb' });
		const maxRetries = 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				log.info({ attempt }, 'Fetching metadata from DB');
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
					lastEventAt: dbMeta.lastEventAt,
					lastPersistedAt: dbMeta.lastPersistedAt,
					version: dbMeta.version,
					consecutiveErrors: 0,
				};

				await this.redis.eval(
					writeOverMetaDataScript,
					3,
					REDIS_KEYS.roomData.roomMetaData(roomId),
					REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
					REDIS_KEYS.activeRooms.persistencePendingActiveRooms(),
					roomId,
					JSON.stringify(metaData),
				);

				log.info({ attempt }, 'Metadata written back to Redis successfully');
				return metaData;
			} catch (error) {
				if (attempt < maxRetries - 1) {
					const delay = (attempt + 1) * 1000;
					log.warn(
						{ attempt, delay, error },
						'Metadata fetch failed, retrying',
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					log.error(
						{ attempt, error },
						'All metadata fetch attempts exhausted',
					);
				}
			}
		}

		return null;
	}

	private async cleanup(
		persistedKeys: string[],
		inflightData: TransformedRoomData[],
		roomId: string,
	): Promise<CleanupResult> {
		const log = logger.child({ roomId, method: 'cleanup' });

		log.info(
			{
				persistedKeyCount: persistedKeys.length,
				inflightDataCount: inflightData.length,
			},
			'Running cleanup script',
		);
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
			roomId,
		)) as CleanupResultTuple;

		log.debug('Cleanup script executed, mapping result');
		return this.toCleanupResult(result);
	}

	private toCleanupResult([
		successfullCleanupIds,
		newInflightAwaitingProcessingCount,
		newPersistedAwaitingSnapshotCount,
		newCompletedCount,
		newSnapshottedAwaitingPersistCount,
		newSnapshotTotalEventCount,
		timestamp,
	]: CleanupResultTuple): CleanupResult {
		return {
			successfullCleanupIds,
			newInflightAwaitingProcessingCount,
			newPersistedAwaitingSnapshotCount,
			newCompletedCount,
			newSnapshottedAwaitingPersistCount,
			newSnapshotTotalEventCount,
			timestamp,
		};
	}
}
