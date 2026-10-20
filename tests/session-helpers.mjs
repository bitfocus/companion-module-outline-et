import assert from 'node:assert/strict'

import { EtSession } from '../dist/et-session.js'
import { FakeTurntable } from './fake-turntable.mjs'

// Production timings scaled down to milliseconds. The identity recheck
// interval is 0 here; the test that exercises it overrides it. As in
// production, the fail-safe loss window is longer than telemetry validity.
export const FAST = {
	pollIdleMs: 40,
	pollMovingMs: 20,
	pollIdleAfterErrorMs: 60,
	pollMovingAfterErrorMs: 40,
	positionReplyTimeoutMs: 30,
	positionRequestGuardMs: 80,
	telemetryValidityMs: 250,
	commandReplyTimeoutMs: 50,
	identityAttemptDelaysMs: [0, 60, 60],
	identityMotionDeferMs: 40,
	identityRecheckIntervalMs: 0,
	stopConfirmIntervalMs: 25,
	stopConfirmAttempts: 4,
	stopUnconfirmedPollMs: 60,
	stopCoalesceMs: 50,
	moveStartGraceMs: 150,
	failSafeLossMs: 400,
	failSafeFailedPolls: 3,
	// The traffic spacing keeps its production values.
	sendSpacingMs: 10,
	commandAfterMotionMs: 10,
	// Automatic local ports: test files run in parallel against 127.0.0.1.
	localPortBase: 0,
}

export function createHost() {
	return {
		logs: [],
		statuses: [],
		log(level, message) {
			this.logs.push({ level, message })
		},
		updateStatus(status, message) {
			this.statuses.push({ status, message })
		},
		stateChanged() {},
		lastStatus() {
			return this.statuses.at(-1)?.status
		},
	}
}

/** Only the allowed opcodes may ever reach the turntable. */
export function assertOnlyAllowedFrames(turntable) {
	for (const opcode of turntable.commandOpcodes()) {
		assert.ok([0x01, 0x02, 0x03, 0x05, 0x1a].includes(opcode), `unexpected command opcode 0x${opcode.toString(16)}`)
	}
	for (const { data } of turntable.received.position) assert.equal(data.toString('hex'), '04000004')
}

export async function openSession(t, turntableOptions = {}, settings = FAST) {
	const turntable = new FakeTurntable(turntableOptions)
	const port = await turntable.start()
	const host = createHost()
	const session = new EtSession(host, settings)
	t.after(async () => {
		session.disconnect()
		await turntable.close()
		assertOnlyAllowedFrames(turntable)
		const forced = host.logs.filter((entry) => /released by the safety limit/.test(entry.message))
		assert.equal(forced.length, 0, 'every request turn was released by its reply or its timeout')
	})
	session.connect({ host: '127.0.0.1', port })
	return { turntable, host, session, port }
}

export const verified = (session) => () => session.getState().identityStatus === 'verified'
