import { LRUCache } from 'lru-cache'

export const makeMutex = () => {
	let current: Promise<void> | null = null

	return {
		async mutex<T>(code: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
			const prev = current

			// Create a new "signal" promise to mark when this one is done
			let release!: () => void
			const next = new Promise<void>(resolve => (release = resolve))
			current = next

			if (prev) {
				try {
					await prev
				} catch {
					// swallow previous error
				}
			}

			let timeout: NodeJS.Timeout | undefined
			try {
				if (timeoutMs) {
					timeout = setTimeout(() => {
						console.warn('Mutex task timed out after', timeoutMs, 'ms')
					}, timeoutMs)
				}

				return await code()
			} finally {
				if (timeout) clearTimeout(timeout)
				release() // allow next task to continue
			}
		},
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
