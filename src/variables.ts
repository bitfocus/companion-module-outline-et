import type { CompanionVariableDefinitions } from '@companion-module/base'
import { formatDegrees } from './protocol/angles.js'
import { currentMotion, currentReading, type EtState, type MotionState } from './state.js'

export type VariablesSchema = {
	position: number | undefined
	position_text: string
	motion: MotionState
	model: string
	name: string
	firmware: string
}

export function getVariableDefinitions(): CompanionVariableDefinitions<VariablesSchema> {
	return {
		position: { name: 'Position in degrees (empty while telemetry is not valid)' },
		position_text: { name: 'Position for buttons, e.g. 123.4° (— while telemetry is not valid)' },
		motion: { name: 'Motion: stopped, forward, backward or unknown' },
		model: { name: 'Turntable model' },
		name: { name: 'Turntable name stored in the device' },
		firmware: { name: 'Turntable firmware version' },
	}
}

export function buildVariableValues(state: Readonly<EtState>): VariablesSchema {
	const reading = currentReading(state)
	return {
		position: reading ? reading.tenths / 10 : undefined,
		position_text: reading ? `${formatDegrees(reading.tenths)}°` : '—',
		motion: currentMotion(state),
		model: state.identity?.model ?? '',
		name: state.identity?.name ?? '',
		firmware: state.identity?.firmware ?? '',
	}
}
