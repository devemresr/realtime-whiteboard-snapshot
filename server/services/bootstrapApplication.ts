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
		const redisMain = await RedisFactory.createClient(
			{ port: 6379 },
			REDIS_CLIENTS.MAIN
		);
		redisMain.on('error', (err) => console.error('redisMain', err));

		const heartbeatInstance = HeartbeatService.getInstance(
			redisMain.getClient(),
			{
				port,
			}
		);

		// Create persistence controller with explicit dependencies
		const persistenceController = new SnapshotController(
			port,
			{ consumerGroup: REDIS_CONSUMER_GROUPS.SNAPSHOT },
			heartbeatInstance,
			redisMain.getClient()
		);

		await persistenceController.start();
		console.log('PersistenceController initialized');

		return {
			redisMain,
			heartbeatInstance,
		};
	} catch (error) {
		console.log('error at startup:', error);
		throw error;
	}
}
