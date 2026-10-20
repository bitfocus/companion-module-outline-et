import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import {
	configProblem,
	DEFAULT_CONFIG,
	getConfigFields,
	isSameTarget,
	normalizeConfig,
	type ModuleConfig,
} from './config.js'
import { getActionDefinitions } from './actions.js'
import { EtSession } from './et-session.js'
import { FEEDBACK_IDS, getFeedbackDefinitions } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import type { EtTypes } from './types.js'
import { buildVariableValues, getVariableDefinitions } from './variables.js'

/**
 * Companion adapter: configuration lifecycle, definitions and publishing.
 * Everything device-facing lives in EtSession, which reports back through
 * the narrow SessionHost callbacks.
 */
export class EtInstance extends InstanceBase<EtTypes> {
	private config: ModuleConfig = { ...DEFAULT_CONFIG }
	private readonly session = new EtSession({
		log: (level, message) => this.log(level, message),
		updateStatus: (status, message) => this.updateStatus(status, message),
		stateChanged: () => this.publishState(),
	})

	async init(config: ModuleConfig): Promise<void> {
		this.config = this.normalizeAndSaveConfig(config)
		this.setActionDefinitions(getActionDefinitions(this.session))
		this.setFeedbackDefinitions(getFeedbackDefinitions(() => this.session.getState()))
		this.setVariableDefinitions(getVariableDefinitions())
		const { structure, presets } = getPresetDefinitions()
		this.setPresetDefinitions(structure, presets)
		this.startSession()
	}

	async destroy(): Promise<void> {
		this.session.disconnect()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const next = this.normalizeAndSaveConfig(config)
		// Saving an unchanged address must not interrupt the session.
		if (isSameTarget(this.config, next)) return
		this.config = next
		this.startSession()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	private startSession(): void {
		this.session.disconnect()
		const problem = configProblem(this.config)
		if (problem === null) {
			this.session.connect({ host: this.config.host, port: this.config.port })
			return
		}
		this.updateStatus(InstanceStatus.BadConfig, problem)
		this.publishState()
	}

	private normalizeAndSaveConfig(config: ModuleConfig): ModuleConfig {
		const normalized = normalizeConfig(config)
		// Persist repaired values (trimmed address, default port) so the
		// configuration shows what the session uses. Invalid values are left
		// for the user to correct.
		const repaired = config?.host !== normalized.host || config?.port !== normalized.port
		if (repaired && Number.isFinite(normalized.port)) this.saveConfig(normalized)
		return normalized
	}

	private publishState(): void {
		this.setVariableValues(buildVariableValues(this.session.getState()))
		this.checkFeedbacks(...FEEDBACK_IDS)
	}
}
