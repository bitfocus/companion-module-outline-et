import assert from 'node:assert/strict'
import test from 'node:test'

import { InstanceStatus } from '@companion-module/base'
import { buildVariableValues } from '../dist/variables.js'
import { sleep, waitFor } from './fake-turntable.mjs'
import { FAST, openSession, verified } from './session-helpers.mjs'

test('goes online, reads the identity once and sends only allowed read requests', async (t) => {
	const { turntable, host, session } = await openSession(t, { tenths: 1234, typeCode: 2 })
	await waitFor(verified(session), { message: 'verified identity' })
	await sleep(200)

	const state = session.getState()
	assert.equal(state.link, 'online')
	assert.deepEqual(state.identity, {
		mac: '00:50:C2:11:22:33',
		name: 'ET TEST',
		firmware: '2.1.3.1',
		model: 'ET250R2-3D',
	})
	assert.equal(host.lastStatus(), InstanceStatus.Ok)
	assert.equal(buildVariableValues(state).position_text, '123.4°')
	assert.equal(buildVariableValues(state).motion, 'stopped')

	assert.deepEqual(turntable.commandOpcodes(), [0x1a, 0x1a], 'identity and settings block, nothing else')
	for (const { data } of turntable.received.position) assert.equal(data.toString('hex'), '04000004')
})

test('follows motion reported by the turntable', async (t) => {
	const { turntable, session } = await openSession(t)
	await waitFor(verified(session))
	turntable.moving = true
	turntable.direction = 'backward'
	turntable.tenths = 3590
	await waitFor(() => buildVariableValues(session.getState()).motion === 'backward', { message: 'backward motion' })
	assert.equal(session.getState().telemetry.tenths, 3590)
})

test('never reads the identity while the turntable is moving', async (t) => {
	const { turntable, session } = await openSession(t, { moving: true })
	await waitFor(() => session.getState().link === 'online')
	await sleep(250)
	assert.equal(turntable.received.command.length, 0)

	turntable.moving = false
	await waitFor(verified(session), { message: 'identity read after the turntable stopped' })
})

test('goes offline when telemetry stops, then re-checks the identity when it returns', async (t) => {
	const { turntable, host, session } = await openSession(t)
	await waitFor(verified(session))
	assert.equal(turntable.identityReads(), 1)

	turntable.answerPosition = false
	await waitFor(() => session.getState().link === 'offline', { message: 'offline' })
	assert.equal(host.lastStatus(), InstanceStatus.ConnectionFailure)
	assert.deepEqual(
		{ ...buildVariableValues(session.getState()), model: undefined, name: undefined, firmware: undefined },
		{
			position: undefined,
			position_text: '—',
			motion: 'unknown',
			model: undefined,
			name: undefined,
			firmware: undefined,
		},
	)

	turntable.answerPosition = true
	await waitFor(() => session.getState().link === 'online', { message: 'back online' })
	await waitFor(verified(session), { message: 're-verified identity' })
	assert.equal(turntable.identityReads(), 2)
	assert.equal(host.lastStatus(), InstanceStatus.Ok)
})

test('blocks a different turntable answering at the same address', async (t) => {
	const { turntable, host, session } = await openSession(t)
	await waitFor(verified(session))

	turntable.answerPosition = false
	await waitFor(() => session.getState().link === 'offline')
	turntable.mac = [0x00, 0x50, 0xc2, 0xaa, 0xbb, 0xcc]
	turntable.answerPosition = true

	await waitFor(() => session.getState().identityStatus === 'mismatch', { message: 'identity mismatch' })
	assert.equal(host.lastStatus(), InstanceStatus.UnknownWarning)
	assert.match(host.statuses.at(-1).message, /00:50:C2:AA:BB:CC/)
})

test('stays read-only after the bounded identity attempts fail', async (t) => {
	const { turntable, host, session } = await openSession(t, { answerIdentity: false })
	await waitFor(() => session.getState().identityStatus === 'unavailable', { message: 'identity unavailable' })
	await sleep(300)

	assert.equal(turntable.identityReads(), FAST.identityAttemptDelaysMs.length)
	assert.equal(turntable.received.command.length, FAST.identityAttemptDelaysMs.length, 'settings block never requested')
	assert.equal(session.getState().link, 'online')
	assert.equal(host.lastStatus(), InstanceStatus.UnknownWarning)
})

