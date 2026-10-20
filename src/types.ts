import type { ActionsSchema } from './actions.js'
import type { ModuleConfig } from './config.js'
import type { FeedbacksSchema } from './feedbacks.js'
import type { VariablesSchema } from './variables.js'

/** Type arguments of the Companion instance. */
export type EtTypes = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}
