import { InstanceStatus } from '@companion-module/base'
import { circularDistance, degreesToTenths } from './protocol/angles.js'
import { POSITION_PORT_OFFSET } from './protocol/constants.js'
import type { Direction } from './protocol/frames.js'
import type { PositionReading, TurntableModel } from './protocol/parser.js'

/** Position telemetry: waiting for the first reading, valid, or lost. */
export type LinkState = 'connecting' | 'online' | 'offline'

/**
 * `reading` until the identity of the turntable answering at the configured
 * address has been confirmed; `mismatch` when another turntable answers there
 * and stays so until the connection restarts.
 */
export type IdentityStatus = 'reading' | 'verified' | 'unavailable' | 'mismatch'

/**
 * `confirming` after a STOP, until a valid reading shows the turntable
 * stopped; `unconfirmed` when that did not happen within the confirmation
 * window. Both block new movements.
 */
export type StopState = 'none' | 'confirming' | 'unconfirmed'

export type MotionState = 'stopped' | 'forward' | 'backward' | 'unknown'

export interface DeviceIdentity {
	mac: string
	name: string
	firmware: string
	model: TurntableModel | null
}

/** A move sent by this module that telemetry has not yet seen end. */
export interface PendingMove {
	direction: Direction
	/** Position when the move was planned, in tenths of a degree. */
	fromTenths: number
	/** `performance.now()` before the command was sent. */
	sentAt: number
	/** No confirmation arrived: the turntable may not be moving at all. */
	uncertain: boolean
	/** A moving reading has been seen since the command. */
	started: boolean
}

export interface EtState {
	link: LinkState
	/** Last valid reading; current only while `link` is online. */
	telemetry: PositionReading | null
	identity: DeviceIdentity | null
	identityStatus: IdentityStatus
	/** MAC of the first identity read by this connection. */
	expectedMac: string | null
	pendingMove: PendingMove | null
	stop: StopState
}

export interface ConnectionTarget {
	host: string
	port: number
}

export function createInitialState(): EtState {
	return {
		link: 'connecting',
		telemetry: null,
		identity: null,
		identityStatus: 'reading',
		expectedMac: null,
		pendingMove: null,
		stop: 'none',
	}
}

/** The reading to show, or null when telemetry is not valid. */
export function currentReading(state: Readonly<EtState>): PositionReading | null {
	return state.link === 'online' ? state.telemetry : null
}

/**
 * Motion as the buttons show it. A move sent by this module counts as motion
 * from its confirmation until telemetry sees it end, so even a move shorter
 * than one polling interval produces a stopped → moving → stopped sequence.
 */
export function currentMotion(state: Readonly<EtState>): MotionState {
	const reading = currentReading(state)
	if (!reading) return 'unknown'
	if (reading.moving) return reading.direction
	if (state.pendingMove) return state.pendingMove.direction
	return 'stopped'
}

/** Stopped on `angleDegrees` within `toleranceDegrees`, with valid telemetry. */
export function isAtAngle(state: Readonly<EtState>, angleDegrees: number, toleranceDegrees: number): boolean {
	const reading = currentReading(state)
	const target = degreesToTenths(angleDegrees)
	const tolerance = degreesToTenths(toleranceDegrees)
	if (!reading || currentMotion(state) !== 'stopped' || target === null || tolerance === null || tolerance < 0) {
		return false
	}
	return circularDistance(reading.tenths, target) <= tolerance
}

/** Why a new movement must be refused right now, or null when it may be sent. */
export function movementBlocker(state: Readonly<EtState>): string | null {
	if (state.link !== 'online') return 'position telemetry is not valid'
	switch (state.identityStatus) {
		case 'reading':
			return 'the turntable identity is still being read'
		case 'unavailable':
			return 'the turntable identity is unavailable, so the connection is read-only'
		case 'mismatch':
			return 'a different turntable answers at this address'
		case 'verified':
			break
	}
	if (state.stop !== 'none') return 'the last STOP is not confirmed yet'
	if (currentMotion(state) !== 'stopped') return 'the turntable is moving'
	return null
}

export interface ConnectionStatus {
	status: InstanceStatus
	message: string | null
}

/** Companion connection status derived from telemetry, identity and STOP state. */
export function connectionStatus(state: Readonly<EtState>, target: ConnectionTarget): ConnectionStatus {
	const telemetryEndpoint = `${target.host}:${target.port + POSITION_PORT_OFFSET}`
	switch (state.link) {
		case 'connecting':
			return { status: InstanceStatus.Connecting, message: `Waiting for position telemetry from ${telemetryEndpoint}` }
		case 'offline':
			return { status: InstanceStatus.ConnectionFailure, message: `No position telemetry from ${telemetryEndpoint}` }
		case 'online':
			break
	}
	switch (state.identityStatus) {
		case 'reading':
			return { status: InstanceStatus.Connecting, message: 'Reading turntable identity' }
		case 'unavailable':
			return { status: InstanceStatus.UnknownWarning, message: 'Turntable identity unavailable: read-only' }
		case 'mismatch':
			return {
				status: InstanceStatus.UnknownWarning,
				message: `A different turntable (MAC ${state.identity?.mac ?? 'unknown'}) answers at this address. Disable and re-enable the connection to accept it.`,
			}
		case 'verified':
			break
	}
	if (state.stop === 'unconfirmed') {
		return {
			status: InstanceStatus.UnknownWarning,
			message: 'STOP not confirmed: movements stay blocked until the turntable reports it has stopped',
		}
	}
	return { status: InstanceStatus.Ok, message: null }
}
