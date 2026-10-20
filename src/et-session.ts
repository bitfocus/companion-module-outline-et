import type { InstanceStatus, LogLevel } from '@companion-module/base'
import { setTimeout as delay } from 'node:timers/promises'
import {
	formatDegrees,
	halfDegreesToTenths,
	MOVE_GRANULARITY_DEGREES,
	planGoTo,
	wrapTenths,
	type GoToDirection,
	type GoToPlan,
} from './protocol/angles.js'
import { CommandCancelledError, CommandChannel } from './protocol/command-channel.js'
import {
	COMMAND_REPLY_LENGTH,
	MemoryBlock,
	POSITION_PORT_OFFSET,
	POSITION_REPLY_LENGTH,
	TENTHS_PER_TURN,
	type MemoryBlockName,
} from './protocol/constants.js'
import {
	encodeLoadMemory,
	encodeMove,
	encodeReadPosition,
	encodeSetZero,
	encodeStop,
	type Direction,
} from './protocol/frames.js'
import {
	decodeCommandReply,
	decodeIdentityBlock,
	decodePositionReply,
	decodeTurntableType,
	detectModel,
	type PositionReading,
} from './protocol/parser.js'
import { preferredLocalPort } from './protocol/local-port.js'
import { RequestScheduler, type Turn } from './protocol/request-scheduler.js'
import { UdpLink } from './protocol/udp-link.js'
import { SETTINGS, type SessionSettings } from './settings.js'
import {
	connectionStatus,
	createInitialState,
	currentMotion,
	currentReading,
	movementBlocker,
	type ConnectionTarget,
	type DeviceIdentity,
	type EtState,
	type PendingMove,
} from './state.js'

/**
 * Step limits: whole multiples of 0.5°, from 0.5° up to less than a full
 * turn (359.5° is the largest such multiple).
 */
export const STEP_MIN_DEGREES = 0.5
export const STEP_MAX_DEGREES = 359.5
const STEP_MIN_TENTHS = STEP_MIN_DEGREES * 10
const STEP_MAX_TENTHS = STEP_MAX_DEGREES * 10

/**
 * Fine adjustment (MAN in ET Controller, `MANUAL_STEP`): a fixed movement of
 * 5 tenths of a degree, the smallest step, with nothing to set.
 */
const NUDGE_TENTHS = 5
export const NUDGE_DEGREES = NUDGE_TENTHS / 10

/** The narrow view of the Companion instance that the session reports to. */
export interface SessionHost {
	log(level: LogLevel, message: string): void
	updateStatus(status: InstanceStatus, message: string | null): void
	/** State changed: publish variables and re-check feedbacks. */
	stateChanged(): void
}

// Consecutive failed position requests before the first warning, then one
// warning every POLL_WARNING_EVERY failures, as in ET Controller.
const POLL_FIRST_WARNING = 3
const POLL_WARNING_EVERY = 50

/** One connection: one UDP link, with one local port, for the command and the position ports. */
interface SessionRun {
	target: ConnectionTarget
	abort: AbortController
	link: UdpLink
	commands: CommandChannel
	/** No position request until the socket is bound and old replies have drained. */
	positionReadsAllowedAt: number | null
}

/**
 * Owns everything device-facing for one turntable: the command and telemetry
 * sockets, the position polling loop, the bounded identity reads, the motion
 * commands and the resulting state. The Companion instance reads `getState()`
 * and reacts to `stateChanged`.
 *
 * Motion rules: a movement is sent only after a dedicated position reading
 * shows the turntable stopped, one command at a time, never queued and never
 * sent again. STOP always goes out at once. Telemetry, not the command
 * acknowledgement, decides when a movement or a STOP has ended.
 *
 * Traffic rules, because the turntable supports a limited number of
 * connections: one local UDP port for everything, the same at every
 * restart; requests leave one at a
 * time, each once the previous one has its reply or has timed out; any two
 * datagrams are at least `sendSpacingMs` apart; a command leaves at least
 * `commandAfterMotionMs` after the end of the previous movement. STOP is
 * exempt from all of them.
 */
