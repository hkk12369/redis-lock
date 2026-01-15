/**
 * Interface compatible with ioredis and other Redis clients.
 * Requires support for eval, evalsha, set, zrem, and exists.
 */
interface RedisClient {
    evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<any>;
    eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<any>;
    set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
    zrem(key: string, member: string): Promise<number>;
    exists(key: string): Promise<number>;
    [key: string]: any;
}

/**
 * Global configuration options for the RedisLock class.
 */
interface GlobalOptions {
    /** Default timeout for acquiring locks in milliseconds. Default: 60000 */
    timeout?: number;
    /** Default polling interval in milliseconds. Default: 100 */
    poll?: number;
    /** Default time-to-live for locks in milliseconds. Default: 60000 */
    ttl?: number;
}

/**
 * Options for creating a new RedisLock instance.
 */
interface LockOptions {
    /** Lock time-to-live in milliseconds. Defaults to global TTL. */
    ttl?: number;
    /** Number of concurrent holders allowed. Defaults to 1 (Mutex). */
    concurrency?: number;
    /** Specific Redis client instance. Defaults to global client. */
    redis?: RedisClient;
    /** Default timeout for acquiring this lock in milliseconds. Defaults to global timeout. */
    timeout?: number;
    /** Default polling interval for this lock in milliseconds. Defaults to global poll. */
    poll?: number;
}

/**
 * Options for acquiring or waiting for a lock.
 */
interface AcquireOptions {
    /** Max time to wait in milliseconds. Defaults to lock's timeout setting. */
    timeout?: number;
    /** Polling interval in milliseconds. Defaults to lock's poll setting. */
    poll?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LUA_SCRIPTS: Record<string, string> = {
    MUTEX_RELEASE: `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `,
    MUTEX_TTL: `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `,
    SEM_ACQUIRE: `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
      redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
      return 1
    else
      return 0
    end
  `,
    SEM_TTL: `
    return redis.call('ZADD', KEYS[1], 'XX', 'CH', ARGV[1], ARGV[2])
  `,
    SEM_CHECK: `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    return redis.call('ZCARD', KEYS[1])
  `
};

/**
 * A distributed lock implementation using Redis.
 * Supports both Mutex (exclusive) and Semaphore (concurrency > 1) locks.
 */
class RedisLock {
    static redisClient: RedisClient | null = null;
    static SHAS: Record<string, string> = {};
    static NOT_ACQUIRED = Symbol('LockNotAcquired');
    static defaultTimeout = 60000;
    static defaultPoll = 100;
    static defaultTTL = 60000;

    /**
     * Configures the RedisLock class with a Redis client.
     * Must be called before using any RedisLock instances.
     * @param client The Redis client instance.
     */
    static configure(client: RedisClient, { timeout = 60000, poll = 100, ttl = 60000 }: GlobalOptions = {}) {
        if (!client) throw new Error('Redis client required');
        this.redisClient = client;
        this.defaultTimeout = timeout;
        this.defaultPoll = poll;
        this.defaultTTL = ttl;
    }

    static async _getSHA(name: string) {
        let sha = this.SHAS[name];
        if (sha) return sha;
        const script = LUA_SCRIPTS[name];
        const encoder = new TextEncoder();
        const data = encoder.encode(script);
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-1', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        sha = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        this.SHAS[name] = sha;
        return sha;
    }

    private concurrency: number;
    private ttl: number;
    private id: string;
    private isAcquired: boolean;
    private key: string;
    private client: RedisClient;
    private timeout: number;
    private poll: number;

    /**
     * Creates a new RedisLock instance.
     * @param lockName The name of the lock resource.
     * @param options Configuration options.
     * @param options.ttl Lock time-to-live in milliseconds. Defaults to 60000.
     * @param options.concurrency Number of concurrent holders allowed. Defaults to 1 (Mutex).
     * @param options.redis The Redis client instance. Defaults to the one configured with `configure`.
     * @param options.timeout Default timeout for acquiring this lock in milliseconds. Defaults to global timeout (60000).
     * @param options.poll Default polling interval for this lock in milliseconds. Defaults to global poll (100).
     */
    constructor(lockName: string, options: LockOptions = {}) {
        this.concurrency = options.concurrency || 1;
        this.ttl = options.ttl || (this.constructor as typeof RedisLock).defaultTTL;
        this.timeout = options.timeout || (this.constructor as typeof RedisLock).defaultTimeout;
        this.poll = options.poll || (this.constructor as typeof RedisLock).defaultPoll;
        // Lightweight unique ID generation
        this.id = Math.random().toString(36).substring(2);
        this.isAcquired = false;

        const prefix = this.concurrency === 1 ? 'mutex' : 'sem';
        this.key = `${prefix}:${lockName}`;

        const redisClient = options.redis || (this.constructor as typeof RedisLock).redisClient;
        if (!redisClient) throw new Error('RedisLock not configured. Call RedisLock.configure(redis)');
        this.client = redisClient;
    }

