import Redis from 'ioredis';
import { LockResult } from '../types';

class RoomLockManager {
	private redis: Redis;
	private serverId: string;
	private lockKeyPrefix: string;

	constructor(redis: Redis, serverId: string) {
		this.redis = redis;
		this.serverId = serverId;
		this.lockKeyPrefix = process.env.SERVER_TYPE || 'default';
	}

	public async acquireLock(roomId: string): Promise<LockResult | false> {
		const lockKey = `${this.lockKeyPrefix}lock:room:${roomId}`;
		const lockValue = `${process.pid}-${Date.now()}`;

		const acquired = await this.redis.set(
			lockKey,
			lockValue,
			'EX',
			30, // 30 second timeout for database operations
			'NX',
		);

		if (!acquired) {
			console.log(
				this.serverId,
				' COULDNT acquire the lock another server acquired it for the room: ',
				roomId,
			);
			return false;
		}

		return { lockKey, lockValue };
	}

	public async releaseLockIfOwned(
		lockKey: string,
		lockValue: string,
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
}

export default RoomLockManager;
