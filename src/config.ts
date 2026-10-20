import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import { isIPv4 } from 'node:net'
import { DEFAULT_COMMAND_PORT, MAX_COMMAND_PORT } from './protocol/constants.js'

/** Operator-editable connection settings: the turntable address, nothing else. */
export type ModuleConfig = {
	host: string
	port: number
}

export const DEFAULT_CONFIG: ModuleConfig = {
	host: '',
	port: DEFAULT_COMMAND_PORT,
}

/**
 * One normalization for init and configUpdated. Missing values take their
 * default and numeric strings become numbers. An invalid value is kept as it
 * is, so that `configProblem` reports it instead of the module silently
 * talking to another port.
 */
export function normalizeConfig(config: Partial<ModuleConfig> | null | undefined): ModuleConfig {
	return {
		host: typeof config?.host === 'string' ? config.host.trim() : DEFAULT_CONFIG.host,
		port: parsePort(config?.port),
	}
}

function parsePort(value: unknown): number {
	if (value === undefined || value === null || value === '') return DEFAULT_COMMAND_PORT
	if (typeof value === 'number') return value
	return typeof value === 'string' ? Number(value.trim()) : Number.NaN
}

/** Why the session cannot start with this configuration, or null when it can. */
export function configProblem(config: ModuleConfig): string | null {
	if (!isIPv4(config.host)) return 'Enter the IP address of the turntable'
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > MAX_COMMAND_PORT) {
		return `Enter a command port between 1 and ${MAX_COMMAND_PORT}`
	}
	return null
}

export function isSameTarget(a: ModuleConfig, b: ModuleConfig): boolean {
	return a.host === b.host && Object.is(a.port, b.port)
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Turntable IP address',
			width: 8,
			regex: Regex.IP,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Command port',
			tooltip: `Default ${DEFAULT_COMMAND_PORT}. Position telemetry uses the next port.`,
			width: 4,
			default: DEFAULT_COMMAND_PORT,
			min: 1,
			max: MAX_COMMAND_PORT,
			asInteger: true,
		},
	]
}