    private async _exec(name: string, keys: string[], args: (string | number)[]): Promise<any> {
        try {
            const sha = await (this.constructor as typeof RedisLock)._getSHA(name);
            return await this.client.evalsha(sha, keys.length, ...keys, ...args);
        } catch (e) {
            return await this.client.eval(LUA_SCRIPTS[name], keys.length, ...keys, ...args);
        }
    }

    /**
     * Attempts to acquire the lock immediately without waiting.
     * @returns True if acquired, false otherwise.
     */
    async tryAcquire(): Promise<boolean> {
        if (this.concurrency === 1) {
            const res = await this.client.set(this.key, this.id, 'NX', 'PX', this.ttl);
            this.isAcquired = res === 'OK';
        } else {
            const now = Date.now();
            const res = await this._exec('SEM_ACQUIRE', [this.key], [now, this.concurrency, now + this.ttl, this.id]);
            this.isAcquired = res === 1;
        }
        return this.isAcquired;
    }

    /**
     * Attempts to acquire the lock, waiting up to `timeout` if necessary.
     * @param options Acquisition options.
     * @param options.timeout Max time to wait in ms. Defaults to 60000.
     * @param options.poll Polling interval in ms. Defaults to 100.
     * @throws Error if timeout is reached.
     * @returns True if acquired.
     */
    async acquire({ timeout, poll }: AcquireOptions = {}): Promise<boolean> {
        if (!timeout) timeout = this.timeout;
        if (!poll) poll = this.poll;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await this.tryAcquire()) return true;
            await sleep(poll);
        }
        throw new Error(`Timeout acquiring lock: ${this.key}`);
    }

    /**
     * Releases the lock.
     */
    async release(): Promise<void> {
        if (!this.isAcquired) return;
        if (this.concurrency === 1) {
            await this._exec('MUTEX_RELEASE', [this.key], [this.id]);
        } else {
            await this.client.zrem(this.key, this.id);
        }
        this.isAcquired = false;
    }

    /**
     * Sets the lock TTL.
     * @param ms Milliseconds to set as TTL.
     * @throws Error if not holding lock or extension fails.
     */
    async setTTL(ms: number): Promise<void> {
        if (!this.isAcquired) throw new Error("Not holding lock");
        let success = 0;
        if (this.concurrency === 1) {
            success = await this._exec('MUTEX_TTL', [this.key], [this.id, ms]);
        } else {
            success = await this._exec('SEM_TTL', [this.key], [Date.now() + ms, this.id]);
        }
        if (!success) throw new Error("Lock expired or lost; extension failed");
    }

    /**
     * Waits for the lock to become free (but does not acquire it).
     * @param options Wait options.
     * @throws Error if timeout is reached.
     */
    async wait({ timeout, poll }: AcquireOptions = {}): Promise<true> {
        if (!timeout) timeout = this.timeout;
        if (!poll) poll = this.poll;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const free = this.concurrency === 1
                ? (await this.client.exists(this.key)) === 0
                : (await this._exec('SEM_CHECK', [this.key], [Date.now()])) < this.concurrency;

            if (free) return true;
            await sleep(poll);
        }
        throw new Error(`Wait timeout for ${this.key}`);
    }

    /**
     * Acquire lock, run a function, and release automatically.
     * @param fn The function to execute while holding the lock.
     * @param options Acquisition options.
     * @param options.timeout Max time to wait in ms. Defaults to 60000.
     * @param options.poll Polling interval in ms. Defaults to 100.
     * @returns The result of fn().
     */
    async run<T>(fn: () => Promise<T> | T, options?: AcquireOptions): Promise<T> {
        await this.acquire(options);
        try {
            return await fn();
        } finally {
            await this.release();
        }
    }

    /**
     * Attempts to acquire the lock immediately. If successful, runs the function and releases the lock.
     * If lock cannot be acquired, returns false.
     * @param fn The function to execute while holding the lock.
     * @returns The result of fn() or false if lock not acquired.
     */
    async tryRun<T>(fn: () => Promise<T> | T): Promise<T | false> {
        try {
            const acquired = await this.tryAcquire();
            if (!acquired) return false;
        } catch (e) {
            console.error('Failed to acquire lock:', e);
            return false;
        }
        try {
            return await fn();
        } finally {
            try {
                await this.release();
            } catch (e) {
                console.error('Failed to release lock:', e);
            }
        }
    }
}

export default RedisLock;
export { RedisLock, LockOptions, AcquireOptions, RedisClient };
