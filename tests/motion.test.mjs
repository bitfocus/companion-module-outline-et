import assert from 'node:assert/strict'
import test from 'node:test'

import { InstanceStatus } from '@companion-module/base'
import { createSocket, Socket } from 'node:dgram'
import { once } from 'node:events'
import { UdpLink } from '../dist/protocol/udp-link.js'
import { EtSession } from '../dist/et-session.js'
import { SETTINGS } from '../dist/settings.js'
import { currentMotion } from '../dist/state.js'
import { sleep, waitFor } from './fake-turntable.mjs'
import { createHost, FAST, openSession, verified } from './session-helpers.mjs'

// Every test here runs against the simulated turntable on 127.0.0.1.

async function ready(t, turntableOptions = {}, settings = FAST) {
	const context = await openSession(t, turntableOptions, settings)
	await waitFor(verified(context.session), { message: 'verified identity' })
	return context
}

const motionOf = (session) => currentMotion(session.getState())

/** A move or stop frame as the turntable receives it: opcode, tenths big-endian, XOR. */
const frame = (opcode, tenths) => {
	const bytes = Buffer.from([opcode, tenths >> 8, tenths & 0xff, 0])
	bytes[3] = bytes[0] ^ bytes[1] ^ bytes[2]
	return bytes.toString('hex')
}
const stoppedAt = (session, tenths) => () =>
	motionOf(session) === 'stopped' && session.getState().telemetry?.tenths === tenths

/** Time the actual socket call, not the request's onSent notification. */
function recordSends(t) {
	const original = Socket.prototype.send
	const sends = []
	Socket.prototype.send = function (frame, port, ...args) {
		// Module requests are 4 or 5 bytes; simulated device replies have other lengths.
		if (frame.length === 4 || frame.length === 5) sends.push({ at: performance.now(), opcode: frame[0], port })
		return original.call(this, frame, port, ...args)
	}
	t.after(() => {
		Socket.prototype.send = original
	})
	return sends
}

/** Every datagram the module receives from the turntable, with its length. */
function recordReplies(t) {
	const replies = []
	UdpLink.prototype.emit = function (event, ...args) {
		if (event === 'datagram') replies.push({ at: performance.now(), length: args[0].length })
		return Object.getPrototypeOf(UdpLink.prototype).emit.call(this, event, ...args)
	}
	t.after(() => {
		delete UdpLink.prototype.emit
	})
	return replies
}

/** The time of each end of a movement, as the module publishes it. */
function recordMotionEnds(session, host) {
	const ends = []
	let moving = false
	const stateChanged = host.stateChanged
	host.stateChanged = () => {
		const motion = motionOf(session)
		if (motion === 'forward' || motion === 'backward') moving = true
		else if (moving && motion === 'stopped') {
			moving = false
			ends.push(performance.now())
		}
		stateChanged.call(host)
	}
	return ends
}

test('step: a fresh reading, one move frame, motion followed to the end', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 1000 })

	await session.step('forward', 5)
	assert.equal(motionOf(session), 'forward', 'moving as soon as the turntable confirms')
	assert.deepEqual(turntable.motionFrames(), ['01003233'])

	const moveAt = turntable.framesWithOpcode(0x01)[0].at
	const lastReadBefore = turntable.received.position.filter((entry) => entry.at <= moveAt).at(-1).at
	assert.ok(moveAt - lastReadBefore < FAST.positionReplyTimeoutMs + 20, 'position read just before the move')

	await waitFor(stoppedAt(session, 1050), { message: 'stopped at 105.0°' })
	assert.deepEqual(turntable.motionFrames(), ['01003233'], 'nothing sent again')
})

test('go_to: direction as chosen, null moves never sent, 360° is 0°', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 3500 })

	await session.goTo(10, 'shortest')
	await waitFor(stoppedAt(session, 100), { message: 'stopped at 10.0°' })
	assert.deepEqual(turntable.motionFrames(), ['0100c8c9'], 'shortest from 350° to 10° is 20° forward')

	await session.goTo(10, 'backward')
	assert.equal(turntable.motionFrames().length, 1, 'already there: nothing sent')

	await session.goTo(0, 'backward')
	await waitFor(stoppedAt(session, 0), { message: 'back at zero' })
	await session.goTo(360, 'forward')
	assert.deepEqual(turntable.motionFrames(), ['0100c8c9', '02006466'], '360° at 0° sends nothing')
})

