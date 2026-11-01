// Lua scripts for matchmaking. Every script touches only keys of ONE matchmaking tag
// ({mm:<region>:<pool>:<mode>:<lang>:<bucket>}), all passed via KEYS, so each runs atomically
// on one Redis Cluster slot. Tickets are JSON: { ticketId, visitorId, interests, createdAt,
// status, phase, autoRequeue, nodeId?, sessionId? }.
//
// Note: Redis' cjson encodes an empty Lua table as `{}`, so a ticket re-encoded by a script may
// carry `"interests":{}`; the TypeScript ticket schema normalizes that back to [].

/**
 * KEYS: tickets, recent, q:any, q:seek, seeks, q:int:<interest>... (the ticket's own interest
 *       queues)
 * ARGV: ticketJson, ticketId, visitorId, phase ('interest'|'any'), nowMs, recentTtlMs,
 *       maxScan, sessionId (used only on match), op ('enqueue'|'promote'), priority ('1'|'0')
 * A priority ticket is pushed to the HEAD of its queues (fair requeue, bucket hops).
 * Enqueueing over an existing CANCELLED ticket with the same id is allowed (a ticket hopping
 * back into a bucket it left earlier); any other existing ticket is a duplicate.
 * A group ticket (`group = true`, Part 12) first looks for a session seeking one more person
 * in this bucket (`q:seek`): none of its participants may be the joiner or a recent pair.
 * Returns: {'waiting'} | {'duplicate'} | {'not_waiting'} | {'matched', peerJson, common...} |
 *   {'joined', seekJson} (the ticket is matched to that session)
 */
export const ENQUEUE_OR_MATCH = `
local tickets, recent, qany, qseek, seeks = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local ticketId, visitorId, phase = ARGV[2], ARGV[3], ARGV[4]
local now, recentTtl, maxScan = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local sessionId, op, priority = ARGV[8], ARGV[9], ARGV[10] == '1'

local self
local existing = redis.call('HGET', tickets, ticketId)
if op == 'promote' then
  if not existing then return {'not_waiting'} end
  self = cjson.decode(existing)
  if self.status ~= 'waiting' then return {'not_waiting'} end
  self.phase = 'any'
  redis.call('HSET', tickets, ticketId, cjson.encode(self))
else
  if existing and cjson.decode(existing).status ~= 'cancelled' then return {'duplicate'} end
  self = cjson.decode(ARGV[1])
  redis.call('HSET', tickets, ticketId, ARGV[1])
end

redis.call('ZREMRANGEBYSCORE', recent, '-inf', now - recentTtl)

local function pairMember(a, b)
  if a < b then return a .. '|' .. b end
  return b .. '|' .. a
end

-- Scans at most maxScan entries from the head. Dead references (missing, not waiting, or an
-- orphaned ticket of the same visitor) are dropped; recent pairs are skipped but KEPT, because
-- they are valid candidates for everybody else.
local function scan(queue)
  local ids = redis.call('LRANGE', queue, 0, maxScan - 1)
  local dead = {}
  local found = nil
  for _, id in ipairs(ids) do
    if id ~= ticketId then
      local raw = redis.call('HGET', tickets, id)
      if not raw then
        dead[#dead + 1] = id
      else
        local t = cjson.decode(raw)
        if t.status ~= 'waiting' or t.visitorId == visitorId then
          dead[#dead + 1] = id
        elseif not redis.call('ZSCORE', recent, pairMember(visitorId, t.visitorId)) then
          found = { id = id, ticket = t }
          break
        end
      end
    end
  end
  for _, id in ipairs(dead) do redis.call('LREM', queue, 0, id) end
  if found then redis.call('LREM', queue, 1, found.id) end
  return found
end

-- Group calls first (Part 12): the oldest session of this bucket still seeking whose people
-- are all new to this visitor. Filled/cancelled/missing seeks are dropped from the queue.
if self.group == true then
  local ids = redis.call('LRANGE', qseek, 0, maxScan - 1)
  local dead = {}
  local found = nil
  for _, sid in ipairs(ids) do
    local raw = redis.call('HGET', seeks, sid)
    if not raw then
      dead[#dead + 1] = sid
    else
      local seek = cjson.decode(raw)
      if seek.status ~= 'seeking' then
        dead[#dead + 1] = sid
      else
        local ok = true
        for _, member in ipairs(seek.visitorIds) do
          if member == visitorId or redis.call('ZSCORE', recent, pairMember(visitorId, member)) then
            ok = false
            break
          end
        end
        if ok then
          found = { id = sid, seek = seek }
          break
        end
      end
    end
  end
  for _, sid in ipairs(dead) do redis.call('LREM', qseek, 0, sid) end
  if found then
    redis.call('LREM', qseek, 1, found.id)
    local seek = found.seek
    seek.status = 'filled'
    seek.joiner = visitorId
    redis.call('HSET', seeks, found.id, cjson.encode(seek))
    self.status = 'matched'
    self.sessionId = seek.sessionId
    redis.call('HSET', tickets, ticketId, cjson.encode(self))
    for _, member in ipairs(seek.visitorIds) do
      redis.call('ZADD', recent, now, pairMember(visitorId, member))
    end
    return {'joined', cjson.encode(seek)}
  end
end

local queues = {}
if phase == 'interest' then
  for i = 6, #KEYS do queues[#queues + 1] = KEYS[i] end
else
  queues[1] = qany
end

local match = nil
for _, queue in ipairs(queues) do
  match = scan(queue)
  if match then break end
end

if not match then
  for _, queue in ipairs(queues) do
    if priority then redis.call('LPUSH', queue, ticketId) else redis.call('RPUSH', queue, ticketId) end
  end
  return {'waiting'}
end

local peer = match.ticket
self.status = 'matched'
self.sessionId = sessionId
peer.status = 'matched'
peer.sessionId = sessionId
redis.call('HSET', tickets, ticketId, cjson.encode(self), match.id, cjson.encode(peer))
redis.call('ZADD', recent, now, pairMember(visitorId, peer.visitorId))

local mine = {}
if type(self.interests) == 'table' then
  for _, interest in ipairs(self.interests) do mine[interest] = true end
end
local result = {'matched', cjson.encode(peer)}
if type(peer.interests) == 'table' then
  for _, interest in ipairs(peer.interests) do
    if mine[interest] then result[#result + 1] = interest end
  end
end
return result
`;

