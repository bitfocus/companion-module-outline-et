import assert from 'node:assert/strict'
import { createSocket, Socket } from 'node:dgram'
import { once } from 'node:events'
import test from 'node:test'

import { RequestScheduler } from '../dist/protocol/request-scheduler.js'
import { UdpLink } from '../dist/protocol/udp-link.js'
import { CommandCancelledError, CommandChannel } from '../dist/protocol/command-channel.js'
import { sleep, waitFor } from './fake-turntable.mjs'

const READ = Buffer.from('04000004', 'hex')
const ACK = Buffer.from('3300', 'hex')

/** Hold the real link's bind until released, without delaying the test peer. */
function holdBinds(t) {
	const original = Socket.prototype.bind
	const waiting = []
	t.mock.method(Socket.prototype, 'bind', function (...args) {
		waiting.push(() => original.apply(this, args))
		return this
	})
	return () => {
		for (const bind of waiting.splice(0)) bind()
	}
}

/** Make every bind fail, as on a host where no local UDP port can be bound. */
function failBinds(t, code = 'EPERM') {
	t.mock.method(Socket.prototype, 'bind', function () {
		process.nextTick(() => this.emit('error', Object.assign(new Error(`bind ${code}`), { code })))
		return this
	})
}

/** Close in a test cleanup: a socket may already be closed by the test itself. */
function closeQuietly(socket) {
	try {
		socket.close()
	} catch {
		// Already closed.
	}
}

async function boundSocket(t, port = 0) {
	const socket = createSocket('udp4')
	socket.bind(port, '127.0.0.1')
	await once(socket, 'listening')
	t.after(() => closeQuietly(socket))
	return socket
}

/** A local UDP port that was free a moment ago. */
async function freePort() {
	const probe = createSocket('udp4')
	probe.bind(0)
	await once(probe, 'listening')
	const { port } = probe.address()
	probe.close()
	return port
}

function openLink(t, preferredPort) {
	const link = new UdpLink('127.0.0.1', new RequestScheduler(0, 1000), preferredPort)
	const events = []
	link.on('listening', (port) => events.push(['listening', port]))
	link.on('fallback', (port, reason) => events.push(['fallback', port, reason]))
	link.on('error', (error) => events.push(['error', error.message]))
	link.open()
	t.after(() => link.close())
	return { link, events }
}

test('the preferred local port is used when it is free', { timeout: 5000 }, async (t) => {
	const turntable = await boundSocket(t)
	const free = await freePort()
	const { link, events } = openLink(t, free)
	const received = once(turntable, 'message')
	await link.send(READ, turntable.address().port, { onSent: (turn) => turn.done() })
	const [data, remote] = await received
	assert.equal(data.toString('hex'), '04000004')
	assert.equal(remote.port, free)
	assert.deepEqual(events, [['listening', free]])
})

test(
	'a frame sent while the preferred port turns out to be taken still leaves, from an automatic port',
	{ timeout: 5000 },
	async (t) => {
		const turntable = await boundSocket(t)
		const blocker = createSocket('udp4')
		blocker.bind(0)
		await once(blocker, 'listening')
		t.after(() => closeQuietly(blocker))
		const taken = blocker.address().port

		const { link, events } = openLink(t, taken)
		const received = once(turntable, 'message')
		// Handed off at once, as a STOP is, while the first socket is still binding: it must not be lost with it.
		await link.send(READ, turntable.address().port, { immediate: true, onSent: (turn) => turn.done() })
		const [data, remote] = await received
		assert.equal(data.toString('hex'), '04000004')
		assert.notEqual(remote.port, taken)
		assert.deepEqual(events, [
			['fallback', taken, 'EADDRINUSE'],
			['listening', remote.port],
		])
	},
)

test('only datagrams from the turntable address are delivered', { timeout: 5000 }, async (t) => {
	const turntable = await boundSocket(t)
	const { link } = openLink(t, 0)
	const delivered = []
	link.on('datagram', (data) => delivered.push(data.toString('hex')))
	const received = once(turntable, 'message')
	await link.send(READ, turntable.address().port, { onSent: (turn) => turn.done() })
	const [, remote] = await received
	turntable.send(Buffer.from([0x33, 0x00]), remote.port, '127.0.0.1')
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.deepEqual(delivered, ['3300'])
})

test('a frame cannot be sent once the link is closed', async (t) => {
	const turntable = await boundSocket(t)
	const { link } = openLink(t, 0)
	link.close()
	await assert.rejects(link.send(READ, turntable.address().port), /closed/)
})

