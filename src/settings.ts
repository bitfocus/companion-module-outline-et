/**
 * Fixed runtime settings. They are not connection preferences and are not
 * shown in the configuration; the values match ET Controller where it defines
 * them.
 */
export interface SessionSettings {
	/** Position request cadence while the turntable is stopped. */
	pollIdleMs: number
	/** Position request cadence while the turntable is moving. */
	pollMovingMs: number
	/** Cadence after a failed position request, stopped / moving. */
	pollIdleAfterErrorMs: number
	pollMovingAfterErrorMs: number
	/** Wait for a position reply before counting the request as failed. */
	positionReplyTimeoutMs: number
	/** A new position request is not sent while the previous one is younger than this. */
	positionRequestGuardMs: number
	/** Telemetry is valid while the last good reading is at most this old. */
	telemetryValidityMs: number
	/** Wait for a reply on the command port. */
	commandReplyTimeoutMs: number
	/** Delay before each identity read attempt: at most one attempt per entry. */
	identityAttemptDelaysMs: readonly number[]
	/** Identity reads wait this long while the turntable reports motion. */
	identityMotionDeferMs: number
	/** Minimum spacing between two identity checks, e.g. on repeated reconnections. */
	identityRecheckIntervalMs: number
	/** After a STOP, position is read at this interval, this many times, to confirm it. */
	stopConfirmIntervalMs: number
	stopConfirmAttempts: number
	/** Position cadence while a STOP stays unconfirmed. */
	stopUnconfirmedPollMs: number
	/** STOP presses closer than this to the last STOP sent are merged with it. */
	stopCoalesceMs: number
	/**
	 * A stopped reading ends a move right after its confirmation only when the
	 * position changed or this long has passed: the turntable may not report
	 * the motion immediately.
	 */
	moveStartGraceMs: number
	/** One automatic STOP when telemetry is lost this long while moving… */
	failSafeLossMs: number
	/** …and at least this many consecutive position requests failed. */
	failSafeFailedPolls: number
	/** Minimum time between two datagrams sent to the turntable, on any port. STOP never waits. */
	sendSpacingMs: number
	/** Minimum time from the end of a movement, as telemetry shows it, to the next command. STOP never waits. */
	commandAfterMotionMs: number
	/**
	 * Base of the local UDP port, the same at every restart for a given
	 * turntable (see `preferredLocalPort`); 0 for an automatic port.
	 */
	localPortBase: number
}

export const SETTINGS: SessionSettings = {
	pollIdleMs: 1000,
	pollMovingMs: 500,
	pollIdleAfterErrorMs: 3000,
	pollMovingAfterErrorMs: 1000,
	positionReplyTimeoutMs: 500,
	positionRequestGuardMs: 2000,
	// One lost idle reply delays the next valid reading to about 4.5 s: the
	// validity window must be longer, or a single lost datagram makes the
	// buttons flicker offline.
	telemetryValidityMs: 5000,
	commandReplyTimeoutMs: 500,
	identityAttemptDelaysMs: [0, 3000, 4000],
	identityMotionDeferMs: 2000,
	identityRecheckIntervalMs: 30000,
	stopConfirmIntervalMs: 250,
	stopConfirmAttempts: 8,
	stopUnconfirmedPollMs: 3000,
	stopCoalesceMs: 200,
	moveStartGraceMs: 1000,
	failSafeLossMs: 8000,
	failSafeFailedPolls: 4,
	// Spacing added after firmware hangs under extra traffic; not in ET Controller.
	sendSpacingMs: 10,
	commandAfterMotionMs: 10,
	localPortBase: 20000,
}
