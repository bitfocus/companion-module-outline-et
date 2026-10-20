import type {
	CompanionPresetDefinitions,
	CompanionPresetFeedback,
	CompanionPresetSection,
	CompanionSimplePresetDefinition,
} from '@companion-module/base'
import { STEP_CUSTOM_DEFAULT_DEGREES, type StepAmount } from './actions.js'
import { NUDGE_DEGREES } from './et-session.js'
import type { GoToDirection } from './protocol/angles.js'
import type { Direction } from './protocol/frames.js'
import { COLORS } from './style.js'
import type { EtTypes } from './types.js'

export interface PresetDefinitions {
	structure: CompanionPresetSection<EtTypes>[]
	presets: CompanionPresetDefinitions<EtTypes>
}

type Preset = CompanionSimplePresetDefinition<EtTypes>

const SET_ZERO_HOLD_MS = 2000
type PresetFeedback = CompanionPresetFeedback<EtTypes['feedbacks']>

/** Grey without telemetry, amber while moving: the button shows it is not available. */
const AVAILABILITY_FEEDBACKS: PresetFeedback[] = [
	{
		feedbackId: 'moving',
		options: { direction: 'any' },
		style: { bgcolor: COLORS.amber, color: COLORS.black },
	},
	{
		feedbackId: 'online',
		options: {},
		isInverted: true,
		style: { bgcolor: COLORS.grey, color: COLORS.white },
	},
]

function commandStyle(text: string): Preset['style'] {
	return { text, size: 'auto', color: COLORS.white, bgcolor: COLORS.panel, show_topbar: false }
}

function arrowed(label: string, direction: Direction, amount: string): string {
	return direction === 'forward' ? `${label}\n${amount} ▶` : `${label}\n◀ ${amount}`
}

function stepPreset(direction: Direction, amount: Exclude<StepAmount, 'custom'>): Preset {
	return {
		type: 'simple',
		name: `Step ${direction} ${amount}°`,
		style: commandStyle(arrowed('STEP', direction, `${amount}°`)),
		steps: [
			{ down: [{ actionId: 'step', options: { direction, amount, angle: STEP_CUSTOM_DEFAULT_DEGREES } }], up: [] },
		],
		feedbacks: AVAILABILITY_FEEDBACKS,
	}
}

function nudgePreset(direction: Direction): Preset {
	return {
		type: 'simple',
		name: `Nudge ${direction} ${NUDGE_DEGREES}°`,
		style: commandStyle(arrowed('MAN', direction, `${NUDGE_DEGREES}°`)),
		steps: [{ down: [{ actionId: 'nudge', options: { direction } }], up: [] }],
		feedbacks: AVAILABILITY_FEEDBACKS,
	}
}

type PresetLocalVariable = NonNullable<Preset['localVariables']>[number]

function localVariable(variableName: string, headline: string, startupValue: number | string): PresetLocalVariable {
	return { variableName, headline, variableType: 'simple', startupValue }
}

function localExpression(variableName: string) {
	return { isExpression: true as const, value: `$(local:${variableName})` }
}

/**
 * Button text is an expression so its target and direction stay in step with
 * the local variables used by the action and position feedback. Invalid
 * directions are shown explicitly rather than being presented as backward.
 */
function positionTextExpression(label: 'GO' | 'ZERO', withAngle: boolean): string {
	const direction =
		'${$(local:direction) === "shortest" ? "shortest" : $(local:direction) === "forward" ? "▶" : $(local:direction) === "backward" ? "◀" : "invalid"}'
	const lines: string[] = [label]
	if (withAngle) lines.push('${$(local:angle)}°')
	lines.push(direction)
	// The Companion evaluator currently preserves raw template escapes, so put
	// actual line-feed characters in the expression instead of the two chars \\n.
	return `\`${lines.join('\n')}\``
}