test('when no local port can be bound, later frames and STOP fail at once', { timeout: 5000 }, async (t) => {
	failBinds(t)
	// The preferred port fails, then the automatic one: nothing is left to wait for.
	const { link, events } = openLink(t, 20999)
	await waitFor(() => events.some(([kind]) => kind === 'error'), { message: 'the bind error' })
	assert.deepEqual(events, [
		['fallback', 20999, 'EPERM'],
		['error', 'bind EPERM'],
	])
	await assert.rejects(link.send(READ, 6668), /EPERM/)
	const commands = new CommandChannel(link, 6667)
	t.after(() => commands.close())
	const stop = commands.request(Buffer.from('03000003', 'hex'), 2, 30, true)
	const outcome = await Promise.race([
		stop.then(
			() => 'resolved',
			(error) => error,
		),
		sleep(500).then(() => 'pending'),
	])
	assert.ok(outcome instanceof Error && /EPERM/.test(outcome.message), `STOP outcome: ${outcome}`)
	assert.equal(commands.busy, false)
})

test('STOP waits for the bind without starting its reply timeout, then leaves immediately', async (t) => {
	const turntable = await boundSocket(t)
	turntable.on('message', (_, remote) => turntable.send(ACK, remote.port, remote.address))
	const releaseBind = holdBinds(t)
	const { link } = openLink(t, 0)
	const commands = new CommandChannel(link, turntable.address().port)
	t.after(() => commands.close())
	const stop = commands.request(Buffer.from('03000003', 'hex'), 2, 30, true)
	let settled = false
	void stop.then(
		() => (settled = true),
		() => (settled = true),
	)
	await sleep(80)
	assert.equal(settled, false, 'binding time did not consume the reply timeout')
	assert.equal(commands.busy, true)
	releaseBind()
	assert.deepEqual(await stop, ACK)
})

test('cancelling a command during bind drops it unsent, including immediate commands', async (t) => {
	const turntable = await boundSocket(t)
	const received = []
	turntable.on('message', (data) => received.push(data))
	const releaseBind = holdBinds(t)
	const { link } = openLink(t, 0)
	const commands = new CommandChannel(link, turntable.address().port)
	t.after(() => commands.close())
	for (const immediate of [false, true]) {
		const request = commands.request(Buffer.from('03000003', 'hex'), 2, 30, immediate)
		commands.cancel()
		await assert.rejects(request, (error) => error instanceof CommandCancelledError && error.sent === false)
	}
	const listening = once(link, 'listening')
	releaseBind()
	await listening
	await sleep(40)
	assert.deepEqual(received, [], 'nothing followed the cancellation when the socket became ready')
})

test('a delayed bind does not collapse the spacing of actual socket sends', async (t) => {
	const turntable = await boundSocket(t)
	const received = []
	turntable.on('message', (data) => received.push(data))
	const releaseBind = holdBinds(t)
	const scheduler = new RequestScheduler(10, 1000)
	const link = new UdpLink('127.0.0.1', scheduler)
	t.after(() => link.close())
	const original = Socket.prototype.send
	const sends = []
	t.mock.method(Socket.prototype, 'send', function (...args) {
		if (this !== turntable) sends.push(performance.now())
		return original.apply(this, args)
	})
	link.open()
	const requests = [1, 2].map(() => link.send(READ, turntable.address().port, { onSent: (turn) => turn.done() }))
	await sleep(80)
	assert.equal(sends.length, 0)
	assert.equal(scheduler.inFlight, 0, 'no turn started while binding')
	releaseBind()
	await Promise.all(requests)
	await waitFor(() => received.length === 2)
	assert.equal(sends.length, 2)
	assert.ok(sends[1] - sends[0] >= 9.9, `actual spacing ${sends[1] - sends[0]} ms`)
})

test('a frame waiting for a send turn cannot cross into a reopened link', async (t) => {
	const turntable = await boundSocket(t)
	const received = []
	turntable.on('message', (data) => received.push(data))
	const scheduler = new RequestScheduler(10, 1000)
	const link = new UdpLink('127.0.0.1', scheduler)
	t.after(() => link.close())
	link.open()
	await once(link, 'listening')
	let held
	await scheduler.inTurn(async (turn) => {
		held = turn
	})
	const request = link.send(READ, turntable.address().port)
	const rejected = assert.rejects(request, /closed/)
	await sleep(20)
	link.open()
	held.done()
	await rejected
	await sleep(30)
	assert.deepEqual(received, [])
})
