// KEYS[1] = rate-limit counter key (per-bucket)
// ARGV[1] = ttl seconds (set on first increment of the bucket)
// Returns the post-increment count.
//
// Atomic INCR + first-time EXPIRE — ensures the TTL is bound to the
// counter's lifetime even under pipelined contention. We don't refresh
// the TTL on every increment because the bucket key is itself
// time-windowed (`:<minute-bucket>`); rolling its expiry would let it
// outlive the window.
export const INCREMENT_RATE_BUCKET_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
` as const;
