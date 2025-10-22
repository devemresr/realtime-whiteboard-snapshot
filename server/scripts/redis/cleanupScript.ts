export const cleanupScript = `
    local inflightAwaitingProcessingHashKey = KEYS[1]
    local persistedAwaitingSnapshotHashKey = KEYS[2]
    local snapshottedAwaitingPersistHashKey = KEYS[3]
    local inflightMetadataHashKey = KEYS[4]
    local persistedAwaitingSnapshotDataKeys = ARGV[1]
    local inflightAwaitingProcessingData = ARGV[2]
    local persistencePendingActiveRooms = ARGV[3]
    local roomId = ARGV[4]
    
    local successfullCleanupIds = {}
    local removedCount = 0
    local addedCount = 0

	local inflightBefore = redis.call('HGETALL', inflightAwaitingProcessingHashKey)
	local snapshottedNotPersistedBefore = redis.call('HGETALL', snapshottedAwaitingPersistHashKey)
	local allDoneBefore = redis.call('HGETALL', persistedAwaitingSnapshotHashKey)
    
    -- Decode and check if empty
    local persistedKeysDecoded = cjson.decode(persistedAwaitingSnapshotDataKeys)
    local inflightData = cjson.decode(inflightAwaitingProcessingData)

    -- Process inflightData keys
    if #inflightData > 0 then
		for i, inflightElement in ipairs(inflightData) do
        	local removed = redis.call('HDEL', inflightAwaitingProcessingHashKey, tostring(inflightElement.packageId))
        	removedCount = removedCount + removed
        	local added = redis.call('HSET', snapshottedAwaitingPersistHashKey, tostring(inflightElement.packageId), cjson.encode(inflightElement))
        	addedCount = addedCount + added
        	table.insert(successfullCleanupIds, tostring(inflightElement.packageId))
    	end
	end

    -- Get current stroke count
    local currentCount = tonumber(redis.call('HGET', inflightMetadataHashKey, 'strokeCount') or '0')

    -- Calculate new count (ensure it doesn't go below 0)
    local newCount = math.max(0, currentCount - removedCount)

    -- Update room metadata
    redis.call('HSET', inflightMetadataHashKey, 
        'strokeCount', tostring(newCount)
    )   

    -- Process persisted keys
	if #persistedKeysDecoded > 0 then
    	for i, key in ipairs(persistedKeysDecoded) do
            redis.call('HDEL', persistedAwaitingSnapshotHashKey, key)
			table.insert(successfullCleanupIds, tostring(key))
    	end
	end

    -- until theres a change in either inflightAwaitingProcessingHash or persistedAwaitingSnapshotHash theres no need to have this room as active
    local activeRooms = redis.call('SREM', persistencePendingActiveRooms, roomId)

    local inflightBeforeAfter= redis.call('HGETALL', inflightAwaitingProcessingHashKey)
    local snapshottedNotPersistedAfter = redis.call('HGETALL', snapshottedAwaitingPersistHashKey)
    local allDoneAfter = redis.call('HGETALL', persistedAwaitingSnapshotHashKey)
    -- return {successfullCleanupIds, addedCount, removedCount, inflightBefore, inflightBeforeAfter,snapshottedNotPersistedBefore ,snapshottedNotPersistedAfter, allDoneBefore, allDoneAfter, activeRooms,currentCount} 
	
	return successfullCleanupIds`;