test('go_to backward and forward follow the explicit direction', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 3500 })
	await session.goTo(10, 'backward')
	assert.deepEqual(turntable.motionFrames(), ['020d4847'], '350° to 10° backward is 340°')
})

test('angles are validated before anything is sent', async (t) => {
	const { turntable, session } = await ready(t)
	for (const degrees of [0, -0.5, 0.2, 0.3, 0.4, 1.25, 4.9, 359.9, 360, 360.5, Number.NaN, Infinity]) {
		await assert.rejects(session.step('forward', degrees), /multiple of 0\.5° from 0\.5° to 359\.5°/, `step ${degrees}`)
	}
	for (const degrees of [-1, -0.5, 0.2, 0.3, 90.1, 90.25, 359.9, 360.5, 361, Number.NaN, Infinity]) {
		await assert.rejects(session.goTo(degrees, 'shortest'), /multiple of 0\.5° from 0° to 360°/, `go_to ${degrees}`)
	}
	assert.deepEqual(turntable.motionFrames(), [])
})

test('steps are multiples of 0.5° from 0.5°: the 5° minimum is gone', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 1000 })
	let position = 1000
	for (const [degrees, tenths] of [
		[0.5, 5],
		[1, 10],
		[1.5, 15],
		[2.5, 25],
		[30, 300],
		[1.5 + 1e-12, 15],
	]) {
		await session.step('forward', degrees)
		position += tenths
		await waitFor(stoppedAt(session, position), { message: `stopped at ${position / 10}°` })
	}
	assert.deepEqual(
		turntable.motionFrames(),
		[5, 10, 15, 25, 300, 15].map((tenths) => frame(0x01, tenths)),
	)

	await session.step('backward', 0.5)
	assert.equal(turntable.framesWithOpcode(0x02).length, 1)
})

test('go_to targets are multiples of 0.5°: float noise tolerated, 360° is 0°', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 1000 })

	await session.goTo(100.5, 'forward')
	await waitFor(stoppedAt(session, 1005), { message: 'stopped at 100.5°' })
	await session.goTo(90.5 + 1e-12, 'shortest')
	await waitFor(stoppedAt(session, 905), { message: 'stopped at 90.5°' })
	await session.goTo(360, 'shortest')
	await waitFor(stoppedAt(session, 0), { message: 'stopped at 0°' })
	assert.deepEqual(turntable.motionFrames(), [frame(0x01, 5), frame(0x02, 100), frame(0x02, 905)])

	await session.goTo(360, 'forward')
	assert.equal(turntable.motionFrames().length, 3, 'already at 0°: nothing sent')
})

test('nudge: a fixed 0.5° either way, under the same rules as a step', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 1000, speedTenthsPerSecond: 500 })

	await session.nudge('forward')
	assert.equal(motionOf(session), 'forward', 'moving as soon as the turntable confirms')
	await waitFor(stoppedAt(session, 1005), { message: 'stopped at 100.5°' })
	await session.nudge('backward')
	await waitFor(stoppedAt(session, 1000), { message: 'back at 100.0°' })
	assert.deepEqual(turntable.motionFrames(), ['01000504', '02000507'])

	// A movement from the front panel blocks it, even between polls.
	turntable.startMove('forward', 900)
	await assert.rejects(session.nudge('backward'), /moving/)
	assert.equal(turntable.motionFrames().length, 2)
})

test('presses are never queued: one move, the rest refused', async (t) => {
	const { turntable, session } = await ready(t, { speedTenthsPerSecond: 1000 })

	const [first, second] = await Promise.allSettled([session.step('forward', 45), session.step('forward', 45)])
	assert.equal(first.status, 'fulfilled')
	assert.equal(second.status, 'rejected')
	assert.match(second.reason.message, /another command is in progress/)

	await assert.rejects(session.step('backward', 5), /moving/, 'refused while the move runs')
	assert.equal(turntable.motionFrames().length, 1)
})

