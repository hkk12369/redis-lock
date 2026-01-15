# RedisLock

A robust lock implementation for Node.js using Redis and WebCrypto. Supports both Mutex (exclusive) and Semaphore (shared) locks.

## Features

- **Distributed**: Works across multiple Node.js instances.
- **WebCrypto**: Uses standard `crypto.subtle` for SHA1 generation (no legacy `require('crypto')`).
- **Flexible**: Supports Mutex (concurrency = 1) and Semaphore (concurrency > 1).
- **Dual Package**: CommonJS and ESM support.
- **Typed**: Written in TypeScript with full type definitions.

## Installation

```bash
npm install @hkk12369/redis-lock
```

## Usage

### Configuration

You must configure the lock with a Redis client before use. The client must support `eval`, `evalsha`, `set`, `zrem`, and `exists`. `ioredis` is recommended.

```javascript
import RedisLock from '@hkk12369/redis-lock';
import Redis from 'ioredis';

const redis = new Redis();
RedisLock.configure(redis, {
  timeout: 60000, // Default wait timeout
  poll: 100,      // Default polling interval
  ttl: 60000      // Default lock TTL
});
```

### Mutex (Exclusive Lock)

```javascript
const lock = new RedisLock('my-resource', {
  ttl: 5000, // Override default TTL
  concurrency: 1 // Default
});

try {
  await lock.acquire();
  // Do work...
} finally {
  await lock.release();
}

// Helper to acquire, run, and release automatically
await lock.run(async () => {
  // Do work...
});

// only 1 process should do the work
if (await lock.tryAcquire()) {
  try {
    // Do work...
  } finally {
    await lock.release();
  }
}

// or the helper
await lock.tryRun(async () => {
  // Do work...
});
```

### Semaphore (Shared Lock)

```javascript
const semaphore = new RedisLock('my-rate-limit', {
  ttl: 1000,
  concurrency: 5 // Allow 5 concurrent holders
});

try {
  await semaphore.acquire();
  // Do work...
} finally {
  await semaphore.release();
}

// Helper to acquire, run, and release automatically
await semaphore.run(async () => {
  // Do work...
});

// only concurrency (5) processes should do the work
if (await semaphore.tryAcquire()) {
  try {
    // Do work...
  } finally {
    await semaphore.release();
  }
}

// or the helper
await semaphore.tryRun(async () => {
  // Do work...
});
```

### API

- **`RedisLock.configure(client, options)`**: Static. Sets the global Redis client and defaults.
  - `options.timeout`: Default wait timeout (60000ms).
  - `options.poll`: Default polling interval (100ms).
  - `options.ttl`: Default lock TTL (60000ms).
- **`new RedisLock(name, options)`**:
  - `ttl`: Time to live in ms (defaults to global setting).
  - `concurrency`: Max concurrent holders (default 1).
  - `timeout`: Default wait timeout (defaults to global setting).
  - `poll`: Default polling interval (defaults to global setting).
  - `redis`: Optional specific Redis client.
- **`acquire(options)`**: Waits until lock is acquired.
  - `timeout`: Max wait time in ms.
  - `poll`: Polling interval in ms.
- **`tryAcquire()`**: Returns `true` if acquired immediately, `false` otherwise.
- **`release()`**: Releases the lock.
- **`setTTL(ms)`**: Sets the lock TTL.
- **`wait(options)`**: Waits for lock to be free without acquiring.
- **`run(fn, options)`**: Acquires lock, runs function, and releases.
- **`tryRun(fn)`**: Attempts to acquire lock immediately. Runs function if successful, returns `false` otherwise.

