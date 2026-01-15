import RedisLock from '../dist/index.mjs';
import assert from 'node:assert';
import { describe, it, before } from 'node:test';

/**
 * A mock Redis client that behaviors sufficiently like Redis for our tests.
 * It simulates locking logic using in-memory state.
 */
class MockRedis {
    constructor() {
        this.store = new Map(); // key -> { value, expires }
        this.sets = new Map(); // key -> Set<{member, score}> for zsets
    }

    async evalsha(sha, numKeys, ...args) {
        const keys = args.slice(0, numKeys);
        const scriptArgs = args.slice(numKeys);

        // Mutex Release: 1 key, 1 arg (id)
        if (numKeys === 1 && scriptArgs.length === 1) {
            const key = keys[0];
            const id = scriptArgs[0];
            const item = this.store.get(key);
            if (item && item.value === id) {
                this.store.delete(key);
                return 1;
            }
            return 0;
        }

        // Mutex TTL: 1 key, 2 args (id, ms)
        if (numKeys === 1 && scriptArgs.length === 2 && typeof scriptArgs[1] === 'number') {
            const key = keys[0];
            const id = scriptArgs[0];
            const ms = scriptArgs[1];
            const item = this.store.get(key);
            if (item && item.value === id) {
                item.expires = Date.now() + ms;
                return 1;
            }
            return 0;
        }

        // Sem Acquire
        if (numKeys === 1 && scriptArgs.length === 4) {
            const key = keys[0];
            const [now, limit, expires, id] = scriptArgs;

            let set = this.sets.get(key) || [];
            set = set.filter(m => m.score > now); // Keep only not expired

            if (set.length < limit) {
                set.push({ member: id, score: expires });
                this.sets.set(key, set);
                return 1;
            }
            this.sets.set(key, set);
            return 0;
        }

        // Sem Check
        if (numKeys === 1 && scriptArgs.length === 1) {
            const key = keys[0];
            const now = scriptArgs[0];
            let set = this.sets.get(key) || [];
            set = set.filter(m => m.score > now);
            this.sets.set(key, set);
            return set.length;
        }

        throw new Error(`Unknown evalsha call: ${numKeys} keys, args: ${scriptArgs} `);
    }

    async eval(script, numKeys, ...args) {
        return this.evalsha('dummy', numKeys, ...args);
    }

    async set(key, value, ...args) {
        if (args[0] === 'NX' && args[1] === 'PX') {
            const ttl = args[2];
            if (this.store.has(key)) {
                const item = this.store.get(key);
                if (item.expires > Date.now()) return null;
            }
            this.store.set(key, { value, expires: Date.now() + ttl });
            return 'OK';
        }
        throw new Error('MockClient only supports set NX PX');
    }

    async zrem(key, member) {
        let set = this.sets.get(key) || [];
        const initialLen = set.length;
        set = set.filter(m => m.member !== member);
        this.sets.set(key, set);
        return initialLen - set.length;
    }

    async exists(key) {
        const item = this.store.get(key);
        if (item && item.expires > Date.now()) return 1;
        this.store.delete(key);
        return 0;
    }
}

describe('RedisLock Test Suite', () => {
    let client;

    before(() => {
        client = new MockRedis();
        RedisLock.configure(client, { poll: 10, timeout: 500 });
    });

    it('should acquire and release mutex (Test 1)', async () => {
        const lock = new RedisLock('test-mutex', { ttl: 1000 });
        const acquired = await lock.acquire();
        assert.strictEqual(acquired, true, 'Should acquire mutex');
        assert.strictEqual(await client.exists('mutex:test-mutex'), 1, 'Key should exist in redis');

        await lock.release();
        assert.strictEqual(await client.exists('mutex:test-mutex'), 0, 'Key should be removed after release');
    });

    it('should respect mutex exclusivity (Test 2)', async () => {
        const lock1 = new RedisLock('test-mutex-2');
        const lock2 = new RedisLock('test-mutex-2');

        await lock1.acquire();
        const acquired2 = await lock2.tryAcquire();
        assert.strictEqual(acquired2, false, 'Should not acquire held mutex');

        await lock1.release();
        const acquired2Retry = await lock2.tryAcquire();
        assert.strictEqual(acquired2Retry, true, 'Should acquire released mutex');
        await lock2.release();
    });

    it('should handle semaphore concurrency (Test 3)', async () => {
        const semName = 'test-sem';
        const concurrency = 2;
        const s1 = new RedisLock(semName, { concurrency });
        const s2 = new RedisLock(semName, { concurrency });
        const s3 = new RedisLock(semName, { concurrency });

        assert.strictEqual(await s1.tryAcquire(), true, 'S1 should acquire');
        assert.strictEqual(await s2.tryAcquire(), true, 'S2 should acquire');
        assert.strictEqual(await s3.tryAcquire(), false, 'S3 should fail (limit reached)');

        await s1.release();
        assert.strictEqual(await s3.tryAcquire(), true, 'S3 should acquire after S1 release');

        await s2.release();
        await s3.release();
    });

    it('should run and auto-release with run helper (Test 4)', async () => {
        const lock = new RedisLock('test-run');
        let ran = false;
        await lock.run(async () => {
            ran = true;
            assert.strictEqual(await client.exists('mutex:test-run'), 1, 'Lock should be held during run');
        });
        assert.strictEqual(ran, true, 'Function should run');
        assert.strictEqual(await client.exists('mutex:test-run'), 0, 'Lock should be released after run');
    });

    it('should tryRun immediately or fail (Test 5)', async () => {
        const lock = new RedisLock('test-tryrun');

        // Success case
        const res = await lock.tryRun(() => 'success');
        assert.strictEqual(res, 'success', 'Should return function result');

        // Failure case (locked)
        const blocker = new RedisLock('test-tryrun');
        await blocker.acquire();

        const resFail = await lock.tryRun(() => 'should not run');
        assert.strictEqual(resFail, false, 'Should return false when locked');

        await blocker.release();
    });

    it('should wait for lock release (Test 6)', async () => {
        const lock = new RedisLock('test-wait');
        await lock.acquire();

        const waiter = new RedisLock('test-wait');
        const waitPromise = waiter.wait({ timeout: 200, poll: 10 });

        setTimeout(() => lock.release(), 50);

        await waitPromise;
        const exists = await client.exists('mutex:test-wait');
        assert.strictEqual(exists, 0, 'Lock should be free after wait returns');
    });

    it('should extend TTL (Test 7)', async () => {
        const lock = new RedisLock('test-ttl');
        await lock.acquire();

        await lock.setTTL(5000);
        const item = client.store.get('mutex:test-ttl');
        assert.ok(item.expires > Date.now() + 4000, 'TTL should be extended');

        await lock.release();
    });
});
