export const REDIS_STREAMS = {
	DRAWING_EVENTS: 'drawing:events',
} as const;

export const REDIS_CONSUMER_GROUPS = {
	PERSISTENCE: 'persistenceGroup',
	SNAPSHOT: 'snapshotGroup',
} as const;

export const REDIS_CLIENTS = {
	MAIN: 'mainClient',
} as const;

export const REDIS_KEYS = {
	activeRooms: {
		// List of room IDs that need snapshot processing
		snapshotPendingActiveRooms: () => `snapshot:active:rooms`,

		// List of room IDs that need persistance processing
		persistencePendingActiveRooms: () => `persistance:active:rooms`,
	},

	roomData: {
		// Newly received data waiting for both persistence and snapshot
		inflightAwaitingProcessing: (roomId: string) =>
			`room:${roomId}:inflight-awaiting-processing`,

		// Persisted to DB, will be deleted once snapshotted
		persistedAwaitingSnapshot: (roomId: string) =>
			`room:${roomId}:persisted-awaiting-snapshot`,

		inflightAwaitingProcessingMetaData: (roomId: string) =>
			`room:${roomId}:inflight-awaiting-processing:metadata`,

		// Snapshotted but not yet persisted to DB
		snapshottedAwaitingPersist: (roomId: string) =>
			`room:${roomId}:snapshotted-awaiting-persist`,

		snapshotMetaData: (roomId: string) => `room:${roomId}:snapshot:metadata`,
		snapshotsIds: (roomId: string) => `room:${roomId}:snapshot:ids`,
		cachedSnapshots: (roomId: string) => `room:${roomId}:cached:snapshot`,
	},
} as const;