export class EtSession {
	private state: EtState = createInitialState()
	private run: SessionRun | null = null
	private pollTimer: ReturnType<typeof setTimeout> | null = null
	private replyTimer: ReturnType<typeof setTimeout> | null = null
	private expiryTimer: ReturnType<typeof setTimeout> | null = null
	private stopWindowTimer: ReturnType<typeof setTimeout> | null = null
	/** `performance.now()` of the unanswered position request; null once it is answered. */
	private positionRequestSentAt: number | null = null
	/** That request has been handed to the socket: only then can a reply be its own. */
	private positionRequestLeft = false
	/** Its turn among the requests to the turntable, held until its reply or its timeout. */
	private positionTurn: Turn | null = null
	/** That request waits for its send turn or for its reply, and has not timed out. */
	private positionRequestInFlight = false
	/** Callers waiting for the reply to the position request in flight. */
	private readingWaiters: ((reading: PositionReading | null) => void)[] = []
	private failedPolls = 0
	/** `performance.now()` of the first failed poll since the last valid reading. */
	private lossStartedAt: number | null = null
	private failSafeStopSent = false
	private socketErrorReported = false
	private identityCheckRunning = false
	/** `performance.now()` at the start of the last identity check. */
	private lastIdentityCheckAt: number | null = null
	/** A step, go-to or set-zero is between its first check and its outcome. */
	private commandInProgress = false
	/** `performance.now()` of the last STOP sent. */
	private lastStopSentAt: number | null = null
	/** `performance.now()` of the reading that showed the end of the last movement. */
	private motionEndedAt: number | null = null
	private publishedStatus: string | null = null

	/**
	 * Orders every request of the session, across reconnections too: the first
	 * request of a new connection keeps its distance from the last one of the
	 * previous connection.
	 */
	private readonly scheduler: RequestScheduler

	constructor(
		private readonly host: SessionHost,
		private readonly settings: SessionSettings = SETTINGS,
	) {
		// Every turn ends with a reply or a timeout; the limit only guards against a forgotten turn.
		const holdLimitMs = Math.max(settings.commandReplyTimeoutMs, settings.positionReplyTimeoutMs) * 4
		this.scheduler = new RequestScheduler(settings.sendSpacingMs, holdLimitMs, () =>
			this.host.log('debug', 'A request turn was not released in time: released by the safety limit'),
		)
	}

	getState(): Readonly<EtState> {
		return this.state
	}

	connect(target: ConnectionTarget): void {
		this.disconnect()
		const preferredPort = preferredLocalPort(target.host, this.settings.localPortBase)
		const link = new UdpLink(target.host, this.scheduler, preferredPort)
		const run: SessionRun = {
			target,
			abort: new AbortController(),
			link,
			commands: new CommandChannel(link, target.port),
			positionReadsAllowedAt: null,
		}
		this.run = run
		link.on('error', (error) => {
			if (this.run === run) this.reportSocketError(error)
		})
		link.on('datagram', (data) => this.onPositionDatagram(run, data))
		link.on('listening', (port) => {
			if (this.run !== run) return
			this.host.log('debug', `Local UDP port ${port} for ${target.host}`)
			// The fixed port may still receive replies from an earlier connection,
			// even after a process restart. With no position request outstanding,
			// those replies cannot become telemetry or confirm a STOP. STOP itself
			// remains available while ordinary reads wait for the guard.
			const guardMs = preferredPort !== 0 && port === preferredPort ? this.settings.positionRequestGuardMs : 0
			run.positionReadsAllowedAt = performance.now() + guardMs
			this.schedulePoll(guardMs)
		})
		link.on('fallback', (port, reason) => {
			if (this.run !== run) return
			this.host.log(
				'warn',
				`Local UDP port ${port} is not available (${reason}): an automatic port is used instead. Is another connection to this turntable open? Use one connection per turntable.`,
			)
		})
		link.open()

		// The first validity window also covers a turntable that never answers.
		this.armTelemetryExpiry()
		this.publish()
	}

	/**
	 * Close the sockets, cancel timers, pending reads and commands, and forget
	 * the turntable. Nothing interrupted is resumed by a later `connect`.
	 */
	disconnect(): void {
		const run = this.run
		this.run = null
		if (run) {
			run.abort.abort()
			run.commands.close()
			run.link.close()
		}
		// Release local bookkeeping; a new fixed-port connection drains old replies before polling.
		this.scheduler.releaseAll()
		this.positionTurn = null
		for (const timer of [this.pollTimer, this.replyTimer, this.expiryTimer, this.stopWindowTimer]) {
			if (timer) clearTimeout(timer)
		}
		this.pollTimer = null
		this.replyTimer = null
		this.expiryTimer = null
		this.stopWindowTimer = null
		this.settleReadingWaiters(null)
		this.positionRequestSentAt = null
		this.positionRequestLeft = false
		this.positionRequestInFlight = false
		this.failedPolls = 0
		this.lossStartedAt = null
		this.failSafeStopSent = false
		this.socketErrorReported = false
		this.identityCheckRunning = false
		this.lastIdentityCheckAt = null
		this.commandInProgress = false
		this.lastStopSentAt = null
		this.motionEndedAt = null
		this.publishedStatus = null
		this.state = createInitialState()
	}

