const writeOverMetaDataScript = `
local roomMetaDataHashKey = KEYS[1]
local snapshotPendingActiveRoomsKey = KEYS[2]
local persistencePendingActiveRoomsKey = KEYS[3]
local roomId = ARGV[1]
local roomMetaDataJson = ARGV[2]
local roomMetaDataFromDb = cjson.decode(roomMetaDataJson)

redis.call('HSET', roomMetaDataHashKey,
    'totalEventsReceived', tostring(roomMetaDataFromDb.totalEventsReceived),
    'inflightAwaitingProcessingCount', tostring(roomMetaDataFromDb.inflightAwaitingProcessingCount),
    'persistedAwaitingSnapshotCount', tostring(roomMetaDataFromDb.persistedAwaitingSnapshotCount),
    'snapshottedAwaitingPersistCount', tostring(roomMetaDataFromDb.snapshottedAwaitingPersistCount),
    'snapshotTotalEventCount', tostring(roomMetaDataFromDb.snapshotTotalEventCount),
    'completedCount', tostring(roomMetaDataFromDb.completedCount),
    'snapshotCount', tostring(roomMetaDataFromDb.snapshotCount),
    'lastSnapshotAt', tostring(roomMetaDataFromDb.lastSnapshotAt),
    'lastPersistedAt', tostring(roomMetaDataFromDb.lastPersistedAt),
    'version', tostring(roomMetaDataFromDb.version),
    'lastErrorAt', tostring(roomMetaDataFromDb.lastErrorAt),
    'consecutiveErrors', tostring(roomMetaDataFromDb.consecutiveErrors),
    'lastErrorType', tostring(roomMetaDataFromDb.lastErrorType),
    'lastErrorMessage', tostring(roomMetaDataFromDb.lastErrorMessage)
    )

redis.call('HSET', roomMetaDataHashKey,
    'createdAt', tostring(roomMetaDataFromDb.createdAt),
    'lastEventAt', tostring(roomMetaDataFromDb.lastEventAt))

-- Add to active rooms
redis.call('SADD', persistencePendingActiveRoomsKey, roomId)
redis.call('EXPIRE', persistencePendingActiveRoomsKey, 3600)
redis.call('SADD', snapshotPendingActiveRoomsKey, roomId)
redis.call('EXPIRE', snapshotPendingActiveRoomsKey, 3600)

-- Set TTL on metadata
redis.call('EXPIRE', roomMetaDataHashKey, 3600)

return 1
`;

export default writeOverMetaDataScript;