function goToPreset(name: string, degrees: number, direction: GoToDirection): Preset {
	return {
		type: 'simple',
		name,
		style: { ...commandStyle(positionTextExpression('GO', true)), textExpression: true },
		steps: [
			{
				down: [
					{
						actionId: 'go_to',
						options: { angle: localExpression('angle'), direction: localExpression('direction') },
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'at_angle',
				options: { angle: localExpression('angle'), tolerance: 0.5 },
				style: { bgcolor: COLORS.green, color: COLORS.white },
			},
			...AVAILABILITY_FEEDBACKS,
		],
		localVariables: [
			localVariable('angle', 'Target angle (°)', degrees),
			localVariable('direction', 'Direction', direction),
		],
	}
}

function zeroPreset(direction: GoToDirection): Preset {
	return {
		type: 'simple',
		name: direction === 'shortest' ? 'Return to zero (shortest path)' : `Return to zero ${direction}`,
		style: { ...commandStyle(positionTextExpression('ZERO', false)), textExpression: true },
		steps: [
			{
				down: [
					{
						actionId: 'go_to',
						options: { angle: 0, direction: localExpression('direction') },
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'at_angle',
				options: { angle: 0, tolerance: 0.5 },
				style: { bgcolor: COLORS.green, color: COLORS.white },
			},
			...AVAILABILITY_FEEDBACKS,
		],
		localVariables: [localVariable('direction', 'Direction', direction)],
	}
}

export function getPresetDefinitions(): PresetDefinitions {
	const presets: Record<string, Preset> = {
		status: {
			type: 'simple',
			name: 'Position and motion',
			style: commandStyle('ET\n$(outline-et:position_text)\n$(outline-et:motion)'),
			steps: [],
			feedbacks: AVAILABILITY_FEEDBACKS,
		},
		stop: {
			type: 'simple',
			name: 'STOP',
			style: { text: 'STOP', size: '24', color: COLORS.white, bgcolor: COLORS.red, show_topbar: false },
			steps: [{ down: [{ actionId: 'stop', options: {} }], up: [] }],
			feedbacks: [],
		},
		step_backward_5: stepPreset('backward', 5),
		step_forward_5: stepPreset('forward', 5),
		step_backward_90: stepPreset('backward', 90),
		step_forward_90: stepPreset('forward', 90),
		man_backward: nudgePreset('backward'),
		man_forward: nudgePreset('forward'),
		zero_backward: zeroPreset('backward'),
		zero_forward: zeroPreset('forward'),
		zero_shortest: zeroPreset('shortest'),
		go_90: goToPreset('Go to 90° (shortest path)', 90, 'shortest'),
		go_180: goToPreset('Go to 180° (shortest path)', 180, 'shortest'),
		go_270: goToPreset('Go to 270° (shortest path)', 270, 'shortest'),
		set_zero: {
			type: 'simple',
			name: 'Set zero here (hold 2 s)',
			style: commandStyle('SET 0\nhold 2 s'),
			// Only a deliberate long press redefines the zero: a tap does nothing.
			steps: [
				{
					down: [],
					up: [],
					[SET_ZERO_HOLD_MS]: { options: { runWhileHeld: true }, actions: [{ actionId: 'set_zero', options: {} }] },
				},
			],
			feedbacks: [
				{
					feedbackId: 'at_angle',
					options: { angle: 0, tolerance: 0.5 },
					style: { bgcolor: COLORS.green, color: COLORS.white },
				},
				...AVAILABILITY_FEEDBACKS,
			],
		},
	}

	const structure: CompanionPresetSection<EtTypes>[] = [
		{
			id: 'status',
			name: 'Status',
			definitions: ['status'],
		},
		{
			id: 'motion',
			name: 'Motion',
			description: 'Buttons turn amber while the turntable moves and grey without telemetry.',
			definitions: [
				'stop',
				'step_backward_5',
				'step_forward_5',
				'step_backward_90',
				'step_forward_90',
				'man_backward',
				'man_forward',
			],
		},
		{
			id: 'positions',
			name: 'Positions',
			description:
				'Green when the turntable is stopped on the angle. ZERO ◀ and ZERO ▶ use an explicit direction; ZERO shortest and GO take the shortest path. SET 0 redefines the zero and needs a 2 s press.',
			definitions: ['zero_backward', 'zero_forward', 'zero_shortest', 'go_90', 'go_180', 'go_270', 'set_zero'],
		},
	]

	return { structure, presets }
}