	// ===== Motion commands =====

	/** Relative move from the current position. Resolves when the turntable confirms the command. */
	async step(direction: Direction, degrees: number): Promise<void> {
		const tenths = halfDegreesToTenths(degrees)
		const label = `Step ${directionSymbol(direction)} ${tenths === null ? String(degrees) : formatDegrees(tenths)}°`
		if (tenths === null || tenths < STEP_MIN_TENTHS || tenths > STEP_MAX_TENTHS) {
			throw this.fail(
				label,
				`the angle must be a multiple of ${MOVE_GRANULARITY_DEGREES}° from ${STEP_MIN_DEGREES}° to ${STEP_MAX_DEGREES}°`,
			)
		}
		await this.runMove(label, () => ({ direction, tenths }))
	}

	/** Fine adjustment: a fixed move of 0.5°, under the same rules as any other movement. */
	async nudge(direction: Direction): Promise<void> {
		const label = `Nudge ${directionSymbol(direction)} ${NUDGE_DEGREES}°`
		await this.runMove(label, () => ({ direction, tenths: NUDGE_TENTHS }))
	}

	/**
	 * Move to an absolute angle, a multiple of 0.5°; 360° is the same position
	 * as 0°. Nothing is sent when the turntable is already there.
	 */
	async goTo(degrees: number, direction: GoToDirection): Promise<void> {
		const target = halfDegreesToTenths(degrees)
		const where = target === null ? String(degrees) : formatDegrees(wrapTenths(target))
		const label = `Go to ${where}° (${direction === 'shortest' ? 'shortest path' : directionSymbol(direction)})`
		if (target === null || target < 0 || target > TENTHS_PER_TURN) {
			throw this.fail(label, `the angle must be a multiple of ${MOVE_GRANULARITY_DEGREES}° from 0° to 360°`)
		}
		await this.runMove(label, (current) => planGoTo(current, target, direction))
	}

	/**
	 * Send STOP at once, ahead of the spacing between datagrams, even while
	 * another command waits for its reply, which then gives way; a command
	 * still waiting for its send turn is dropped unsent. Every press is sent
	 * except presses closer than `stopCoalesceMs` to the previous STOP. The
	 * acknowledgement only confirms reception: the stop is confirmed by
	 * telemetry.
	 */
	async stopMotion(): Promise<void> {
		const run = this.run
		if (!run) throw new Error('STOP not sent: no turntable is configured')
		const now = performance.now()
		if (this.lastStopSentAt !== null && now - this.lastStopSentAt < this.settings.stopCoalesceMs) return

		run.commands.cancel()
		this.lastStopSentAt = now
		this.beginStopConfirmation()

		let reply: Buffer | null
		try {
			reply = await run.commands.request(encodeStop(), COMMAND_REPLY_LENGTH, this.settings.commandReplyTimeoutMs, true)
		} catch (error) {
			// A newer STOP took the channel, or the connection closed.
			if (error instanceof CommandCancelledError) return
			const message = `STOP could not be sent: ${errorMessage(error)}`
			this.host.log('error', message)
			throw new Error(message, { cause: error })
		}
		if (this.run !== run) return

		const outcome = reply ? decodeCommandReply(reply) : 'timeout'
		if (outcome === 'ack') {
			this.host.log('info', 'STOP received by the turntable; telemetry will confirm the stop')
			return
		}
		const message = outcome === 'nack' ? 'The turntable refused the STOP' : 'No reply to STOP'
		this.host.log('error', `${message}: the stop is confirmed only by telemetry`)
		throw new Error(message)
	}