test('a movement started from the front panel blocks commands, even between polls', async (t) => {
	const { turntable, session } = await ready(t, { speedTenthsPerSecond: 500 })
	turntable.startMove('backward', 900)
	// Sent before any poll has seen the movement: the dedicated reading catches it.
	await assert.rejects(session.step('forward', 5), /moving/)
	await assert.rejects(session.goTo(90, 'shortest'), /moving/)
	assert.deepEqual(turntable.motionFrames(), [])
})

test('motion commands need valid telemetry and a verified identity', async (t) => {
	const { turntable, session } = await openSession(t, { answerIdentity: false })
	await waitFor(() => session.getState().identityStatus === 'unavailable', { message: 'identity unavailable' })
	await assert.rejects(session.step('forward', 5), /read-only/)

	turntable.answerPosition = false
	await waitFor(() => session.getState().link === 'offline', { message: 'offline' })
	await assert.rejects(session.goTo(90, 'shortest'), /telemetry/)
	assert.deepEqual(turntable.motionFrames(), [])
})

test('a refused move leaves the turntable stopped', async (t) => {
	const { turntable, session } = await ready(t, { refuseMoves: true })
	await assert.rejects(session.step('forward', 5), /refused the command/)
	assert.equal(motionOf(session), 'stopped')
	assert.equal(turntable.motionFrames().length, 1)
})

test('lost confirmation: never sent again, motion followed by telemetry', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 0, answerCommands: false })
	await assert.rejects(session.step('forward', 10), /no confirmation/)
	assert.equal(motionOf(session), 'forward', 'the turntable may be moving')
	await waitFor(stoppedAt(session, 100), { message: 'stopped at 10.0°' })
	await sleep(150)
	assert.equal(turntable.motionFrames().length, 1)
})

test('lost command: the pending move ends after the start grace, without resending', async (t) => {
	const { turntable, session } = await ready(t, { answerCommands: false, executeMoves: false })
	await assert.rejects(session.step('forward', 10), /no confirmation/)
	assert.equal(motionOf(session), 'forward')
	await waitFor(() => motionOf(session) === 'stopped', { message: 'pending move ended' })
	assert.equal(turntable.motionFrames().length, 1)
	turntable.answerCommands = true
	turntable.executeMoves = true
	await session.step('forward', 5)
	assert.equal(turntable.motionFrames().length, 2, 'accepted again once stopped')
})

test('a delayed start does not end the move early', async (t) => {
	const { session } = await ready(t, { tenths: 0, startDelayMs: 100 })
	await session.step('forward', 5)
	const seen = new Set()
	const until = Date.now() + 90
	while (Date.now() < until) {
		seen.add(motionOf(session))
		await sleep(5)
	}
	assert.deepEqual([...seen], ['forward'], 'still moving while the turntable reports stopped')
	await waitFor(stoppedAt(session, 50), { message: 'stopped at 5.0°' })
})

test('STOP interrupts a move and telemetry confirms it', async (t) => {
	const { turntable, host, session } = await ready(t, { tenths: 0, speedTenthsPerSecond: 500 })
	await session.step('forward', 90)
	await waitFor(() => session.getState().telemetry?.moving === true, { message: 'moving' })

	await session.stopMotion()
	assert.equal(turntable.framesWithOpcode(0x03).length, 1)
	await waitFor(() => session.getState().stop === 'none', { message: 'stop confirmed' })
	assert.equal(motionOf(session), 'stopped')
	assert.ok(session.getState().telemetry.tenths < 900, 'stopped before 90°')
	assert.ok(host.logs.some((entry) => /STOP confirmed/.test(entry.message)))

	await session.step('backward', 5)
	assert.equal(turntable.framesWithOpcode(0x02).length, 1, 'movements allowed again')
})

test('a stopped reply to a position request sent before the STOP cannot confirm it', async (t) => {
	const { turntable, session } = await ready(t, {
		tenths: 0,
		speedTenthsPerSecond: 500,
		ignoreStop: true,
	})
	const oldStoppedReply = turntable.positionReplies.findIndex(({ data }) => data[0] === 0x05)
	assert.notEqual(oldStoppedReply, -1, 'saved a valid stopped snapshot')

	await session.step('forward', 90)
	await waitFor(() => session.getState().telemetry?.moving === true, { message: 'movement telemetry' })
	// A request is in flight, unanswered, when the STOP leaves; a stopped reply then arrives for it.
	turntable.answerPosition = false
	const before = turntable.received.position.length
	await waitFor(() => turntable.received.position.length > before, { message: 'position request in flight' })
	await session.stopMotion()
	turntable.replayPositionReply(oldStoppedReply)
	await sleep(10)
	assert.equal(session.getState().stop, 'confirming', 'the reply predates the STOP')

	turntable.answerPosition = true
	await waitFor(() => session.getState().stop === 'unconfirmed', { message: 'STOP remains unconfirmed' })
	assert.equal(motionOf(session), 'forward')
	await assert.rejects(session.step('backward', 5), /STOP is not confirmed/)
})

