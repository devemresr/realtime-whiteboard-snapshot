export const REDIS_STREAMS = {
	DRAWING_EVENTS: 'drawing:events',
} as const;

export const REDIS_CONSUMER_GROUPS = {
	PERSISTENCE: 'persistenceGroup',
	SNAPSHOT: 'snapshotGroup',
} as const;

export const REDIS_CLIENTS = {
	CACHE: 'cacheClient',
	STREAM: 'streamClient',
} as const;