	/**
	 * Define the current position as 0° (RESET TO 0 in ET Controller). Sent
	 * only while the turntable is stopped, like a movement; a position read
	 * afterwards must show 0°.
	 */
	async setZero(): Promise<void> {
		const label = 'Set zero'
		await this.withStoppedTurntable(label, async (run, before) => {
			let reply: Buffer | null
			try {
				reply = await run.commands.request(encodeSetZero(), COMMAND_REPLY_LENGTH, this.settings.commandReplyTimeoutMs)
			} catch (error) {
				if (this.run !== run) throw this.fail(label, 'the connection was restarted', error)
				if (error instanceof CommandCancelledError) throw this.fail(label, interruption(error), error)
				throw this.fail(label, `the command could not be sent (${errorMessage(error)})`, error)
			}
			if (this.run !== run) throw this.fail(label, 'the connection was restarted')
			const outcome = reply ? decodeCommandReply(reply) : 'timeout'
			if (outcome === 'nack') throw this.fail(label, 'the turntable refused the command')

			// A reply already in flight may predate the command: read again if needed.
			let after = await this.freshReading()
			if (after && after.tenths !== 0) after = await this.freshReading()
			if (this.run !== run) throw this.fail(label, 'the connection was restarted')
			if (after && after.tenths === 0 && !after.moving) {
				this.host.log('info', `${label}: the turntable now reports 0.0° (it was at ${formatDegrees(before.tenths)}°)`)
				return
			}
			const found = after ? `${after.moving ? 'moving at' : 'at'} ${formatDegrees(after.tenths)}°` : 'no position reply'
			const reception = outcome === 'ack' ? 'confirmed by the turntable' : 'not confirmed by the turntable'
			throw this.fail(label, `${reception}, but the turntable reports ${found}`)
		})
	}

	private async runMove(label: string, plan: (currentTenths: number) => GoToPlan): Promise<void> {
		await this.withStoppedTurntable(label, async (run, reading) => {
			const { direction, tenths } = plan(reading.tenths)
			if (tenths === 0) {
				this.host.log('info', `${label}: already there, nothing sent`)
				return
			}
			await this.sendMove(run, label, direction, tenths, reading.tenths)
		})
	}

	/**
	 * Run a command that needs the turntable stopped: refused unless nothing
	 * blocks it, then checked again on a dedicated reading, because the front
	 * panel or ET Controller may have started a movement since the last poll.
	 * One such command at a time; a STOP pressed meanwhile cancels it.
	 */
	private async withStoppedTurntable(
		label: string,
		command: (run: SessionRun, reading: PositionReading) => Promise<void>,
	): Promise<void> {
		const run = this.run
		if (!run) throw this.fail(label, 'no turntable is configured')
		if (this.commandInProgress || run.commands.busy) throw this.fail(label, 'another command is in progress')
		const blocker = movementBlocker(this.state)
		if (blocker) throw this.fail(label, blocker)

		const pressedAt = performance.now()
		this.commandInProgress = true
		try {
			const reading = await this.freshReading()
			this.checkNotInterrupted(run, label, pressedAt)
			if (!reading) throw this.fail(label, 'no fresh position reply from the turntable')
			const blockerNow = movementBlocker(this.state)
			if (blockerNow) throw this.fail(label, blockerNow)
			await this.pauseAfterMotion(run)
			this.checkNotInterrupted(run, label, pressedAt)
			await command(run, reading)
		} finally {
			if (this.run === run) this.commandInProgress = false
		}
	}

	/** A restart or a STOP since the press ends a command that has not been sent yet. */
	private checkNotInterrupted(run: SessionRun, label: string, pressedAt: number): void {
		if (this.run !== run) throw this.fail(label, 'the connection was restarted')
		if (this.lastStopSentAt !== null && this.lastStopSentAt >= pressedAt) {
			throw this.fail(label, 'interrupted by STOP before it was sent')
		}
	}

	/** Keep `commandAfterMotionMs` between the end of the last movement and the next command. */
	private async pauseAfterMotion(run: SessionRun): Promise<void> {
		for (;;) {
			const endedAt = this.motionEndedAt
			if (endedAt === null) return
			const waitMs = endedAt + this.settings.commandAfterMotionMs - performance.now()
			if (waitMs <= 0) return
			try {
				await delay(waitMs, undefined, { signal: run.abort.signal })
			} catch {
				// Disconnected: the caller reports the restart.
				return
			}
		}
	}