test('STOP cancels a movement preflight waiting for telemetry', async (t) => {
	const settings = { ...FAST, pollIdleMs: 1000, positionReplyTimeoutMs: 200 }
	const { turntable, session } = await ready(t, { positionReplyDelayMs: 0 }, settings)
	turntable.positionReplyDelayMs = 100
	const before = turntable.received.position.length
	const move = assert.rejects(session.step('forward', 10), /interrupted by STOP before it was sent/)
	await waitFor(() => turntable.received.position.length > before, { message: 'preflight position request' })

	await session.stopMotion()
	await move
	await sleep(150)
	assert.deepEqual(turntable.motionFrames(), ['03000003'], 'the delayed preflight did not send a move after STOP')
})

test('a stray ACK can stand in for the STOP reply, but only telemetry ends the STOP', async (t) => {
	const { turntable, session } = await ready(t, { answerStop: false, ignoreStop: true, speedTenthsPerSecond: 500 })
	await session.step('forward', 90)
	await waitFor(() => session.getState().telemetry?.moving === true, { message: 'moving' })

	// On one command socket an old ACK cannot be told from the STOP reply.
	const stop = session.stopMotion()
	turntable.replayCommandReply(turntable.commandReplies.length - 1)
	await stop
	assert.equal(session.getState().stop, 'confirming', 'the ACK did not end the STOP')
	await waitFor(() => session.getState().stop === 'unconfirmed', { message: 'still moving: STOP unconfirmed' })
	await assert.rejects(session.step('backward', 5), /STOP is not confirmed/)

	turntable.halt()
	await waitFor(() => session.getState().stop === 'none', { message: 'confirmed by telemetry' })
})

test('STOP drops a move still waiting for its send turn: it never reaches the turntable', async (t) => {
	// A long spacing makes the move wait for its turn after the fresh reading.
	const settings = { ...FAST, sendSpacingMs: 100, telemetryValidityMs: 2000 }
	const { turntable, session } = await ready(t, {}, settings)
	const before = turntable.received.position.length
	const move = assert.rejects(session.step('forward', 10), /interrupted by STOP before it was sent/)
	await waitFor(() => turntable.received.position.length > before, { message: 'fresh reading requested' })
	await sleep(30)
	assert.equal(session.getState().pendingMove, null, 'the move is still waiting for its turn')

	await session.stopMotion()
	await move
	await sleep(150)
	assert.deepEqual(turntable.motionFrames(), ['03000003'], 'only the STOP left')
	assert.equal(session.getState().pendingMove, null, 'nothing can have started')
})

test('a position datagram that arrives before its request has left is ignored', async (t) => {
	// With 100 ms between datagrams, each idle poll waits for its turn about 60 ms after it is due.
	const settings = { ...FAST, sendSpacingMs: 100, telemetryValidityMs: 2000 }
	const { turntable, session } = await ready(t, { tenths: 0, speedTenthsPerSecond: 500 }, settings)
	const oldReply = turntable.positionReplies.length - 1
	await session.step('forward', 5)
	await waitFor(stoppedAt(session, 50), { message: 'stopped at 5.0°' })

	const before = turntable.received.position.length
	await waitFor(() => turntable.received.position.length > before, { message: 'a poll left' })
	await sleep(60)
	turntable.replayPositionReply(oldReply)
	await sleep(15)
	assert.equal(session.getState().telemetry?.tenths, 50, 'the old 0.0° reply did not answer the waiting poll')
	await sleep(100)
	assert.equal(session.getState().telemetry?.tenths, 50, 'nor the poll once it left')
})

