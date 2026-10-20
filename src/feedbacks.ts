import type { CompanionFeedbackDefinitions } from '@companion-module/base'
import { currentMotion, currentReading, isAtAngle, type EtState } from './state.js'
import { COLORS } from './style.js'

export type MovingDirectionFilter = 'any' | 'forward' | 'backward'

export type FeedbacksSchema = {
	online: {
		type: 'boolean'
		options: Record<string, never>
	}
	moving: {
		type: 'boolean'
		options: { direction: MovingDirectionFilter }
	}
	at_angle: {
		type: 'boolean'
		options: { angle: number; tolerance: number }
	}
}

export const FEEDBACK_IDS = ['online', 'moving', 'at_angle'] as const satisfies readonly (keyof FeedbacksSchema)[]

export function getFeedbackDefinitions(
	getState: () => Readonly<EtState>,
): CompanionFeedbackDefinitions<FeedbacksSchema> {
	return {
		online: {
			type: 'boolean',
			name: 'Telemetry online',
			description: 'The turntable is reporting its position (last valid reply within 5 s).',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [],
			callback: () => currentReading(getState()) !== null,
		},
		moving: {
			type: 'boolean',
			name: 'Turntable moving',
			description:
				'The turntable is moving in the chosen direction: valid telemetry shows it, or a move sent by Companion has not ended yet.',
			defaultStyle: { bgcolor: COLORS.amber, color: COLORS.black },
			options: [
				{
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					choices: [
						{ id: 'any', label: 'Any' },
						{ id: 'forward', label: 'Forward ▶' },
						{ id: 'backward', label: 'Backward ◀' },
					],
					default: 'any',
				},
			],
			callback: (feedback) => {
				const motion = currentMotion(getState())
				if (motion !== 'forward' && motion !== 'backward') return false
				return feedback.options.direction === 'any' || feedback.options.direction === motion
			},
		},
		at_angle: {
			type: 'boolean',
			name: 'Turntable at angle',
			description: 'Valid telemetry shows the turntable stopped on the angle, within the tolerance.',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [
				{
					type: 'number',
					id: 'angle',
					label: 'Angle (°)',
					default: 0,
					min: 0,
					max: 360,
					step: 0.1,
				},
				{
					type: 'number',
					id: 'tolerance',
					label: 'Tolerance (°)',
					default: 0.5,
					min: 0.1,
					max: 10,
					step: 0.1,
				},
			],
			callback: (feedback) => isAtAngle(getState(), feedback.options.angle, feedback.options.tolerance),
		},
	}
}