	private async sendMove(
		run: SessionRun,
		label: string,
		direction: Direction,
		tenths: number,
		fromTenths: number,
	): Promise<void> {
		const sentAt = performance.now()
		const move: PendingMove = { direction, fromTenths, sentAt, uncertain: true, started: false }
		let reply: Buffer | null
		try {
			reply = await run.commands.request(
				encodeMove(direction, tenths),
				COMMAND_REPLY_LENGTH,
				this.settings.commandReplyTimeoutMs,
			)
		} catch (error) {
			if (this.run !== run) throw this.fail(label, 'the connection was restarted', error)
			if (error instanceof CommandCancelledError) {
				// A STOP took the channel. A move already sent may have started;
				// one still waiting for its send turn never left.
				if (error.sent) this.beginPendingMove(move)
				throw this.fail(label, interruption(error), error)
			}
			// The frame did not leave this computer: nothing can have started.
			throw this.fail(label, `the command could not be sent (${errorMessage(error)})`, error)
		}
		if (this.run !== run) throw this.fail(label, 'the connection was restarted')

		const outcome = reply ? decodeCommandReply(reply) : 'timeout'
		if (outcome === 'nack') throw this.fail(label, 'the turntable refused the command')
		this.beginPendingMove({ ...move, uncertain: outcome !== 'ack' })
		if (outcome === 'ack') {
			this.host.log('info', `${label}: confirmed by the turntable`)
			return
		}
		const message = `${label}: no confirmation from the turntable. It may be moving: the position is monitored and the command is not sent again.`
		this.host.log('warn', message)
		throw new Error(message)
	}

	private beginPendingMove(move: PendingMove): void {
		this.state.pendingMove = move
		// Follow the move closely. A request already in flight reschedules on its
		// reply, and a STOP being confirmed keeps its own faster cadence.
		if (!this.positionRequestInFlight && this.state.stop === 'none') this.schedulePoll(this.settings.pollMovingMs)
		this.publish()
	}

	private beginStopConfirmation(): void {
		this.state.stop = 'confirming'
		this.clearStopWindow()
		const windowMs =
			this.settings.stopConfirmIntervalMs * this.settings.stopConfirmAttempts + this.settings.positionReplyTimeoutMs
		this.stopWindowTimer = setTimeout(() => {
			this.stopWindowTimer = null
			this.onStopNotConfirmed()
		}, windowMs)
		if (!this.positionRequestInFlight) this.schedulePoll(this.settings.stopConfirmIntervalMs)
		this.publish()
	}

	private onStopNotConfirmed(): void {
		if (!this.run || this.state.stop !== 'confirming') return
		this.state.stop = 'unconfirmed'
		this.host.log(
			'error',
			'SAFETY WARNING: STOP not confirmed by telemetry. Keep the area clear; movements stay blocked until the turntable reports it has stopped. The network STOP is not an emergency stop.',
		)
		this.publish()
	}

	private clearStopWindow(): void {
		if (this.stopWindowTimer) clearTimeout(this.stopWindowTimer)
		this.stopWindowTimer = null
	}

	/**
	 * Sustained telemetry loss while the turntable was moving: send one STOP,
	 * as ET Controller does, then keep reading slowly. The stop is declared
	 * only when telemetry confirms it.
	 */
	private checkFailSafe(): void {
		if (this.failSafeStopSent || this.lossStartedAt === null) return
		const wasMoving = this.state.pendingMove !== null || this.state.telemetry?.moving === true
		if (!wasMoving || this.failedPolls < this.settings.failSafeFailedPolls) return
		if (performance.now() - this.lossStartedAt < this.settings.failSafeLossMs) return

		this.failSafeStopSent = true
		if (this.state.stop !== 'none') {
			this.host.log('error', 'SAFETY: telemetry lost while moving; the STOP already sent is still unconfirmed')
			return
		}
		this.host.log('error', 'SAFETY: telemetry lost while the turntable was moving; one STOP sent automatically')
		// stopMotion logs its own failures.
		void this.stopMotion().catch(() => undefined)
	}

	// ===== Position telemetry =====

	private poll(): void {
		this.pollTimer = null
		const run = this.run
		if (!run) return

		// Monotonic clock: a wall-clock step must not stall or rush the guard.
		const now = performance.now()
		if (run.positionReadsAllowedAt === null) return
		const startupWaitMs = run.positionReadsAllowedAt - now
		if (startupWaitMs > 0) {
			this.schedulePoll(startupWaitMs)
			return
		}
		if (
			this.positionRequestSentAt !== null &&
			now - this.positionRequestSentAt < this.settings.positionRequestGuardMs
		) {
			// The previous request is still unanswered: wait for its late reply
			// instead of adding traffic. At most one request is in flight.
			this.onPollFailed()
			return
		}

		// The request time is taken before the send turn: a reading counts as
		// requested after a STOP or a move only if it surely was.
		const requestSentAt = now
		this.positionRequestSentAt = requestSentAt
		this.positionRequestLeft = false
		this.positionRequestInFlight = true
		const current = (): boolean => this.run === run && this.positionRequestSentAt === requestSentAt
		const onSent = (turn: Turn): void => {
			if (!current()) {
				turn.done()
				return
			}
			this.positionRequestLeft = true
			this.positionTurn = turn
			// The reply timeout counts from the send, not from the wait for the turn.
			this.replyTimer = setTimeout(() => {
				if (!current()) {
					turn.done()
					return
				}
				this.replyTimer = null
				this.positionRequestInFlight = false
				this.releasePositionTurn()
				this.onPollFailed()
			}, this.settings.positionReplyTimeoutMs)
		}
		void run.link
			.send(encodeReadPosition(), run.target.port + POSITION_PORT_OFFSET, { signal: run.abort.signal, onSent })
			.catch((error: unknown) => {
				if (!current() || !this.positionRequestInFlight) return
				if (this.replyTimer) clearTimeout(this.replyTimer)
				this.replyTimer = null
				this.positionRequestInFlight = false
				this.releasePositionTurn()
				this.reportSocketError(error)
				this.onPollFailed()
			})
	}

