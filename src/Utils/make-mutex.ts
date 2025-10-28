import { LRUCache } from 'lru-cache'

export const makeMutex = () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let task = Promise.resolve() as Promise<any>

	let taskTimeout: NodeJS.Timeout | undefined
	let chainLength = 0  // Track promise chain length

	return {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			chainLength++

			// Performance fix: Break promise chain every 50 operations to prevent memory buildup
			// Without this, the chain grows indefinitely: Promise1000 → Promise999 → ... → Promise1
			if (chainLength >= 50) {
				const previousTask = task
				// Wait for previous task, then break the chain by resetting to a fresh Promise
				task = previousTask.then(() => {
					chainLength = 0
					return Promise.resolve()
				}, () => {
					// Also break chain on error
					chainLength = 0
					return Promise.resolve()
				})
			}

			task = (async () => {
				// wait for the previous task to complete
				// if there is an error, we swallow so as to not block the queue
				try {
					await task
				} catch {}

				try {
					// execute the current task
					const result = await code()
					return result
				} finally {
					clearTimeout(taskTimeout)
				}
			})()
			// we replace the existing task, appending the new piece of execution to it
			// so the next task will have to wait for this one to finish
			return task
		}
	}
}

export type Mutex = ReturnType<typeof makeMutex>

/**
 * Performance fix: Use LRU cache to prevent unbounded growth of mutex map
 * Old mutexes for inactive users will be automatically evicted
 */
export const makeKeyedMutex = () => {
	// LRU cache with max 1000 mutexes, 30 minute TTL
	const mutexCache = new LRUCache<string, Mutex>({
		max: 1000, // Maximum number of concurrent mutexes
		ttl: 30 * 60 * 1000, // 30 minutes - evict inactive mutexes
		updateAgeOnGet: true, // Keep active mutexes longer
		ttlAutopurge: true // Automatically clean up expired entries
	})

	return {
		mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			let keyMutex = mutexCache.get(key)
			if (!keyMutex) {
				keyMutex = makeMutex()
				mutexCache.set(key, keyMutex)
			}

			return keyMutex.mutex(task)
		}
	}
}
