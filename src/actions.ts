import type { CompanionActionDefinitions } from '@companion-module/base'
import { NUDGE_DEGREES, STEP_MAX_DEGREES, STEP_MIN_DEGREES } from './et-session.js'
import { MOVE_GRANULARITY_DEGREES, type GoToDirection } from './protocol/angles.js'
import type { Direction } from './protocol/frames.js'

/** Step sizes offered directly; any other size goes through "Custom". */
export const STEP_CHOICES_DEGREES = [1, 5, 10, 30, 90, 180] as const
/** Value of the custom angle while another step size is selected (the field is hidden then). */
export const STEP_CUSTOM_DEFAULT_DEGREES = 5
export type StepAmount = (typeof STEP_CHOICES_DEGREES)[number] | 'custom'

export type ActionsSchema = {
	stop: {
		options: Record<string, never>
	}
	step: {
		options: { direction: Direction; amount: StepAmount; angle: number }
	}
	nudge: {
		options: { direction: Direction }
	}
	go_to: {
		options: { angle: number; direction: GoToDirection }
	}
	set_zero: {
		options: Record<string, never>
	}
}

/** The motion commands of the session, as the actions use them. */
export interface MotionControl {
	stopMotion(): Promise<void>
	step(direction: Direction, degrees: number): Promise<void>
	nudge(direction: Direction): Promise<void>
	goTo(degrees: number, direction: GoToDirection): Promise<void>
	setZero(): Promise<void>
}

const DIRECTION_CHOICES = [
	{ id: 'forward', label: 'Forward ▶' },
	{ id: 'backward', label: 'Backward ◀' },
] satisfies { id: Direction; label: string }[]

export function getActionDefinitions(motion: MotionControl): CompanionActionDefinitions<ActionsSchema> {
	return {
		stop: {
			name: 'STOP',
			description:
				'Stop the turntable. Sent at once, even while another command waits for its reply. Telemetry confirms the stop. The network STOP is not an emergency stop.',
			options: [],
			callback: async () => motion.stopMotion(),
		},
		step: {
			name: 'Step',
			description:
				'Move by an angle from the current position: 1°, 5°, 10°, 30°, 90°, 180° or a custom angle, a multiple of 0.5° from 0.5° to 359.5°. Refused while the turntable moves or a STOP is being confirmed; presses are never queued.',
			options: [
				{
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					choices: DIRECTION_CHOICES,
					default: 'forward',
				},
				{
					type: 'dropdown',
					id: 'amount',
					label: 'Step',
					choices: [
						...STEP_CHOICES_DEGREES.map((degrees) => ({ id: degrees, label: `${degrees}°` })),
						{ id: 'custom', label: 'Custom' },
					],
					default: 5,
					// Referenced by the visibility of the custom angle.
					disableAutoExpression: true,
				},
				{
					type: 'number',
					id: 'angle',
					label: 'Custom angle (°)',
					description: `Multiples of ${MOVE_GRANULARITY_DEGREES}° only, from ${STEP_MIN_DEGREES}° to ${STEP_MAX_DEGREES}°: values such as 0.3° are refused.`,
					default: STEP_CUSTOM_DEFAULT_DEGREES,
					min: STEP_MIN_DEGREES,
					max: STEP_MAX_DEGREES,
					step: MOVE_GRANULARITY_DEGREES,
					isVisibleExpression: "$(options:amount) == 'custom'",
				},
			],
			callback: async (action) => {
				const { direction, amount, angle } = action.options
				await motion.step(direction, amount === 'custom' ? angle : amount)
			},
		},
		nudge: {
			name: 'Nudge (fine adjustment)',
			description: `Move by a fixed ${NUDGE_DEGREES}° (MAN in ET Controller), forward or backward. Same rules as Step: refused while the turntable moves or a STOP is being confirmed; presses are never queued.`,
			options: [
				{
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					choices: DIRECTION_CHOICES,
					default: 'forward',
				},
			],
			callback: async (action) => motion.nudge(action.options.direction),
		},
		go_to: {
			name: 'Go to angle',
			description:
				'Move to an absolute angle, a multiple of 0.5°, computed from a position read just before sending. Nothing is sent when the turntable is already there. The turntable does not count turns: choose the direction explicitly when cables are attached.',
			options: [
				{
					type: 'number',
					id: 'angle',
					label: 'Angle (°)',
					description: `Multiples of ${MOVE_GRANULARITY_DEGREES}° only, from 0° to 360° (360° is the same position as 0°): values such as 90.3° are refused.`,
					default: 0,
					min: 0,
					max: 360,
					step: MOVE_GRANULARITY_DEGREES,
				},
				{
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					choices: [{ id: 'shortest', label: 'Shortest path' }, ...DIRECTION_CHOICES],
					default: 'shortest',
				},
			],
			callback: async (action) => motion.goTo(action.options.angle, action.options.direction),
		},
		set_zero: {
			name: 'Set zero here',
			description:
				'Make the current position 0° (RESET TO 0 in ET Controller). Only while the turntable is stopped; a position read afterwards must show 0°. The previous zero reference is lost.',
			options: [],
			callback: async () => motion.setZero(),
		},
	}
}