test('one local port for the whole connection, for the command and the position ports', async (t) => {
	const { turntable, session } = await ready(t, { speedTenthsPerSecond: 500 })
	await session.step('forward', 5)
	await waitFor(stoppedAt(session, 50), { message: 'stopped at 5.0°' })
	await session.nudge('backward')
	await session.stopMotion()
	await waitFor(() => session.getState().stop === 'none', { message: 'stop confirmed' })

	const ports = new Set(
		[...turntable.received.command, ...turntable.received.position].map((entry) => entry.remotePort),
	)
	assert.equal(ports.size, 1, `local ports: ${[...ports].join(', ')}`)
	assert.ok(turntable.received.position.length >= 5 && turntable.received.command.length >= 5)
})

/** A local UDP port that was free a moment ago. */
async function freePort() {
	const probe = createSocket('udp4')
	probe.bind(0)
	await once(probe, 'listening')
	const { port } = probe.address()
	probe.close()
	return port
}

test('the same local port at every connection to a turntable, derived from its address', async (t) => {
	const expected = await freePort()
	// 127.0.0.1 adds 0 × 256 + 1 to the base.
	const settings = { ...FAST, localPortBase: expected - 1 }
	const { turntable, session, host, port } = await ready(t, {}, settings)
	const portsOf = (entries) => new Set(entries.map((entry) => entry.remotePort))
	assert.deepEqual([...portsOf([...turntable.received.command, ...turntable.received.position])], [expected])
	assert.ok(host.logs.some((entry) => entry.message === `Local UDP port ${expected} for 127.0.0.1`))

	session.disconnect()
	const before = turntable.received.position.length
	session.connect({ host: '127.0.0.1', port })
	await waitFor(() => turntable.received.position.length > before + 2, { message: 'polls of the new connection' })
	assert.deepEqual(
		[...portsOf(turntable.received.position.slice(before))],
		[expected],
		'the same port after reconnecting',
	)
})

test('a reused fixed port drains old stopped replies without delaying STOP or falsely confirming it', async (t) => {
	const expected = await freePort()
	// Keep the production guard and STOP timings: the original regression used a 400 ms reply.
	const settings = { ...SETTINGS, localPortBase: expected - 1 }
	const { turntable, session, host, port } = await openSession(
		t,
		{ positionReplyDelayMs: 400, ignoreStop: true, speedTenthsPerSecond: 100 },
		settings,
	)
	await waitFor(() => turntable.positionReplies.length === 1, { timeoutMs: 3000 })
	const old = turntable.positionReplies[0]
	turntable.positionReplyDelayMs = 0
	turntable.startMove('forward', 3000)
	session.connect({ host: '127.0.0.1', port })
	const reconnectAt = performance.now()
	// Without the guard, the first new poll reports motion here. Leave its
	// post-STOP poll unanswered so the old 400 ms stopped reply could answer it.
	await sleep(30)
	turntable.answerPosition = false
	await session.stopMotion()
	assert.ok(performance.now() - reconnectAt < 250, 'STOP did not wait for the 2 s startup guard')
	await sleep(500)
	assert.equal(turntable.moving, true)
	assert.equal(session.getState().telemetry, null, 'the old stopped reply is not telemetry')
	assert.equal(session.getState().stop, 'confirming')
	assert.equal(turntable.received.position.length, 1, 'no new query during the guard')
	assert.equal(old.remote.port, expected)
	turntable.answerPosition = true
	await waitFor(() => session.getState().telemetry?.moving === true, { timeoutMs: 2500 })
	assert.equal(turntable.received.position[1].remotePort, expected, 'the same source port was preserved')
	assert.ok(!host.logs.some((entry) => entry.message.startsWith('STOP confirmed:')))
	turntable.ignoreStop = false
	await session.stopMotion()
	await waitFor(() => session.getState().stop === 'none', { message: 'a genuine stopped reply confirms STOP' })
})

