import { LRUCache } from 'lru-cache'
import PQueue from 'p-queue'
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../Types'
import type { ILogger } from './logger'

/**
 * Manages pre-key operations with proper concurrency control
 */
export class PreKeyManager {
	// Performance fix: Use LRU cache with TTL to prevent unbounded queue growth
	private readonly queues = new LRUCache<string, PQueue>({
		max: 50, // Maximum number of key type queues
		ttl: 10 * 60 * 1000, // 10 minutes - clean up inactive queues
		updateAgeOnGet: true,
		ttlAutopurge: true,
		dispose: (queue) => {
			// Clean up queue when evicted
			queue.clear()
		}
	})

	constructor(
		private readonly store: SignalKeyStore,
		private readonly logger: ILogger
	) {}

	/**
	 * Get or create a queue for a specific key type
	 */
	private getQueue(keyType: string): PQueue {
		let queue = this.queues.get(keyType)
		if (!queue) {
			queue = new PQueue({ concurrency: 1 })
			this.queues.set(keyType, queue)
		}

		return queue
	}

	/**
	 * Process pre-key operations (updates and deletions)
	 */
	async processOperations(
		data: SignalDataSet,
		keyType: keyof SignalDataTypeMap,
		transactionCache: SignalDataSet,
		mutations: SignalDataSet,
		isInTransaction: boolean
	): Promise<void> {
		const keyData = data[keyType]
		if (!keyData) return

		return this.getQueue(keyType).add(async () => {
			// Ensure structures exist
			transactionCache[keyType] = transactionCache[keyType] || ({} as any)
			mutations[keyType] = mutations[keyType] || ({} as any)

			// Separate deletions from updates
			const deletions: string[] = []
			const updates: Record<string, any> = {}

			for (const keyId in keyData) {
				if (keyData[keyId] === null) {
					deletions.push(keyId)
				} else {
					updates[keyId] = keyData[keyId]
				}
			}

			// Process updates (no validation needed)
			if (Object.keys(updates).length > 0) {
				Object.assign(transactionCache[keyType]!, updates)
				Object.assign(mutations[keyType]!, updates)
			}

			// Process deletions with validation
			if (deletions.length > 0) {
				await this.processDeletions(keyType, deletions, transactionCache, mutations, isInTransaction)
			}
		})
	}

	/**
	 * Process deletions with validation
	 */
	private async processDeletions(
		keyType: keyof SignalDataTypeMap,
		ids: string[],
		transactionCache: SignalDataSet,
		mutations: SignalDataSet,
		isInTransaction: boolean
	): Promise<void> {
		if (isInTransaction) {
			// In transaction, only allow deletion if key exists in cache
			for (const keyId of ids) {
				if (transactionCache[keyType]?.[keyId]) {
					transactionCache[keyType][keyId] = null
					mutations[keyType]![keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
				}
			}
		} else {
			// Outside transaction, validate against store
			const existingKeys = await this.store.get(keyType, ids)
			for (const keyId of ids) {
				if (existingKeys[keyId]) {
					transactionCache[keyType]![keyId] = null
					mutations[keyType]![keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
				}
			}
		}
	}

	/**
	 * Validate and process pre-key deletions outside transactions
	 */
	async validateDeletions(data: SignalDataSet, keyType: keyof SignalDataTypeMap): Promise<void> {
		const keyData = data[keyType]
		if (!keyData) return

		return this.getQueue(keyType).add(async () => {
			// Find all deletion requests
			const deletionIds = Object.keys(keyData).filter(id => keyData[id] === null)
			if (deletionIds.length === 0) return

			// Validate deletions
			const existingKeys = await this.store.get(keyType, deletionIds)
			for (const keyId of deletionIds) {
				if (!existingKeys[keyId]) {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
					delete data[keyType]![keyId]
				}
			}
		})
	}

	/**
	 * Performance fix: Clear all queues to free memory (useful for cleanup/testing)
	 */
	clearAllQueues(): void {
		this.queues.clear()
		this.logger.debug('Cleared all pre-key queues')
	}
}
