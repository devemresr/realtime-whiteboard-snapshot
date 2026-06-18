export const cleanupScript = `
local inflightAwaitingProcessingHashKey = KEYS[1]
local persistedAwaitingSnapshotHashKey = KEYS[2]
local snapshottedAwaitingPersistHashKey = KEYS[3]
local roomMetaDataHashKey = KEYS[4]
local snapshotPendingActiveRoomsKey = KEYS[5]

local persistedAwaitingSnapshotDataKeys = cjson.decode(ARGV[1])
local inflightAwaitingProcessingDataKeys = cjson.decode(ARGV[2])
local roomId = ARGV[3]

local successfulCleanupIds = {}

local removedFromInflightTotal = 0
local addedToSnapshottedTotal = 0
local removedFromPersistedTotal = 0
local completedProcessingAdded = 0

-- 1. Move inflight -> snapshottedAwaitingPersist
for i, inflightElement in ipairs(inflightAwaitingProcessingDataKeys) do
    local packageId = tostring(inflightElement.packageId)

    local removed = redis.call('HDEL', inflightAwaitingProcessingHashKey, packageId)

    if removed == 1 then
        removedFromInflightTotal = removedFromInflightTotal + 1

        local added = redis.call(
            'HSET',
            snapshottedAwaitingPersistHashKey,
            packageId,
            cjson.encode(inflightElement)
        )

        -- HSET returns 1 only if new field was created.
        -- But logically this element is now snapshotted-awaiting-persist.
        addedToSnapshottedTotal = addedToSnapshottedTotal + 1

        table.insert(successfulCleanupIds, packageId)
    end
end

-- 2. Remove persistedAwaitingSnapshot -> completed
for i, key in ipairs(persistedAwaitingSnapshotDataKeys) do
    local persistedKey = tostring(key)

    local removed = redis.call('HDEL', persistedAwaitingSnapshotHashKey, persistedKey)

    if removed == 1 then
        removedFromPersistedTotal = removedFromPersistedTotal + 1
        completedProcessingAdded = completedProcessingAdded + 1
        table.insert(successfulCleanupIds, persistedKey)
    end
end

local snapshotTotalEventCount = addedToSnapshottedTotal + completedProcessingAdded

local now = redis.call('TIME')
local timestamp = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

redis.call(
    'HSET',
    roomMetaDataHashKey,
    'lastSnapshotAt',
    timestamp,
    'lastActivityAt',
    timestamp
)

local newSnapshotTotalEventCount =
    redis.call('HINCRBY', roomMetaDataHashKey, 'snapshotTotalEventCount', snapshotTotalEventCount)

local newInflightAwaitingProcessingCount =
    redis.call('HINCRBY', roomMetaDataHashKey, 'inflightAwaitingProcessingCount', -removedFromInflightTotal)

local newSnapshottedAwaitingPersistCount =
    redis.call('HINCRBY', roomMetaDataHashKey, 'snapshottedAwaitingPersistCount', addedToSnapshottedTotal)

local newCompletedCount =
    redis.call('HINCRBY', roomMetaDataHashKey, 'completedProcessingCount', completedProcessingAdded)

local newPersistedAwaitingSnapshotCount =
    redis.call('HINCRBY', roomMetaDataHashKey, 'persistedAwaitingSnapshotCount', -removedFromPersistedTotal)

if tonumber(newPersistedAwaitingSnapshotCount) == 0 and tonumber(newInflightAwaitingProcessingCount) == 0 then
    redis.call('SREM', snapshotPendingActiveRoomsKey, roomId)
end

return {
    successfulCleanupIds,
    newInflightAwaitingProcessingCount,
    newPersistedAwaitingSnapshotCount,
    newCompletedCount,
    newSnapshottedAwaitingPersistCount,
    newSnapshotTotalEventCount,
    timestamp,
    removedFromInflightTotal,
    removedFromPersistedTotal,
    addedToSnapshottedTotal,
    completedProcessingAdded
}
`;
