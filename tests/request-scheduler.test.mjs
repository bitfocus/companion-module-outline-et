import assert from 'node:assert/strict'
import test from 'node:test'

import { RequestScheduler } from '../dist/protocol/request-scheduler.js'
import { sleep } from './fake-turntable.mjs'

/** A send that records its hand-off and keeps its turn until the test releases it. */
const recorder = (log, label, turns) => async (turn) => {
	log.push({ label, at: performance.now() })
	turns.push(turn)
}
const labels = (log) => log.map((entry) => entry.label)

test('a request waits until the previous one has its reply, then keeps the spacing', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	const log = []
	const turns = []
	await scheduler.inTurn(recorder(log, 'poll', turns))
	const command = scheduler.inTurn(recorder(log, 'command', turns))
	await sleep(40)
	assert.deepEqual(labels(log), ['poll'], 'the command waits while the poll awaits its reply')
	const replyAt = performance.now()
	turns[0].done()
	await command
	assert.deepEqual(labels(log), ['poll', 'command'])
	assert.ok(log[1].at >= replyAt, 'after the reply')
	turns[1].done()
	assert.equal(scheduler.inFlight, 0)
})

test('requests leave in the order they were asked for, keeping the spacing', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	const log = []
	await Promise.all(
		['a', 'b', 'c', 'd'].map(async (label) =>
			scheduler.inTurn(async (turn) => {
				log.push({ label, at: performance.now() })
				setTimeout(() => turn.done(), 2)
			}),
		),
	)
	assert.deepEqual(labels(log), ['a', 'b', 'c', 'd'])
	for (let i = 1; i < log.length; i++) assert.ok(log[i].at - log[i - 1].at >= 10, `gap ${i}`)
})

test('STOP leaves at once, even with a request in flight, and the next one waits for both', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	const log = []
	const turns = []
	await scheduler.inTurn(recorder(log, 'poll', turns))
	await scheduler.now(recorder(log, 'STOP', turns))
	assert.equal(scheduler.inFlight, 2)
	assert.ok(log[1].at - log[0].at < 10, 'STOP did not wait')
	const next = scheduler.inTurn(recorder(log, 'next', turns))
	turns[0].done()
	await sleep(30)
	assert.deepEqual(labels(log), ['poll', 'STOP'], 'still waiting for the reply to the STOP')
	turns[1].done()
	await next
	assert.deepEqual(labels(log), ['poll', 'STOP', 'next'])
	assert.ok(log[2].at - log[1].at >= 10, 'the next one keeps its distance from the STOP')
	turns[2].done()
})

test('an aborted request is never sent and does not hold up the ones after it', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	const log = []
	const turns = []
	await scheduler.inTurn(recorder(log, 'poll', turns))
	const controller = new AbortController()
	const dropped = scheduler.inTurn(recorder(log, 'dropped', turns), controller.signal)
	const after = scheduler.inTurn(recorder(log, 'after', turns))
	controller.abort()
	await assert.rejects(dropped, { name: 'AbortError' })
	turns[0].done()
	await after
	assert.deepEqual(labels(log), ['poll', 'after'])
	turns[1].done()
})

test('a failed send releases its turn', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	await assert.rejects(
		scheduler.inTurn(async () => {
			throw new Error('socket closed')
		}),
		/socket closed/,
	)
	assert.equal(scheduler.inFlight, 0)
	await scheduler.inTurn(async (turn) => turn.done())
})

test('releaseAll frees the turns of a closed connection; their late done() changes nothing', async () => {
	const scheduler = new RequestScheduler(10, 1000)
	const turns = []
	await scheduler.inTurn(async (turn) => turns.push(turn))
	const next = scheduler.inTurn(async (turn) => turns.push(turn))
	scheduler.releaseAll()
	await next
	assert.equal(scheduler.inFlight, 1, 'the new request holds its turn')
	turns[0].done()
	assert.equal(scheduler.inFlight, 1, 'the old turn does not release the new one')
	turns[1].done()
	assert.equal(scheduler.inFlight, 0)
})

test('a forgotten turn is released after the hold limit, and reported', async () => {
	let forced = 0
	const scheduler = new RequestScheduler(0, 50, () => forced++)
	await scheduler.inTurn(async () => undefined)
	const startedAt = performance.now()
	await scheduler.inTurn(async (turn) => turn.done())
	assert.ok(performance.now() - startedAt >= 45, 'waited for the limit')
	assert.equal(forced, 1)
})
