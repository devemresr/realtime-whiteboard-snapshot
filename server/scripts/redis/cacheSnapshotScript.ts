export const cacheSnapshotScript = `
-- Cache the snapshot
local roomMetaDataHashKey = KEYS[1]
local cachedsnapshotHashKey = KEYS[2]
local compressedSnapshotData = ARGV[1]
local snapshotId = ARGV[2]
local roomId = ARGV[3]

    -- Check if the metadata exists
    local roomMetaDataExists = redis.call('EXISTS', roomMetaDataHashKey)

    -- If it doesnt exists return failure to solve the metadata issue and for to application to trigger a retry
    if roomMetaDataExists == 0 then
        return { 0, roomId}
    end
    
    -- Create a snapshotId with snapshotCount as a sequence number
    local newSnapshotSequenceNumber = redis.call('HINCRBY', roomMetaDataHashKey, 'snapshotCount', 1)
    local fullSnapshotId = tostring(snapshotId) .. '-' .. (newSnapshotSequenceNumber - 1)
    
    -- Store snapshot data (compressed)
    redis.call('HSET', cachedsnapshotHashKey, fullSnapshotId, compressedSnapshotData)
    redis.call('EXPIRE', roomMetaDataHashKey, 3600)

    return {1, fullSnapshotId}
`;