test('a new session on a fixed port also drains packets from the previous process', async (t) => {
	const expected = await freePort()
	const settings = { ...FAST, positionRequestGuardMs: 200, localPortBase: expected - 1 }
	const { turntable, session, port } = await ready(t, {}, settings)
	const old = turntable.positionReplies.length - 1
	session.disconnect()
	turntable.startMove('forward', 3000)
	const host = createHost()
	const restarted = new EtSession(host, settings)
	t.after(() => restarted.disconnect())
	const before = turntable.received.position.length
	restarted.connect({ host: '127.0.0.1', port })
	turntable.replayPositionReply(old, 50)
	await sleep(100)
	assert.equal(restarted.getState().telemetry, null)
	assert.equal(turntable.received.position.length, before)
	await waitFor(() => restarted.getState().telemetry?.moving === true)
	assert.equal(turntable.received.position[before].remotePort, expected)
})

test('a taken local port is reported and an automatic one is used', async (t) => {
	const blocker = createSocket('udp4')
	blocker.bind(0)
	await once(blocker, 'listening')
	t.after(() => blocker.close())
	const taken = blocker.address().port
	const { turntable, host } = await ready(t, {}, { ...FAST, localPortBase: taken - 1 })

	const ports = new Set(
		[...turntable.received.command, ...turntable.received.position].map((entry) => entry.remotePort),
	)
	assert.equal(ports.size, 1)
	assert.notEqual([...ports][0], taken)
	const warning = host.logs.find((entry) => entry.level === 'warn' && /Local UDP port/.test(entry.message))
	assert.match(
		warning.message,
		new RegExp(`Local UDP port ${taken} is not available \\(EADDRINUSE\\).*one connection per turntable`),
	)
})

test('a request never leaves while another one waits for its reply, except STOP', async (t) => {
	const sends = recordSends(t)
	const replies = recordReplies(t)
	// Slow command replies: in beta.5 a poll would leave while a move waits for its ACK.
	const settings = { ...FAST, commandReplyTimeoutMs: 200 }
	const { session } = await ready(t, { commandReplyDelayMs: 60, tenths: 0, speedTenthsPerSecond: 500 }, settings)
	await session.step('forward', 5)
	await waitFor(stoppedAt(session, 50), { message: 'stopped at 5.0°' })
	await session.nudge('backward')
	await session.stopMotion()
	await waitFor(() => session.getState().stop === 'none', { message: 'stop confirmed' })

	// Replay sends and replies in time order: at each non-STOP send, nothing may be waiting for a reply.
	const kindOfSend = (opcode) => (opcode === 0x04 ? 7 : opcode === 0x1a ? 'memory' : 2)
	const kindOfReply = (length) => (length === 7 ? 7 : length === 2 ? 2 : 'memory')
	const timeoutOf = (kind) => (kind === 7 ? settings.positionReplyTimeoutMs : settings.commandReplyTimeoutMs)
	const events = [
		...sends.map((entry) => ({ at: entry.at, send: kindOfSend(entry.opcode), stop: entry.opcode === 0x03 })),
		...replies.map((entry) => ({ at: entry.at, reply: kindOfReply(entry.length) })),
	].sort((a, b) => a.at - b.at)
	let outstanding = []
	let overlaps = 0
	for (const event of events) {
		outstanding = outstanding.filter((request) => request.deadline > event.at)
		if (event.reply !== undefined) {
			const index = outstanding.findIndex((request) => request.kind === event.reply)
			if (index >= 0) outstanding.splice(index, 1)
			continue
		}
		if (!event.stop && outstanding.length > 0) overlaps++
		outstanding.push({ kind: event.send, deadline: event.at + timeoutOf(event.send) })
	}
	assert.ok(sends.length >= 10, `${sends.length} datagrams`)
	assert.equal(overlaps, 0, 'a request left while another one was waiting for its reply')
})

test('any two datagrams to the turntable are at least 10 ms apart, except STOP', async (t) => {
	const sends = recordSends(t)
	const { session } = await ready(t, { tenths: 0, speedTenthsPerSecond: 500 }, { ...FAST, sendSpacingMs: 10 })
	await session.step('forward', 5)
	await waitFor(stoppedAt(session, 50), { message: 'stopped at 5.0°' })
	await session.nudge('backward')
	await waitFor(stoppedAt(session, 45), { message: 'stopped at 4.5°' })
	await session.goTo(0, 'shortest')
	await waitFor(stoppedAt(session, 0), { message: 'stopped at 0.0°' })
	await session.setZero()
	// STOP right after a move frame: it must not wait.
	await session.step('forward', 10)
	await session.stopMotion()
	await waitFor(() => session.getState().stop === 'none', { message: 'stop confirmed' })

	let stopsUnderSpacing = 0
	for (let i = 1; i < sends.length; i++) {
		const gap = sends[i].at - sends[i - 1].at
		if (sends[i].opcode === 0x03) {
			if (gap < 10) stopsUnderSpacing++
			continue
		}
		assert.ok(
			gap >= 9.9,
			`datagram ${i} (0x${sends[i].opcode.toString(16)}) ${gap.toFixed(2)} ms after the previous one`,
		)
	}
	assert.ok(sends.length > 20, `${sends.length} datagrams`)
	assert.equal(stopsUnderSpacing, 1, 'the STOP left at once, closer than the spacing')
})