	private releasePositionTurn(): void {
		this.positionTurn?.done()
		this.positionTurn = null
	}

	/**
	 * A reading requested now, or the reply to the request already in flight.
	 * Null when none arrives in time, or when the previous request was left
	 * unanswered less than the guard interval ago.
	 */
	private async freshReading(): Promise<PositionReading | null> {
		if (!this.positionRequestInFlight) {
			const sentAt = this.positionRequestSentAt
			if (sentAt !== null && performance.now() - sentAt < this.settings.positionRequestGuardMs) return null
			if (this.pollTimer) clearTimeout(this.pollTimer)
			this.poll()
		}
		return new Promise((resolve) => {
			// Safety net: the send turn (behind at most one command) and the reply
			// timer settle every waiter well before this.
			const safetyMs =
				this.settings.positionReplyTimeoutMs * 2 + this.settings.commandReplyTimeoutMs + this.settings.sendSpacingMs * 4
			const timer = setTimeout(() => resolve(null), safetyMs)
			this.readingWaiters.push((reading) => {
				clearTimeout(timer)
				resolve(reading)
			})
		})
	}

	private settleReadingWaiters(reading: PositionReading | null): void {
		const waiters = this.readingWaiters
		this.readingWaiters = []
		for (const resolve of waiters) resolve(reading)
	}

	private onPositionDatagram(run: SessionRun, data: Buffer): void {
		// Nothing requested, or the request has not left yet: a duplicate or a stray datagram.
		if (this.run !== run || this.positionRequestSentAt === null || !this.positionRequestLeft) return
		if (data.length !== POSITION_REPLY_LENGTH) return

		// A reply of the right size answers the outstanding request, even a late
		// one: at most one request is in flight, and after a timeout the next one
		// waits for the guard interval.
		const requestSentAt = this.positionRequestSentAt
		this.positionRequestSentAt = null
		const answersCurrentPoll = this.positionRequestInFlight
		this.positionRequestInFlight = false
		if (this.replyTimer) {
			clearTimeout(this.replyTimer)
			this.replyTimer = null
		}
		this.releasePositionTurn()

		const reading = decodePositionReply(data)
		if (reading) this.acceptReading(reading, requestSentAt)
		else this.host.log('debug', `Ignored invalid position reply ${data.toString('hex')}`)

		if (!answersCurrentPoll) return
		this.settleReadingWaiters(reading)
		if (reading) this.schedulePoll(this.nextPollDelay(true))
		else this.onPollFailed()
	}

	private onPollFailed(): void {
		const run = this.run
		if (!run) return
		this.settleReadingWaiters(null)
		this.failedPolls++
		this.lossStartedAt ??= performance.now()
		if (this.failedPolls === POLL_FIRST_WARNING || this.failedPolls % POLL_WARNING_EVERY === 0) {
			this.host.log(
				'warn',
				`No position reply from ${telemetryEndpoint(run.target)} (${this.failedPolls} consecutive polls)`,
			)
		}
		this.checkFailSafe()
		this.schedulePoll(this.nextPollDelay(false))
	}

	private nextPollDelay(replied: boolean): number {
		if (this.state.stop === 'confirming') return this.settings.stopConfirmIntervalMs
		if (this.state.stop === 'unconfirmed') return this.settings.stopUnconfirmedPollMs
		const moving = this.state.pendingMove !== null || this.state.telemetry?.moving === true
		if (replied) return moving ? this.settings.pollMovingMs : this.settings.pollIdleMs
		return moving ? this.settings.pollMovingAfterErrorMs : this.settings.pollIdleAfterErrorMs
	}

	private schedulePoll(delayMs: number): void {
		if (!this.run) return
		if (this.pollTimer) clearTimeout(this.pollTimer)
		this.pollTimer = setTimeout(() => this.poll(), delayMs)
	}

