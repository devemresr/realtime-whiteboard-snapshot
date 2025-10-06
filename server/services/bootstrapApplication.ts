import { Server as HttpServer } from 'http';
import RedisStreamManager from './redis/redisStreamManager';
import { RedisFactory } from './redis/redisFactory';
import {
	REDIS_CLIENTS,
	REDIS_CONSUMER_GROUPS,
	REDIS_STREAMS,
} from '../constants/redisConstants';
export async function bootstrapApplication(serverReference: HttpServer) {
	try {
		const redisInstanceForStreams = await RedisFactory.createClient(
			{ port: 6379 },
			REDIS_CLIENTS.STREAM
		);
		redisInstanceForStreams.on('error', (err) =>
			console.error('redisInstanceForStreams', err)
		);

		// Create and initialize Redis stream manager
		const redisStreamManager = new RedisStreamManager(
			redisInstanceForStreams.getClient()
		);
		await redisStreamManager.createConsumerGroup(
			REDIS_STREAMS.DRAWING_EVENTS,
			REDIS_CONSUMER_GROUPS.SNAPSHOT
		);
		console.log('RedisStreamManager initialized');

		return {
			redisStreamManager,
			redisInstanceForStreams,
		};
	} catch (error) {
		console.log('error at startup:', error);
		throw error;
	}
}
