import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { CommandCancelledError, CommandChannel } from '../dist/protocol/command-channel.js'
import { sleep } from './fake-turntable.mjs'

const PORT = 6667
const MOVE = Buffer.from('01000a0b', 'hex')
const STOP = Buffer.from('03000003', 'hex')
const ACK = Buffer.from([0x33, 0x00])

/**
 * A UDP link whose frames wait until `handOffNext()`, like frames waiting for
 * their send turn; `immediate` frames leave at once. Each frame that leaves
 * gets a turn, and the test sees when it is released. A frame's send promise
 * settles only when the test says so.
 */
class FakeLink extends EventEmitter {
	sent = []
	waiting = []

	send(frame, port, { immediate = false, signal, onSent } = {}) {
		return new Promise((resolve, reject) => {
			const entry = {
				signal,
				resolve,
				reject,
				handOff: () => {
					const turn = {
						released: false,
						done() {
							turn.released = true
						},
					}
					onSent?.(turn)
					this.sent.push({ hex: frame.toString('hex'), port, turn })
				},
			}
			if (immediate) {
				entry.handOff()
				resolve()
				return
			}
			signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			this.waiting.push(entry)
		})
	}

	/** The next waiting frame gets its turn; an aborted one is skipped, as the scheduler does. */
	handOffNext({ settle = true } = {}) {
		const entry = this.waiting.shift()
		if (entry.signal?.aborted) return entry
		entry.handOff()
		if (settle) entry.resolve()
		return entry
	}
}

const cancelledWith = (sent) => (error) => error instanceof CommandCancelledError && error.sent === sent

test('a frame still waiting for its send turn is dropped by cancel, reported as never sent', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const move = commands.request(MOVE, 2, 500)
	commands.cancel()
	await assert.rejects(move, cancelledWith(false))

	link.handOffNext()
	assert.deepEqual(link.sent, [], 'its turn came and nothing left')
	assert.equal(commands.busy, false)
})

test('a frame cancelled after leaving is reported as sent, and keeps its turn until its timeout', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const move = commands.request(MOVE, 2, 40)
	link.handOffNext()
	commands.cancel()
	await assert.rejects(move, cancelledWith(true))
	assert.deepEqual(
		link.sent.map((entry) => [entry.hex, entry.port]),
		[['01000a0b', PORT]],
	)
	assert.equal(link.sent[0].turn.released, false, 'the turntable may still be answering it')
	await sleep(60)
	assert.equal(link.sent[0].turn.released, true, 'released once its reply would have timed out')
})

test('STOP leaves at once, after a move dropped before its turn', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const move = commands.request(MOVE, 2, 500)
	commands.cancel()
	const stop = commands.request(STOP, 2, 500, true)
	assert.deepEqual(
		link.sent.map((entry) => entry.hex),
		['03000003'],
		'STOP did not wait for a turn',
	)
	link.emit('datagram', ACK)
	assert.deepEqual(await stop, ACK)
	assert.equal(link.sent[0].turn.released, true, 'the reply released the turn of the STOP')
	await assert.rejects(move, cancelledWith(false))
	link.handOffNext()
	assert.equal(link.sent.length, 1, 'the dropped move never followed the STOP')
})

test('a reply counts only after its frame left, and only with the expected length', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const request = commands.request(MOVE, 2, 500)
	link.emit('datagram', ACK)
	assert.equal(commands.busy, true, 'an ACK before the frame left is not its reply')
	link.handOffNext()
	link.emit('datagram', Buffer.alloc(7))
	assert.equal(commands.busy, true, 'a position reply is not a command reply')
	link.emit('datagram', ACK)
	assert.deepEqual(await request, ACK)
	assert.equal(link.sent[0].turn.released, true)
})

test('the reply timeout counts from the send, not from the wait for the turn', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const request = commands.request(MOVE, 2, 30)
	await sleep(60)
	assert.equal(commands.busy, true, 'still waiting for its turn: no timeout yet')
	const sentAt = performance.now()
	link.handOffNext()
	assert.equal(await request, null)
	assert.ok(performance.now() - sentAt >= 25, 'timed out after the send')
	assert.equal(link.sent[0].turn.released, true)
})

test('a late send failure from a cancelled command cannot affect the next request', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const old = commands.request(MOVE, 2, 500)
	const oldEntry = link.handOffNext({ settle: false })
	commands.cancel()
	await assert.rejects(old, cancelledWith(true))

	const stop = commands.request(STOP, 2, 500, true)
	oldEntry.reject(new Error('late send failure'))
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(commands.busy, true, 'the STOP request is still waiting for its reply')
	link.emit('datagram', ACK)
	assert.deepEqual(await stop, ACK)
})

test('close cancels the pending request and releases its turn', async () => {
	const link = new FakeLink()
	const commands = new CommandChannel(link, PORT)
	const request = commands.request(MOVE, 2, 500)
	link.handOffNext()
	commands.close()
	await assert.rejects(request, CommandCancelledError)
	assert.equal(link.sent[0].turn.released, true)
	await assert.rejects(commands.request(STOP, 2, 500, true), /closed/)
})
