export const cleanupScript = `
    local inflightAwaitingProcessingHashKey = KEYS[1]
    local persistedAwaitingSnapshotHashKey = KEYS[2]
    local snapshottedAwaitingPersistHashKey = KEYS[3]
    local roomMetaDataHashKey = KEYS[4]
    local snapshotPendingActiveRoomsKey = KEYS[5]
    local persistedAwaitingSnapshotDataKeys = ARGV[1]
    local inflightAwaitingProcessingDataKeys = ARGV[2]
    local roomId = ARGV[3]
    
    local successfullCleanupIds = {}
    local removedFromInflightTotal = 0
    
    -- Decode and check if empty
    local persistedKeysDecoded = cjson.decode(persistedAwaitingSnapshotDataKeys)
    local inflightData = cjson.decode(inflightAwaitingProcessingDataKeys)

    --  1. Move event data from inflight to the snpashotted-awating-persistence hash
    if #inflightData > 0 then
		for i, inflightElement in ipairs(inflightData) do
        	local removed = redis.call('HDEL', inflightAwaitingProcessingHashKey, tostring(inflightElement.packageId))
        	removedFromInflightTotal = removedFromInflightTotal + removed
            if removed == 1 then
                redis.call('HSET', snapshottedAwaitingPersistHashKey, tostring(inflightElement.packageId), cjson.encode(inflightElement))
            end
        	table.insert(successfullCleanupIds, tostring(inflightElement.packageId))
    	end
	end

    local addedToCompletedCount = 0
    -- 2. Remove event data from persisted-awaiting-snapshot 
	if #persistedKeysDecoded > 0 then
    	for i, key in ipairs(persistedKeysDecoded) do
            local completed = redis.call('HDEL', persistedAwaitingSnapshotHashKey, key)
            addedToCompletedCount = addedToCompletedCount + completed
			table.insert(successfullCleanupIds, tostring(key))
    	end
	end

    local snapshotTotalEventCount = removedFromInflightTotal + addedToCompletedCount

    -- Update room metadata
    local now = redis.call('TIME')
    local timestamp = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
    redis.call('HSET', roomMetaDataHashKey, 'lastSnapshotAt', timestamp, 'lastEventAt', timestamp)
    local newSnapshotTotalEventCount = redis.call('HINCRBY', roomMetaDataHashKey, 'snapshotTotalEventCount', snapshotTotalEventCount)
    local newInflightAwaitingProcessingCount = redis.call('HINCRBY', roomMetaDataHashKey, 'inflightAwaitingProcessingCount', -removedFromInflightTotal)
    local newSnapshottedAwaitingPersistCount = redis.call('HINCRBY', roomMetaDataHashKey, 'snapshottedAwaitingPersistCount', removedFromInflightTotal)
    local newCompletedCount = redis.call('HINCRBY', roomMetaDataHashKey, 'completedCount', addedToCompletedCount)
    local newPersistedAwaitingSnapshotCount = redis.call('HINCRBY', roomMetaDataHashKey, 'persistedAwaitingSnapshotCount', -addedToCompletedCount)


    --  No more snapshot pending event remove the room from snapshotPendingActiveRooms
    if newPersistedAwaitingSnapshotCount == 0 and newInflightAwaitingProcessingCount == 0 then
        redis.call('SREM', snapshotPendingActiveRoomsKey, roomId)
    end

	return {successfullCleanupIds, newInflightAwaitingProcessingCount, newPersistedAwaitingSnapshotCount, newCompletedCount, newSnapshottedAwaitingPersistCount, newSnapshotTotalEventCount, timestamp}`;
