const writeOverMetaDataScript = `
local roomMetaDataHashKey = KEYS[1]
local snapshotPendingActiveRoomsKey = KEYS[2]
local persistencePendingActiveRoomsKey = KEYS[3]
local roomId = ARGV[1]
local roomMetaDataJson = ARGV[2]
local roomMetaDataFromDb = cjson.decode(roomMetaDataJson)

local args = {}
for field, value in pairs(roomMetaDataFromDb) do
    table.insert(args, field)
    table.insert(args, tostring(value))
end

redis.call('HSET', roomMetaDataHashKey, unpack(args))


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
