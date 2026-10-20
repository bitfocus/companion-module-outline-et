import { createSocket, type Socket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import type { RequestScheduler, Turn } from './request-scheduler.js'

export interface UdpLinkEvents {
	datagram: [data: Buffer]
	error: [error: Error]
	/** The socket is bound, on this local port. */
	listening: [port: number]
	/** The preferred local port could not be bound: an automatic port is used instead. */
	fallback: [port: number, reason: string]
}

export interface SendOptions {
	/** Skip the queue, the spacing and the requests in flight: for STOP only. */
	immediate?: boolean
	/** Aborting while the frame waits for its turn drops it unsent. */
	signal?: AbortSignal
	/** Called when the frame is handed to the socket, with the turn to release on its reply. */
	onSent?: (turn: Turn) => void
}

interface BindWaiter {
	resolve: (socket: Socket) => void
	reject: (error: Error) => void
}

/**
 * The only socket to one turntable: one local port, bound for the whole
 * connection, for both the command port and the position port, so that the
 * module takes as few of the turntable's connections as possible. The
 * preferred local port is the same at every restart; when it is taken, an
 * automatic port is used and `fallback` is emitted. Only datagrams sent by
 * the turntable's address are delivered; replies are told apart by their
 * length, not by their source port, as in ET Controller for legacy ET250-3D
 * units.
 *
 * Node's own UDP socket is used because the Companion UDP helper sends to a
 * single destination port.
 */
export class UdpLink extends EventEmitter<UdpLinkEvents> {
	private socket: Socket | null = null
	private listening = false
	/** No local port could be bound, not even an automatic one: later sends fail with this error at once. */
	private bindError: Error | null = null
	private bindWaiters: BindWaiter[] = []

	constructor(
		readonly host: string,
		private readonly scheduler: RequestScheduler,
		/** 0 for an automatic port. */
		private readonly preferredPort = 0,
	) {
		super()
	}

	open(): void {
		this.close()
		this.bind(this.preferredPort)
	}

	/** Send `frame` to `port` of the turntable in its turn, or at once when `immediate`. */
	async send(frame: Buffer, port: number, options: SendOptions = {}): Promise<void> {
		// Binding (including the fallback) is preparation, not a send turn.
		// No reply timer or spacing timestamp may start before the socket is ready.
		const socket = await this.bound(options.signal)
		const handOff = async (turn: Turn): Promise<void> => {
			options.signal?.throwIfAborted()
			if (this.socket !== socket || !this.listening) throw new Error(`UDP link to ${this.host} is closed`)
			// Nothing yields between the cancellation/generation checks and socket.send.
			options.onSent?.(turn)
			await new Promise<void>((resolve, reject) => {
				socket.send(frame, port, this.host, (error) => (error ? reject(error) : resolve()))
			})
		}
		if (options.immediate) await this.scheduler.now(handOff)
		else await this.scheduler.inTurn(handOff, options.signal)
	}

	close(): void {
		const socket = this.socket
		this.socket = null
		this.listening = false
		this.rejectBindWaiters(new Error(`UDP link to ${this.host} is closed`))
		if (socket) closeQuietly(socket)
	}

	private bind(port: number): void {
		const socket = createSocket('udp4')
		this.socket = socket
		this.listening = false
		this.bindError = null
		socket.on('message', (data, remote) => {
			if (this.socket === socket && remote.address === this.host) this.emit('datagram', data)
		})
		socket.on('listening', () => {
			if (this.socket !== socket) return
			this.listening = true
			const waiters = this.bindWaiters
			this.bindWaiters = []
			for (const waiter of waiters) waiter.resolve(socket)
			this.emit('listening', socket.address().port)
		})
		socket.on('error', (error: NodeJS.ErrnoException) => {
			if (this.socket !== socket) return
			if (!this.listening && port !== 0) {
				// Taken, typically by another connection to the same turntable.
				closeQuietly(socket)
				this.emit('fallback', port, error.code ?? error.message)
				this.bind(0)
				return
			}
			if (!this.listening) {
				this.bindError = error
				this.rejectBindWaiters(error)
			}
			this.emit('error', error)
		})
		socket.bind(port)
	}

	/**
	 * The socket once it is bound. A frame is never queued on a socket still
	 * binding: Node drops such frames silently when the bind fails. When no
	 * port could be bound, the bind error at once: no bind is left to wait for.
	 */
	private async bound(signal?: AbortSignal): Promise<Socket> {
		signal?.throwIfAborted()
		if (!this.socket) throw new Error(`UDP link to ${this.host} is closed`)
		if (this.bindError) throw this.bindError
		if (this.listening) return this.socket
		return new Promise<Socket>((resolve, reject) => {
			const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
			const waiter: BindWaiter = {
				resolve: (socket) => {
					cleanup()
					resolve(socket)
				},
				reject: (error) => {
					cleanup()
					reject(error)
				},
			}
			const onAbort = (): void => {
				this.bindWaiters = this.bindWaiters.filter((entry) => entry !== waiter)
				cleanup()
				const reason: unknown = signal?.reason
				reject(reason instanceof Error ? reason : new Error('Aborted'))
			}
			this.bindWaiters.push(waiter)
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	private rejectBindWaiters(error: Error): void {
		const waiters = this.bindWaiters
		this.bindWaiters = []
		for (const waiter of waiters) waiter.reject(error)
	}
}

function closeQuietly(socket: Socket): void {
	try {
		socket.close()
	} catch {
		// Already closed after an error.
	}
}
