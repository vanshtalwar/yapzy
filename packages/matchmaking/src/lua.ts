// Lua scripts for matchmaking. Every script touches only keys of ONE matchmaking tag
// ({mm:<pool>:<mode>:<lang>}), all passed via KEYS, so each runs atomically on one Redis
// Cluster slot. Tickets are JSON: { ticketId, visitorId, interests, createdAt, status,
// nodeId?, sessionId? }.
//
// Note: Redis' cjson encodes an empty Lua table as `{}`, so a ticket re-encoded by a script may
// carry `"interests":{}`; the TypeScript ticket schema normalizes that back to [].

/**
 * KEYS: tickets, recent, q:any, q:int:<interest>... (the ticket's own interest queues)
 * ARGV: ticketJson, ticketId, visitorId, phase ('interest'|'any'), nowMs, recentTtlMs,
 *       maxScan, sessionId (used only on match), op ('enqueue'|'promote')
 * Returns: {'waiting'} | {'duplicate'} | {'not_waiting'} | {'matched', peerJson, common...}
 */
export const ENQUEUE_OR_MATCH = `
local tickets, recent, qany = KEYS[1], KEYS[2], KEYS[3]
local ticketId, visitorId, phase = ARGV[2], ARGV[3], ARGV[4]
local now, recentTtl, maxScan = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local sessionId, op = ARGV[8], ARGV[9]

local self
local existing = redis.call('HGET', tickets, ticketId)
if op == 'promote' then
  if not existing then return {'not_waiting'} end
  self = cjson.decode(existing)
  if self.status ~= 'waiting' then return {'not_waiting'} end
else
  if existing then return {'duplicate'} end
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

local queues = {}
if phase == 'interest' then
  for i = 4, #KEYS do queues[#queues + 1] = KEYS[i] end
else
  queues[1] = qany
end

local match = nil
for _, queue in ipairs(queues) do
  match = scan(queue)
  if match then break end
end

if not match then
  for _, queue in ipairs(queues) do redis.call('RPUSH', queue, ticketId) end
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