/**
 * KEYS: tickets   ARGV: ticketId
 * Returns: {'cancelled'} | {'not_found'} | {'matched', sessionId}
 */
export const CANCEL_TICKET = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {'not_found'} end
local t = cjson.decode(raw)
if t.status == 'matched' then return {'matched', t.sessionId or ''} end
if t.status == 'waiting' then
  t.status = 'cancelled'
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(t))
end
return {'cancelled'}
`;

/**
 * KEYS: tickets   ARGV: ticketId1, expectedJson1, ticketId2, expectedJson2, ...
 * Deletes each ticket only if it is unchanged since the caller read it. Returns the count.
 */
export const DROP_TICKETS_IF_UNCHANGED = `
local dropped = 0
for i = 1, #ARGV, 2 do
  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then
    redis.call('HDEL', KEYS[1], ARGV[i])
    dropped = dropped + 1
  end
end
return dropped
`;

/**
 * KEYS: tickets, recent, q:any, q:seek, seeks
 * ARGV: seekJson (status ignored), sessionId, nowMs, recentTtlMs, maxScan
 * A session starts seeking one more person (Part 12): take the first waiting group ticket in
 * `q:any` that is none of its participants nor a recent pair of any of them; otherwise queue
 * the seek (RPUSH q:seek) for the next group ticket that comes along.
 * Returns: {'joined', ticketJson} (that ticket is now matched to the session) | {'seeking'}
 */
export const SEEK_OR_MATCH = `
local tickets, recent, qany, qseek, seeks = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local seek = cjson.decode(ARGV[1])
local sessionId = ARGV[2]
local now, recentTtl, maxScan = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', recent, '-inf', now - recentTtl)

local function pairMember(a, b)
  if a < b then return a .. '|' .. b end
  return b .. '|' .. a
end

local members = {}
for _, member in ipairs(seek.visitorIds) do members[member] = true end

local ids = redis.call('LRANGE', qany, 0, maxScan - 1)
local dead = {}
local found = nil
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', tickets, id)
  if not raw then
    dead[#dead + 1] = id
  else
    local t = cjson.decode(raw)
    if t.status ~= 'waiting' then
      dead[#dead + 1] = id
    elseif t.group == true and not members[t.visitorId] then
      local ok = true
      for member in pairs(members) do
        if redis.call('ZSCORE', recent, pairMember(t.visitorId, member)) then
          ok = false
          break
        end
      end
      if ok then
        found = { id = id, ticket = t }
        break
      end
    end
  end
end
for _, id in ipairs(dead) do redis.call('LREM', qany, 0, id) end

if found then
  redis.call('LREM', qany, 1, found.id)
  local t = found.ticket
  t.status = 'matched'
  t.sessionId = sessionId
  redis.call('HSET', tickets, found.id, cjson.encode(t))
  for member in pairs(members) do redis.call('ZADD', recent, now, pairMember(t.visitorId, member)) end
  seek.status = 'filled'
  seek.joiner = t.visitorId
  redis.call('HSET', seeks, sessionId, cjson.encode(seek))
  return {'joined', cjson.encode(t)}
end

seek.status = 'seeking'
redis.call('HSET', seeks, sessionId, cjson.encode(seek))
redis.call('RPUSH', qseek, sessionId)
return {'seeking'}
`;

/**
 * KEYS: seeks, q:seek   ARGV: sessionId, seekId
 * Ends a seek of that round: a still-seeking one is removed; a filled one is reported (its
 * joiner is being added right now) and left for the caller to finish.
 * Returns: {'cancelled'} | {'filled', joinerVisitorId} | {'not_found'}
 */
export const CANCEL_SEEK = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {'not_found'} end
local seek = cjson.decode(raw)
if seek.seekId ~= ARGV[2] then return {'not_found'} end
if seek.status == 'filled' then return {'filled', seek.joiner or ''} end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('LREM', KEYS[2], 0, ARGV[1])
if seek.status == 'seeking' then return {'cancelled'} end
return {'not_found'}
`;

/**
 * KEYS: seeks   ARGV: sessionId, seekId
 * Deletes a finished (filled) seek of that round. Returns 1 if deleted.
 */
export const FINISH_SEEK = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
if cjson.decode(raw).seekId ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;
