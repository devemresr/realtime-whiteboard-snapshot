export const cacheSnapshotScript = `
-- Cache the snapshot
local snapshotMetadataHashKey = KEYS[1]
local snapshotIdsListKey = KEYS[2]
local cachedsnapshotHashKey = KEYS[3]
local now = ARGV[1]
local compressedSnapshotData = ARGV[2]
local snapshotId = ARGV[3]
local snapshotDataLength = tonumber(ARGV[4])


    -- Check if the metadata exists
    local snapshotMetadataExists = redis.call('EXISTS', snapshotMetadataHashKey)
    
    -- If not exists, create initial metadata
    if snapshotMetadataExists == 0 then
        redis.call('HSET', snapshotMetadataHashKey, 'snapshotCount', 1,
        'createdAt', now,
        'event_count', snapshotDataLength)
    else 
        local currentCount = redis.call('HGET', snapshotMetadataHashKey, 'event_count')
        redis.call('HINCRBY', snapshotMetadataHashKey, 'event_count', snapshotDataLength)
        redis.call('HINCRBY', snapshotMetadataHashKey, 'snapshotCount', 1)
    end

        
    -- Store snapshot data (compressed)
    redis.call('HSET', snapshotMetadataHashKey, 'last_snapshot_time', now)
    redis.call('HSET', cachedsnapshotHashKey, tostring(snapshotId), compressedSnapshotData)
    redis.call('SADD', snapshotIdsListKey, snapshotId)
    redis.call('EXPIRE', snapshotIdsListKey, 3600)

    -- local snapshotMetadataState = redis.call('HGETALL', snapshotMetadataHashKey)
    -- local snapshotIdsList = redis.call('SMEMBERS', snapshotIdsListKey)
    -- local cachedSnapshots = redis.call('HGETALL', cachedsnapshotHashKey)
    return 1
`;