	private acceptReading(reading: PositionReading, requestSentAt: number | null): void {
		const run = this.run
		if (!run) return
		const before = viewKey(this.state)
		const wasOnline = this.state.link === 'online'
		const motionBefore = currentMotion(this.state)

		if (!wasOnline) {
			this.host.log('info', `Receiving position telemetry from ${telemetryEndpoint(run.target)}`)
		} else if (this.failedPolls >= POLL_FIRST_WARNING) {
			this.host.log('info', `Position replies from ${telemetryEndpoint(run.target)} restored`)
		}
		this.failedPolls = 0
		this.lossStartedAt = null
		this.failSafeStopSent = false
		this.socketErrorReported = false
		this.state.telemetry = reading
		this.state.link = 'online'
		this.armTelemetryExpiry()
		this.followMotion(reading, requestSentAt)
		if (motionBefore !== 'stopped' && currentMotion(this.state) === 'stopped') this.motionEndedAt = performance.now()

		if (!wasOnline) this.startIdentityCheck()
		if (!wasOnline || viewKey(this.state) !== before) this.publish()
	}

	/**
	 * Confirm a STOP, or end a pending move, from a stopped reading. Only a
	 * reading requested after the STOP or the move counts; right after a move
	 * the turntable may still report "stopped", so an unchanged position ends
	 * the move only after the start grace.
	 */
	private followMotion(reading: PositionReading, requestSentAt: number | null): void {
		const move = this.state.pendingMove
		if (move && reading.moving) move.started = true
		if (reading.moving || requestSentAt === null) return

		if (this.state.stop !== 'none' && this.lastStopSentAt !== null && requestSentAt >= this.lastStopSentAt) {
			this.state.stop = 'none'
			this.state.pendingMove = null
			this.clearStopWindow()
			this.host.log('info', `STOP confirmed: turntable stopped at ${formatDegrees(reading.tenths)}°`)
			return
		}
		if (move && requestSentAt >= move.sentAt) {
			const ended =
				move.started ||
				reading.tenths !== move.fromTenths ||
				performance.now() - move.sentAt >= this.settings.moveStartGraceMs
			if (ended) {
				this.state.pendingMove = null
				this.host.log('info', `Turntable stopped at ${formatDegrees(reading.tenths)}°`)
			}
		}
	}

