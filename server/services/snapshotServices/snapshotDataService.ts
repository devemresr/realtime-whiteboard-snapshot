import Redis from 'ioredis';
import { parseRedisFields } from '../../utils/parseRedisFields';
import { TransformedRoomData } from '../../types';
import { REDIS_KEYS } from '../../constants/redisConstants';

export class SnapshotDataService {
	private redis: Redis;

	constructor(redis: Redis) {
		this.redis = redis;
	}

	async getRoomData(roomId: string): Promise<{
		inflightData: TransformedRoomData[];
		persistedData: TransformedRoomData[];
		persistedKeys: string[];
	}> {
		const script = `
      local inflightAwaitingProcessing = KEYS[1]
      local persistedAwaitingSnapshot = KEYS[2]
      local inflightData = redis.call('HGETALL', inflightAwaitingProcessing)
      local persistedData = redis.call('HGETALL', persistedAwaitingSnapshot)
      return {inflightData, persistedData}
    `;

		const [inflightRaw, persistedRaw] = (await this.redis.eval(
			script,
			2,
			REDIS_KEYS.roomData.inflightAwaitingProcessing(roomId),
			REDIS_KEYS.roomData.persistedAwaitingSnapshot(roomId)
		)) as [string[], string[]];

		const parsedInflight = parseRedisFields(inflightRaw);
		const parsedPersisted = parseRedisFields(persistedRaw);

		return {
			inflightData: this.transformData(parsedInflight, false),
			persistedData: this.transformData(parsedPersisted, true),
			persistedKeys: Object.keys(parsedPersisted),
		};
	}

	private transformData(
		data: Record<string, any>,
		isPersisted: boolean
	): TransformedRoomData[] {
		if (Object.keys(data).length === 0) return [];
		return Object.values(data).map((item) => ({ ...item, isPersisted }));
	}

	orderStrokesPackages(values: TransformedRoomData[]): TransformedRoomData[] {
		const groupedByStrokeId = values.reduce(
			(acc, msg) => {
				const strokeId = msg.strokeId;
				if (!acc[strokeId]) {
					acc[strokeId] = [];
				}
				acc[strokeId].push(msg);
				return acc;
			},
			{} as Record<string, TransformedRoomData[]>
		);

		const sortedGroups = Object.values(groupedByStrokeId).map((group) => {
			if (group.length === 1) return group;
			return group.sort(
				(a, b) => a.packageSequenceNumber - b.packageSequenceNumber
			);
		});

		return sortedGroups.flat();
	}
}