test('the spacing also holds across a reconnection', async (t) => {
	const sends = recordSends(t)
	const { session, port } = await ready(t)
	await session.stopMotion()
	const stopAt = sends.findLast((entry) => entry.opcode === 0x03).at
	session.disconnect()
	session.connect({ host: '127.0.0.1', port })
	await waitFor(() => sends.some((entry) => entry.opcode === 0x04 && entry.at > stopAt), {
		message: 'first request of the new connection',
	})
	const first = sends.find((entry) => entry.opcode === 0x04 && entry.at > stopAt)
	assert.ok(
		first.at - stopAt >= 9.9,
		`${(first.at - stopAt).toFixed(2)} ms after the last datagram of the old connection`,
	)
})

test('a reconnection frees the turns of the old connection at once', async (t) => {
	const sends = recordSends(t)
	// Hold limit: four times the 200 ms reply timeout. A leaked turn would delay the new connection by 800 ms.
	const settings = { ...FAST, positionReplyTimeoutMs: 200 }
	const { turntable, session, port } = await ready(t, {}, settings)
	turntable.positionReplyDelayMs = 150
	const before = turntable.received.position.length
	await waitFor(() => turntable.received.position.length > before, { message: 'a position request in flight' })
	const reconnectAt = performance.now()
	session.disconnect()
	session.connect({ host: '127.0.0.1', port })
	await waitFor(() => sends.some((entry) => entry.at > reconnectAt), { message: 'first request of the new connection' })
	const first = sends.find((entry) => entry.at > reconnectAt)
	assert.ok(first.at - reconnectAt < 100, `${(first.at - reconnectAt).toFixed(1)} ms after the reconnection`)
})

test('a command leaves at least the pause after the end of a movement; STOP does not wait', async (t) => {
	const sends = recordSends(t)
	const settings = { ...FAST, sendSpacingMs: 0, commandAfterMotionMs: 60 }
	const { session, host } = await ready(t, { tenths: 0, speedTenthsPerSecond: 500 }, settings)
	const ends = recordMotionEnds(session, host)

	await session.step('forward', 5)
	await waitFor(() => ends.length === 1, { message: 'end of the first movement' })
	await session.step('backward', 5)
	const moves = sends.filter((entry) => entry.opcode === 0x01 || entry.opcode === 0x02)
	assert.equal(moves.length, 2)
	const pause = moves[1].at - ends[0]
	assert.ok(pause >= 59.9, `second move ${pause.toFixed(1)} ms after the end of the first`)

	await waitFor(() => ends.length === 2, { message: 'end of the second movement' })
	await session.stopMotion()
	const stop = sends.find((entry) => entry.opcode === 0x03)
	assert.ok(stop.at - ends[1] < 40, `STOP ${(stop.at - ends[1]).toFixed(1)} ms after the end of the movement`)
})

test('STOP presses close together are merged', async (t) => {
	const { turntable, session } = await ready(t)
	await Promise.all([session.stopMotion(), session.stopMotion()])
	assert.equal(turntable.framesWithOpcode(0x03).length, 1)
	await sleep(FAST.stopCoalesceMs + 20)
	await session.stopMotion()
	assert.equal(turntable.framesWithOpcode(0x03).length, 2)
})