	private armTelemetryExpiry(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer)
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = null
			this.onTelemetryExpired()
		}, this.settings.telemetryValidityMs)
	}

	private onTelemetryExpired(): void {
		const run = this.run
		if (!run) return
		const wasOnline = this.state.link === 'online'
		this.state.link = 'offline'
		const endpoint = telemetryEndpoint(run.target)
		this.host.log(
			'warn',
			wasOnline
				? `Position telemetry lost: no valid reply from ${endpoint} for ${this.settings.telemetryValidityMs / 1000} s`
				: `No position telemetry from ${endpoint}: check the address, the port and the network path`,
		)
		this.publish()
	}

	// ===== Identity =====

	/**
	 * Confirm which turntable answers at the configured address, each time
	 * telemetry comes (back) online. Reads are bounded and spaced: repeated
	 * memory reads have hung older firmware in the past.
	 */
	private startIdentityCheck(): void {
		// Another turntable answered here: stay blocked until the connection restarts.
		if (this.state.identityStatus === 'mismatch' || this.identityCheckRunning) return
		this.state.identityStatus = 'reading'
		void this.runIdentityCheck()
	}

	private async runIdentityCheck(): Promise<void> {
		const run = this.run
		if (!run) return
		const { signal } = run.abort
		this.identityCheckRunning = true
		try {
			const sinceLastCheck = this.lastIdentityCheckAt === null ? Infinity : performance.now() - this.lastIdentityCheckAt
			if (sinceLastCheck < this.settings.identityRecheckIntervalMs) {
				await delay(this.settings.identityRecheckIntervalMs - sinceLastCheck, undefined, { signal })
			}
			this.lastIdentityCheckAt = performance.now()

			const attempts = this.settings.identityAttemptDelaysMs
			for (const [index, waitMs] of attempts.entries()) {
				if (waitMs > 0) await delay(waitMs, undefined, { signal })
				await this.waitUntilQuiet(run)
				const identity = await this.readIdentity(run)
				if (signal.aborted) return
				if (identity) {
					this.applyIdentity(run, identity)
					return
				}
				this.host.log('warn', `Identity read ${index + 1}/${attempts.length} got no valid reply`)
			}

			this.state.identityStatus = 'unavailable'
			this.host.log(
				'warn',
				'Turntable identity unavailable: the connection stays read-only. It is read again when telemetry comes back online, or when the connection is re-enabled.',
			)
			this.publish()
		} catch (error) {
			if (!signal.aborted) this.host.log('error', `Identity check failed: ${errorMessage(error)}`)
		} finally {
			if (this.run === run) this.identityCheckRunning = false
		}
	}

	/**
	 * Memory is read only while valid telemetry shows the turntable stopped,
	 * with no move or STOP in progress and the command channel free.
	 */
	private async waitUntilQuiet(run: SessionRun): Promise<void> {
		while (
			currentMotion(this.state) !== 'stopped' ||
			this.state.stop !== 'none' ||
			this.commandInProgress ||
			run.commands.busy
		) {
			await delay(this.settings.identityMotionDeferMs, undefined, { signal: run.abort.signal })
		}
	}

	private async readIdentity(run: SessionRun): Promise<DeviceIdentity | null> {
		const fields = await this.readMemoryBlock(run, 'Identity', decodeIdentityBlock)
		if (!fields) return null
		// The settings block only refines the model: without it the identity is still complete.
		await this.waitUntilQuiet(run)
		const typeCode = await this.readMemoryBlock(run, 'Settings', decodeTurntableType)
		return { ...fields, model: detectModel(fields.mac, typeCode, fields.name) }
	}

	private async readMemoryBlock<T>(
		run: SessionRun,
		block: MemoryBlockName,
		decode: (data: Buffer) => T | null,
	): Promise<T | null> {
		try {
			const reply = await run.commands.request(
				encodeLoadMemory(block),
				MemoryBlock[block].length,
				this.settings.commandReplyTimeoutMs,
			)
			return reply ? decode(reply) : null
		} catch (error) {
			// A STOP took the channel: the attempt simply failed.
			if (!(error instanceof CommandCancelledError) && this.run === run) this.reportSocketError(error)
			return null
		}
	}

	private applyIdentity(run: SessionRun, identity: DeviceIdentity): void {
		const expectedMac = this.state.expectedMac
		this.state.identity = identity
		if (expectedMac !== null && expectedMac !== identity.mac) {
			this.state.identityStatus = 'mismatch'
			this.host.log(
				'error',
				`A different turntable answers at ${run.target.host}: MAC ${identity.mac} instead of ${expectedMac}. Disable and re-enable the connection to accept it.`,
			)
		} else {
			if (expectedMac === null) this.host.log('info', `Connected to ${describeIdentity(identity)}`)
			this.state.expectedMac = identity.mac
			this.state.identityStatus = 'verified'
		}
		this.publish()
	}

	// ===== Reporting =====

	private publish(): void {
		const run = this.run
		if (!run) return
		const { status, message } = connectionStatus(this.state, run.target)
		const statusKey = `${status}|${message ?? ''}`
		if (statusKey !== this.publishedStatus) {
			this.publishedStatus = statusKey
			this.host.updateStatus(status, message)
		}
		this.host.stateChanged()
	}

	/** Log a refused or failed movement and return the error for the action. */
	private fail(label: string, reason: string, cause?: unknown): Error {
		const message = `${label} failed: ${reason}`
		this.host.log('warn', message)
		return new Error(message, cause === undefined ? undefined : { cause })
	}

	/** Log the first socket error of a streak; a valid reading ends the streak. */
	private reportSocketError(error: unknown): void {
		if (this.socketErrorReported) return
		this.socketErrorReported = true
		this.host.log('warn', `UDP error: ${errorMessage(error)}`)
	}
}

/** What the buttons show: position, motion and the conditions that gate commands. */
function viewKey(state: EtState): string {
	return [state.link, currentReading(state)?.tenths ?? '', currentMotion(state), state.stop, state.identityStatus].join(
		'|',
	)
}

function interruption(error: CommandCancelledError): string {
	return error.sent ? 'interrupted by STOP' : 'interrupted by STOP before it was sent'
}

function directionSymbol(direction: Direction): string {
	return direction === 'forward' ? '▶' : '◀'
}

function telemetryEndpoint(target: ConnectionTarget): string {
	return `${target.host}:${target.port + POSITION_PORT_OFFSET}`
}

function describeIdentity(identity: DeviceIdentity): string {
	const name = identity.name ? ` "${identity.name}"` : ''
	return `${identity.model ?? 'ET turntable'}${name}, MAC ${identity.mac}, firmware ${identity.firmware}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
