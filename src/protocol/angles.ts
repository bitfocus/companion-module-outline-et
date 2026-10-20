import { TENTHS_PER_TURN } from './constants.js'
import type { Direction } from './frames.js'

export type GoToDirection = Direction | 'shortest'

/** Round an angle in degrees to whole tenths; null when it is not a finite number. */
export function degreesToTenths(degrees: number): number | null {
	return Number.isFinite(degrees) ? Math.round(degrees * 10) : null
}

/** The turntable moves in whole multiples of half a degree (5 tenths). */
export const MOVE_GRANULARITY_TENTHS = 5
export const MOVE_GRANULARITY_DEGREES = MOVE_GRANULARITY_TENTHS / 10

/**
 * An angle in degrees as whole tenths, only when it is a multiple of 0.5°.
 * Float noise from expressions (1.5000000000001) is tolerated; 0.3 or 1.25
 * are not multiples and give null, as does a value that is not a number.
 */
export function halfDegreesToTenths(degrees: number): number | null {
	if (!Number.isFinite(degrees)) return null
	const halves = degrees * 2
	const wholeHalves = Math.round(halves)
	return Math.abs(halves - wholeHalves) <= 1e-6 ? wholeHalves * MOVE_GRANULARITY_TENTHS : null
}

/** One decimal, as shown on the turntable and in ET Controller. */
export function formatDegrees(tenths: number): string {
	return (tenths / 10).toFixed(1)
}

/** Map any value onto 0…3599 tenths: 360° is the same position as 0°. */
export function wrapTenths(tenths: number): number {
	return ((tenths % TENTHS_PER_TURN) + TENTHS_PER_TURN) % TENTHS_PER_TURN
}

/** Shortest angular distance between two positions, 0…1800 tenths. */
export function circularDistance(a: number, b: number): number {
	const difference = Math.abs(wrapTenths(a) - wrapTenths(b))
	return Math.min(difference, TENTHS_PER_TURN - difference)
}

/** Distance travelled from `from` to `to` in one direction, 0…3599 tenths. */
export function travelDistance(from: number, to: number, direction: Direction): number {
	return direction === 'forward' ? wrapTenths(to - from) : wrapTenths(from - to)
}

export interface GoToPlan {
	direction: Direction
	/** Zero when the turntable is already on the target: nothing must be sent. */
	tenths: number
}

/** Relative move from `current` to `target`. The shortest path goes forward on an exact half turn. */
export function planGoTo(current: number, target: number, direction: GoToDirection): GoToPlan {
	if (direction !== 'shortest') return { direction, tenths: travelDistance(current, target, direction) }
	const forward = travelDistance(current, target, 'forward')
	const backward = travelDistance(current, target, 'backward')
	return backward < forward ? { direction: 'backward', tenths: backward } : { direction: 'forward', tenths: forward }
}
