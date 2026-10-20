import type { Turn } from './request-scheduler.js'
import type { UdpLink } from './udp-link.js'

interface PendingRequest {
	replyLength: number
	resolve: (reply: Buffer | null) => void
	reject: (error: Error) => void
	/** Armed when the frame leaves: the timeout does not count the wait for the send turn. */
	timer: ReturnType<typeof setTimeout> | null
	/** Drops the frame while it still waits for its send turn. */
	abort: AbortController
	/** Held from the send until the reply or the timeout. */
	turn: Turn | null
}

/** The pending request gave way, typically to a STOP. */
export class CommandCancelledError extends Error {
	constructor(
		/** False when the frame never left this computer: it cannot have had any effect. */
		readonly sent: boolean,
	) {
		super(sent ? 'Command cancelled before its reply' : 'Command cancelled before it was sent')
		this.name = 'CommandCancelledError'
	}
}

/**
 * Request/response exchange on the command port, through the turntable's
 * UDP link. The protocol has no sequence numbers, so a reply is recognised
 * by its length only: one request is in flight at a time, and datagrams that
 * arrive while nothing has been sent are dropped, as ET Controller drains its
 * socket before every command.
 */
export class CommandChannel {
	private pending: PendingRequest | null = null
	private closed = false

	constructor(
		private readonly link: UdpLink,
		private readonly port: number,
	) {
		link.on('datagram', (data) => this.onDatagram(data))
	}

	get busy(): boolean {
		return this.pending !== null
	}

	/**
	 * Send `frame` in its turn and wait for a reply of `replyLength` bytes.
	 * Resolves null on timeout; rejects with CommandCancelledError when
	 * `cancel()` is called, and with the socket error when the frame cannot be
	 * sent. `immediate` skips the queue and the spacing: for STOP only.
	 */
	async request(frame: Buffer, replyLength: number, timeoutMs: number, immediate = false): Promise<Buffer | null> {
		if (this.closed) throw new Error('Command channel is closed')
		if (this.pending) throw new Error('Another command is still waiting for its reply')
		let pending!: PendingRequest
		const reply = new Promise<Buffer | null>((resolve, reject) => {
			pending = { replyLength, resolve, reject, timer: null, abort: new AbortController(), turn: null }
			this.pending = pending
		})
		// The caller observes the outcome through the returned promise; this only
		// keeps a cancellation before the send from counting as unhandled.
		reply.catch(() => undefined)
		const onSent = (turn: Turn): void => {
			pending.turn = turn
			pending.timer = setTimeout(() => {
				// Also for a request already cancelled: its turn ends when its reply is no longer awaited.
				turn.done()
				this.settle(pending, null)
			}, timeoutMs)
		}
		// A late send error, or the abort of a cancelled frame, only settles the
		// request that initiated that send.
		void this.link
			.send(frame, this.port, { immediate, signal: pending.abort.signal, onSent })
			.catch((error: unknown) => this.fail(pending, asError(error)))
		return reply
	}

	/**
	 * Give up on the pending request. A frame still waiting for its send turn
	 * is dropped and never reaches the turntable. A frame already sent keeps its
	 * turn until its reply would have timed out: the turntable may still be
	 * answering it.
	 */
	cancel(): void {
		const pending = this.pending
		if (!pending) return
		this.pending = null
		pending.abort.abort()
		pending.reject(new CommandCancelledError(pending.turn !== null))
	}

	/** Cancel the pending request when the session ends. The session closes the link. */
	close(): void {
		if (this.closed) return
		this.closed = true
		const pending = this.pending
		this.cancel()
		if (pending?.timer) clearTimeout(pending.timer)
		pending?.turn?.done()
	}

	private onDatagram(data: Buffer): void {
		const pending = this.pending
		if (pending?.turn && data.length === pending.replyLength) this.settle(pending, data)
	}

	private settle(pending: PendingRequest, reply: Buffer | null): void {
		if (this.pending !== pending) return
		this.pending = null
		if (pending.timer) clearTimeout(pending.timer)
		pending.turn?.done()
		pending.resolve(reply)
	}

	private fail(pending: PendingRequest, error: Error): void {
		if (pending.timer) clearTimeout(pending.timer)
		pending.turn?.done()
		if (this.pending !== pending) return
		this.pending = null
		pending.reject(error)
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
