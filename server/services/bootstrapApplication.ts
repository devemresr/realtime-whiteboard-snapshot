import { RedisFactory } from './redis/redisFactory';
import {
	REDIS_CLIENTS,
	REDIS_CONSUMER_GROUPS,
} from '../constants/redisConstants';
import HeartbeatService from './heartBeatService';
import SnapshotController from '../controllers/snapshotController';

export async function bootstrapApplication(port: number) {
	try {
		const redisMain = await RedisFactory.createClient(
			{ port: 6379 },
			REDIS_CLIENTS.MAIN,
		);
		redisMain.on('error', (err) => console.error('redisMain', err));

		console.log('snapshottingController initialized');
		const heartbeatInstance = HeartbeatService.getInstance(
			redisMain.getClient(),
			{
				port,
			},
		);

		// Create persistence controller with explicit dependencies
		const snapshottingController = new SnapshotController(
			port,
			{ consumerGroup: REDIS_CONSUMER_GROUPS.SNAPSHOT },
			heartbeatInstance,
			redisMain.getClient(),
		);

		await snapshottingController.start();

		return {
			redisMain,
			heartbeatInstance,
		};
	} catch (error) {
		console.log('error at startup:', error);
		throw error;
	}
}