test('keeps at most one position request in flight while the turntable is silent', async (t) => {
	// While moving, a missed reply is retried after 30 + 40 ms: the 200 ms guard must hold the next request back.
	// Keep the fail-safe outside this window: STOP deliberately starts a fresh telemetry generation.
	const settings = { ...FAST, positionRequestGuardMs: 200, failSafeLossMs: 1200 }
	const { turntable, session } = await openSession(t, { moving: true }, settings)
	await waitFor(() => session.getState().link === 'online')
	turntable.answerPosition = false
	const silentFrom = turntable.received.position.length
	await sleep(900)

	const times = turntable.received.position.slice(silentFrom).map((entry) => entry.at)
	assert.ok(times.length >= 2 && times.length <= 6, `requests while silent: ${times.length}`)
	for (let i = 1; i < times.length; i++) {
		assert.ok(times[i] - times[i - 1] >= settings.positionRequestGuardMs - 40, `gap ${times[i] - times[i - 1]} ms`)
	}
	assert.equal(session.getState().link, 'offline')
})

test('sends nothing but position requests while the turntable never answers', async (t) => {
	const { turntable, session } = await openSession(t, { answerPosition: false })
	await sleep(500)
	assert.equal(session.getState().link, 'offline')
	assert.ok(turntable.received.position.length >= 2)
	assert.equal(turntable.received.command.length, 0, 'no identity reads without telemetry')
})

test('never reads memory while telemetry is lost', async (t) => {
	const { turntable, session } = await openSession(t, { answerIdentity: false })
	await waitFor(() => turntable.identityReads() === 1, { message: 'first identity attempt' })
	turntable.answerPosition = false
	await waitFor(() => session.getState().link === 'offline', { message: 'offline' })
	const readsWhenLost = turntable.identityReads()
	await sleep(400)
	assert.equal(turntable.identityReads(), readsWhenLost, 'attempts wait for valid telemetry')

	turntable.answerPosition = true
	await waitFor(() => session.getState().identityStatus === 'unavailable', { message: 'remaining attempts' })
	assert.equal(turntable.identityReads(), FAST.identityAttemptDelaysMs.length)
})

test('spaces identity checks on repeated reconnections', async (t) => {
	const settings = { ...FAST, identityRecheckIntervalMs: 600 }
	const { turntable, session } = await openSession(t, {}, settings)
	await waitFor(verified(session))

	turntable.answerPosition = false
	await waitFor(() => session.getState().link === 'offline')
	turntable.answerPosition = true
	await waitFor(() => session.getState().link === 'online')
	assert.equal(session.getState().identityStatus, 'reading', 'movement stays disabled until re-verified')

	await waitFor(verified(session), { message: 're-verified after the interval' })
	const [first, second] = turntable.identityReadTimes()
	assert.ok(second - first >= settings.identityRecheckIntervalMs - 40, `checks ${second - first} ms apart`)
})

test('restarting during an identity read starts cleanly', async (t) => {
	const { turntable, session } = await openSession(t, { identityReplyDelayMs: 40 })
	await waitFor(() => turntable.identityReads() === 1, { message: 'identity read in flight' })
	session.disconnect()
	session.connect({ host: '127.0.0.1', port: turntable.port })

	await waitFor(verified(session), { message: 'verified after restart' })
	assert.equal(turntable.identityReads(), 2)
	assert.equal(session.getState().expectedMac, '00:50:C2:11:22:33')
})

test('accepts a late but valid position reply', async (t) => {
	const { session } = await openSession(t, { positionReplyDelayMs: 50 })
	await waitFor(() => session.getState().link === 'online', { message: 'online from late replies' })
})

test('ignores corrupted position replies', async (t) => {
	const { host, session } = await openSession(t, { corruptPosition: true })
	await sleep(400)
	assert.equal(session.getState().link, 'offline')
	assert.equal(session.getState().telemetry, null)
	assert.equal(host.lastStatus(), InstanceStatus.ConnectionFailure)
})

test('disconnect closes the sockets and forgets the turntable', async (t) => {
	const { turntable, session } = await openSession(t)
	await waitFor(verified(session))
	session.disconnect()
	const requests = turntable.received.position.length
	await sleep(200)

	assert.equal(turntable.received.position.length, requests)
	assert.equal(session.getState().link, 'connecting')
	assert.equal(session.getState().identity, null)
})
