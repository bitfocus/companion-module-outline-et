import { setTimeout as delay } from 'node:timers/promises'

/** The right to have one request waiting for its reply at the turntable. */
export interface Turn {
	/** The reply arrived, the request timed out or it was given up. Idempotent. */
	done(): void
}

/**
 * Requests to one turntable leave one at a time, in the order they were
 * asked for: a request waits until no other one is waiting for its reply,
 * and until `spacingMs` have passed since the previous datagram. A STOP
 * leaves at once, even with a request in flight, and the requests after it
 * keep their distance from it.
 *
 * Every turn must be released with `done()`. A turn held longer than
 * `holdLimitMs` is released anyway and reported, so that a forgotten turn
 * cannot stop the traffic for good.
 */
export class RequestScheduler {
	private lastSentAt = -Infinity
	private queue: Promise<void> = Promise.resolve()
	private readonly held = new Set<HeldTurn>()
	private idleWaiters: (() => void)[] = []

	constructor(
		private readonly spacingMs: number,
		private readonly holdLimitMs: number,
		private readonly onForcedRelease: () => void = () => undefined,
	) {}

	/** Requests waiting for their reply right now. */
	get inFlight(): number {
		return this.held.size
	}

	/**
	 * Call `send` in turn. When `signal` aborts first, `send` is never called
	 * and the returned promise rejects; the requests queued after it go on. A
	 * failed send releases its turn.
	 */
	async inTurn(send: (turn: Turn) => Promise<void>, signal?: AbortSignal): Promise<void> {
		const previous = this.queue
		let release!: () => void
		this.queue = new Promise<void>((resolve) => {
			release = resolve
		})
		let sending: Promise<void>
		try {
			await previous
			for (;;) {
				signal?.throwIfAborted()
				if (this.held.size > 0) {
					await this.idle(signal)
					continue
				}
				// The timer may fire a little early: check the monotonic clock again.
				const waitMs = this.lastSentAt + this.spacingMs - performance.now()
				if (waitMs <= 0) break
				await delay(waitMs, undefined, { signal })
			}
			// Nothing yields between the last checks and the hand-off.
			sending = this.handOff(send)
		} finally {
			release()
		}
		await sending
	}

	/** Send at once, ahead of the queue, the spacing and the requests in flight: for STOP only. */
	async now(send: (turn: Turn) => Promise<void>): Promise<void> {
		await this.handOff(send)
	}

	/** Forget local turns when the connection closes; the session guards replies on a reused port. */
	releaseAll(): void {
		for (const turn of [...this.held]) turn.release(false)
	}

	private async handOff(send: (turn: Turn) => Promise<void>): Promise<void> {
		this.lastSentAt = performance.now()
		const turn = new HeldTurn(this, this.holdLimitMs)
		this.held.add(turn)
		try {
			await send(turn)
		} catch (error) {
			turn.done()
			throw error
		}
	}

	/** @internal */
	released(turn: HeldTurn, forced: boolean): void {
		if (!this.held.delete(turn)) return
		if (forced) this.onForcedRelease()
		if (this.held.size > 0) return
		const waiters = this.idleWaiters
		this.idleWaiters = []
		for (const resolve of waiters) resolve()
	}

	private async idle(signal?: AbortSignal): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== done)
				reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'))
			}
			const done = (): void => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}
			this.idleWaiters.push(done)
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}
}

class HeldTurn implements Turn {
	private readonly limit: ReturnType<typeof setTimeout>
	private releasedAlready = false

	constructor(
		private readonly scheduler: RequestScheduler,
		holdLimitMs: number,
	) {
		this.limit = setTimeout(() => this.release(true), holdLimitMs)
	}

	done(): void {
		this.release(false)
	}

	release(forced: boolean): void {
		if (this.releasedAlready) return
		this.releasedAlready = true
		clearTimeout(this.limit)
		this.scheduler.released(this, forced)
	}
}
