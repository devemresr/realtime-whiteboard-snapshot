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

			const inflightToSnapshottedCount = cleanupResults.addedToSnapshottedTotal;

			const persistedToCompletedCount = cleanupResults.completedProcessingAdded;

			const snapshotTotalEventCount =
				inflightToSnapshottedCount + persistedToCompletedCount;

			await RoomMetaData.findOneAndUpdate(
				{ roomId },
				[
					{
						$set: {
							inflightAwaitingProcessingCount: {
								$max: [
									0,
									{
										$subtract: [
											{ $ifNull: ['$inflightAwaitingProcessingCount', 0] },
											inflightToSnapshottedCount,
										],
									},
								],
							},

							snapshottedAwaitingPersistCount: {
								$add: [
									{ $ifNull: ['$snapshottedAwaitingPersistCount', 0] },
									inflightToSnapshottedCount,
								],
							},

							persistedAwaitingSnapshotCount: {
								$max: [
									0,
									{
										$subtract: [
											{ $ifNull: ['$persistedAwaitingSnapshotCount', 0] },
											persistedToCompletedCount,
										],
									},
								],
							},

							completedProcessingCount: {
								$add: [
									{ $ifNull: ['$completedProcessingCount', 0] },
									persistedToCompletedCount,
								],
							},

							snapshotTotalEventCount: {
								$add: [
									{ $ifNull: ['$snapshotTotalEventCount', 0] },
									snapshotTotalEventCount,
								],
							},

							snapshotCount: {
								$add: [{ $ifNull: ['$snapshotCount', 0] }, 1],
							},

							lastSnapshotAt: cleanupResults.timestamp,
							lastActivityAt: cleanupResults.timestamp,
							updatedAt: '$$NOW',
						},
					},
				],
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
				const dbMeta = await RoomMetaData.findOne({
					roomId,
				}).lean();

				if (!dbMeta) {
					throw new Error('No metadata found in DB');
				}

				await this.redis.eval(
					writeOverMetaDataScript,
					3,
					REDIS_KEYS.roomData.roomMetaData(roomId),
					REDIS_KEYS.activeRooms.snapshotPendingActiveRooms(),
					REDIS_KEYS.activeRooms.persistencePendingActiveRooms(),
					roomId,
					JSON.stringify(dbMeta),
				);

				log.info({ attempt }, 'Metadata written back to Redis successfully');
				return dbMeta;
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
		removedFromInflightTotal,
		removedFromPersistedTotal,
		addedToSnapshottedTotal,
		completedProcessingAdded,
	]: CleanupResultTuple): CleanupResult {
		return {
			successfullCleanupIds,
			newInflightAwaitingProcessingCount,
			newPersistedAwaitingSnapshotCount,
			newCompletedCount,
			newSnapshottedAwaitingPersistCount,
			newSnapshotTotalEventCount,
			timestamp,
			removedFromInflightTotal,
			removedFromPersistedTotal,
			addedToSnapshottedTotal,
			completedProcessingAdded,
		};
	}
}
