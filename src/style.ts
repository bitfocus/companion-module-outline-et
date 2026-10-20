import { combineRgb } from '@companion-module/base'

/**
 * Button colours shared by feedbacks and presets. Text and symbols always
 * repeat the state, so colour is never the only cue.
 */
export const COLORS = {
	/** Base background of status buttons. */
	panel: combineRgb(24, 28, 34),
	/** Stopped on the requested angle. */
	green: combineRgb(0, 135, 70),
	/** Moving: new movements are refused. */
	amber: combineRgb(225, 145, 0),
	/** Telemetry not valid. */
	grey: combineRgb(70, 76, 84),
	/** STOP, always. */
	red: combineRgb(200, 30, 35),
	white: combineRgb(255, 255, 255),
	black: combineRgb(0, 0, 0),
} as const