test('STOP does not wait for a command waiting for its reply', async (t) => {
	const settings = { ...FAST, commandReplyTimeoutMs: 300 }
	const { turntable, session } = await ready(t, { commandReplyDelayMs: 250 }, settings)
	const move = assert.rejects(session.step('forward', 50), /interrupted by STOP/)
	await waitFor(() => turntable.framesWithOpcode(0x01).length === 1, { message: 'move sent' })

	await session.stopMotion()
	const moveAt = turntable.framesWithOpcode(0x01)[0].at
	const stopAt = turntable.framesWithOpcode(0x03)[0].at
	assert.ok(stopAt - moveAt < 200, `STOP sent ${stopAt - moveAt} ms after the move`)
	await move
	await waitFor(() => session.getState().stop === 'none' && motionOf(session) === 'stopped', {
		message: 'stop confirmed',
	})
})

test('an ignored STOP keeps movements blocked until the turntable reports stopped', async (t) => {
	const { turntable, host, session } = await ready(t, { tenths: 0, speedTenthsPerSecond: 500, ignoreStop: true })
	await session.step('forward', 90)
	await session.stopMotion()

	await waitFor(() => session.getState().stop === 'unconfirmed', { message: 'stop not confirmed' })
	assert.equal(host.lastStatus(), InstanceStatus.UnknownWarning)
	assert.match(host.statuses.at(-1).message, /STOP not confirmed/)
	await assert.rejects(session.step('backward', 5), /STOP is not confirmed/)

	turntable.halt()
	await waitFor(() => session.getState().stop === 'none', { message: 'stop confirmed at last' })
	assert.equal(host.lastStatus(), InstanceStatus.Ok)
})

test('telemetry lost while moving: exactly one automatic STOP', async (t) => {
	const { turntable, host, session } = await ready(t, { tenths: 0, speedTenthsPerSecond: 200 })
	await session.step('forward', 90)
	await waitFor(() => session.getState().telemetry?.moving === true, { message: 'moving' })

	turntable.answerPosition = false
	await waitFor(() => turntable.framesWithOpcode(0x03).length === 1, {
		timeoutMs: FAST.failSafeLossMs * 3,
		message: 'automatic STOP',
	})
	await sleep(FAST.failSafeLossMs)
	assert.equal(turntable.framesWithOpcode(0x03).length, 1, 'only one automatic STOP')
	const lossWarnings = host.logs.filter((entry) => /SAFETY: telemetry lost/.test(entry.message))
	assert.equal(lossWarnings.length, 1, 'one safety warning per loss, not one per failed poll')
	await assert.rejects(session.step('forward', 5), /telemetry/)

	turntable.answerPosition = true
	await waitFor(() => session.getState().stop === 'none' && motionOf(session) === 'stopped', {
		message: 'stop confirmed when telemetry returns',
	})
})

test('a restart resumes nothing', async (t) => {
	// Identity is read again only once the turntable has finished the move.
	const { turntable, session, port } = await ready(t)
	await session.step('forward', 90)
	session.disconnect()
	session.connect({ host: '127.0.0.1', port })
	await waitFor(verified(session), { message: 'verified after restart' })
	await sleep(100)
	assert.deepEqual(turntable.motionFrames(), ['01038486'])
	assert.equal(session.getState().pendingMove, null)
})

test('set zero: the position becomes 0°, checked by a new reading', async (t) => {
	const { turntable, host, session } = await ready(t, { tenths: 1234 })
	await session.setZero()
	assert.equal(session.getState().telemetry.tenths, 0)
	assert.deepEqual(turntable.motionFrames(), ['05000005'])
	assert.ok(host.logs.some((entry) => /now reports 0\.0° \(it was at 123\.4°\)/.test(entry.message)))
})

test('set zero is refused while the turntable moves', async (t) => {
	const { turntable, session } = await ready(t, { speedTenthsPerSecond: 500 })
	turntable.startMove('forward', 900)
	await assert.rejects(session.setZero(), /moving/)
	assert.deepEqual(turntable.motionFrames(), [])
})

test('set zero refused by the turntable, or without effect, is reported', async (t) => {
	const { turntable, session } = await ready(t, { tenths: 1234, refuseZero: true })
	await assert.rejects(session.setZero(), /refused the command/)

	turntable.refuseZero = false
	turntable.ignoreZero = true
	await assert.rejects(session.setZero(), /reports at 123\.4°/)
	assert.equal(turntable.framesWithOpcode(0x05).length, 2, 'never sent again automatically')
})
