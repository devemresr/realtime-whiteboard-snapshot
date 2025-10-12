import RedisStreamManager from './redis/redisStreamManager';
import { RedisFactory } from './redis/redisFactory';
import {
	REDIS_CLIENTS,
	REDIS_CONSUMER_GROUPS,
	REDIS_STREAMS,
} from '../constants/redisConstants';
import HeartbeatService from './heartBeatService';
import SnapshotController from '../controllers/snapshotController';

export interface RedisMessage {
	[key: string]: any;
}
interface RedisStreamMessage {
	messageId: string;
	message: Record<string, string>;
}

export async function bootstrapApplication(port: string) {
	try {
		const redisInstanceForStreams = await RedisFactory.createClient(
			{ port: 6379 },
			REDIS_CLIENTS.STREAM
		);
		redisInstanceForStreams.on('error', (err) =>
			console.error('redisInstanceForStreams', err)
		);

		const redisInstanceForCache = await RedisFactory.createClient(
			{ port: 6380 },
			REDIS_CLIENTS.CACHE
		);
		redisInstanceForCache.on('error', (err) =>
			console.error('redisInstanceForCache', err)
		);

		const heartbeatInstance = HeartbeatService.getInstance(
			redisInstanceForCache.getClient(),
			{ port }
		);

		// Create persistence controller with explicit dependencies
		// const persistenceController = new SnapshotController(
		// 	port,
		// 	{ consumerGroup: REDIS_CONSUMER_GROUPS.SNAPSHOT },
		// 	heartbeatInstance,
		// 	redisInstanceForStreams.getClient()
		// );

		// await persistenceController.initialize();
		// console.log('PersistenceController initialized');

		return {
			redisInstanceForStreams,
			heartbeatInstance,
		};
	} catch (error) {
		console.log('error at startup:', error);
		throw error;
	}
}
