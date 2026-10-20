import assert from 'node:assert/strict'
import test from 'node:test'

import { InstanceStatus } from '@companion-module/base'
import { getActionDefinitions } from '../dist/actions.js'
import { configProblem, DEFAULT_CONFIG, getConfigFields, isSameTarget, normalizeConfig } from '../dist/config.js'
import { getFeedbackDefinitions } from '../dist/feedbacks.js'
import { getPresetDefinitions } from '../dist/presets.js'
import { connectionStatus, createInitialState, currentMotion, isAtAngle, movementBlocker } from '../dist/state.js'
import { UpgradeScripts } from '../dist/upgrades.js'
import { buildVariableValues, getVariableDefinitions } from '../dist/variables.js'

const TARGET = { host: '10.0.0.5', port: 6667 }

function onlineState(reading, overrides = {}) {
	return { ...createInitialState(), link: 'online', telemetry: reading, identityStatus: 'verified', ...overrides }
}

test('configuration: only address and port', () => {
	assert.deepEqual(
		getConfigFields().map((field) => field.id),
		['host', 'port'],
	)
})

test('configuration: missing values take defaults, invalid ones are reported', () => {
	assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)
	assert.deepEqual(normalizeConfig({ host: ' 10.0.0.5 ', port: '6670' }), { host: '10.0.0.5', port: 6670 })
	assert.equal(normalizeConfig({ host: '10.0.0.5', port: null }).port, 6667)
	assert.equal(configProblem({ host: '10.0.0.5', port: 6667 }), null)
	assert.equal(configProblem({ host: '10.0.0.5', port: 65534 }), null)
	assert.match(configProblem({ host: '', port: 6667 }), /IP address/)
	assert.match(configProblem({ host: 'turntable.local', port: 6667 }), /IP address/)
	for (const port of [0, 65535, 12.5, 'abc']) {
		const config = normalizeConfig({ host: '10.0.0.5', port })
		assert.notEqual(config.port, 6667, `${port} must not silently become the default port`)
		assert.match(configProblem(config), /command port/, String(port))
	}
	assert.equal(
		isSameTarget(normalizeConfig({ host: '10.0.0.5', port: 'abc' }), normalizeConfig({ host: '10.0.0.5', port: 'x' })),
		true,
	)
})

test('first release has no upgrade scripts', () => {
	assert.deepEqual(UpgradeScripts, [])
})

test('variables show nothing current while telemetry is not valid', () => {
	const offline = {
		...createInitialState(),
		link: 'offline',
		telemetry: { tenths: 900, moving: false, direction: 'forward' },
	}
	assert.deepEqual(buildVariableValues(offline), {
		position: undefined,
		position_text: '—',
		motion: 'unknown',
		model: '',
		name: '',
		firmware: '',
	})

	const moving = onlineState(
		{ tenths: 1234, moving: true, direction: 'backward' },
		{ identity: { mac: '00:50:C2:01:02:03', name: 'ET PALCO', firmware: '2.1.3.1', model: 'ET50-3D' } },
	)
	assert.deepEqual(buildVariableValues(moving), {
		position: 123.4,
		position_text: '123.4°',
		motion: 'backward',
		model: 'ET50-3D',
		name: 'ET PALCO',
		firmware: '2.1.3.1',
	})
})

test('at-angle uses the circular distance and needs a stopped turntable', () => {
	const stopped = onlineState({ tenths: 3599, moving: false, direction: 'forward' })
	assert.equal(isAtAngle(stopped, 0, 0.5), true)
	assert.equal(isAtAngle(stopped, 360, 0.1), true)
	assert.equal(isAtAngle(stopped, 1, 0.5), false)
	assert.equal(isAtAngle(onlineState({ tenths: 0, moving: true, direction: 'forward' }), 0, 0.5), false)
	assert.equal(isAtAngle({ ...stopped, link: 'offline' }, 0, 0.5), false)
	assert.equal(isAtAngle(stopped, 0, undefined), false)
})

test('feedbacks follow valid telemetry only', () => {
	let state = onlineState({ tenths: 100, moving: true, direction: 'forward' })
	const feedbacks = getFeedbackDefinitions(() => state)
	const run = (id, options = {}) => feedbacks[id].callback({ options })

	assert.equal(run('online'), true)
	assert.equal(run('moving', { direction: 'any' }), true)
	assert.equal(run('moving', { direction: 'forward' }), true)
	assert.equal(run('moving', { direction: 'backward' }), false)
	assert.equal(run('at_angle', { angle: 10, tolerance: 0.5 }), false, 'moving')

	state = { ...state, link: 'offline' }
	assert.equal(run('online'), false)
	assert.equal(run('moving', { direction: 'any' }), false)
})

test('connection status combines telemetry and identity', () => {
	const cases = [
		[{ link: 'connecting' }, InstanceStatus.Connecting],
		[{ link: 'offline' }, InstanceStatus.ConnectionFailure],
		[{ link: 'online', identityStatus: 'reading' }, InstanceStatus.Connecting],
		[{ link: 'online', identityStatus: 'verified' }, InstanceStatus.Ok],
		[{ link: 'online', identityStatus: 'unavailable' }, InstanceStatus.UnknownWarning],
		[{ link: 'online', identityStatus: 'mismatch' }, InstanceStatus.UnknownWarning],
	]
	for (const [overrides, expected] of cases) {
		const { status } = connectionStatus({ ...createInitialState(), ...overrides }, TARGET)
		assert.equal(status, expected, JSON.stringify(overrides))
	}
	assert.match(connectionStatus({ ...createInitialState(), link: 'offline' }, TARGET).message, /10\.0\.0\.5:6668/)
})

test('presets only reference defined actions, feedbacks and variables', () => {
	const { structure, presets } = getPresetDefinitions()
	const actionIds = Object.keys(getActionDefinitions(recordingMotion([])))
	const feedbackIds = Object.keys(getFeedbackDefinitions(() => createInitialState()))
	const variableIds = Object.keys(getVariableDefinitions())

	const referenced = structure.flatMap((section) => section.definitions)
	assert.deepEqual([...referenced].sort(), Object.keys(presets).sort())
	assert.equal(referenced.length, 15)
	for (const preset of Object.values(presets)) {
		for (const step of preset.steps) {
			const groups = Object.values(step).flatMap((group) => (Array.isArray(group) ? group : group.actions))
			for (const action of groups) assert.ok(actionIds.includes(action.actionId), action.actionId)
		}
		for (const feedback of preset.feedbacks) assert.ok(feedbackIds.includes(feedback.feedbackId), feedback.feedbackId)
		for (const [, variable] of preset.style.text.matchAll(/\$\(outline-et:([a-z_]+)\)/g)) {
			assert.ok(variableIds.includes(variable), variable)
		}
	}
})

test('GO presets keep the target action, button text and at-angle feedback bound to one local angle', () => {
	const { presets } = getPresetDefinitions()
	const preset = presets.go_90
	const localAngle = preset.localVariables.find((variable) => variable.variableName === 'angle')
	const [action] = preset.steps[0].down
	const atAngle = preset.feedbacks.find((feedback) => feedback.feedbackId === 'at_angle')

	assert.equal(localAngle.startupValue, 90)
	assert.deepEqual(action.options.angle, { isExpression: true, value: '$(local:angle)' })
	assert.deepEqual(atAngle.options.angle, { isExpression: true, value: '$(local:angle)' })
	assert.equal(preset.style.textExpression, true)
	assert.match(preset.style.text, /\$\{\$\(local:angle\)\}°/)
	assert.doesNotMatch(preset.style.text, /90/)
	assert.equal(preset.style.text.split('\n').length, 3, 'the evaluator needs real line feeds, not template escapes')
})

test('GO and ZERO bind the action and direction label to one local direction', () => {
	const { presets } = getPresetDefinitions()
	for (const [presetId, initialDirection, expectedAngle] of [
		['go_90', 'shortest', { isExpression: true, value: '$(local:angle)' }],
		['zero_forward', 'forward', 0],
		['zero_backward', 'backward', 0],
		['zero_shortest', 'shortest', 0],
	]) {
		const preset = presets[presetId]
		const localDirection = preset.localVariables.find((variable) => variable.variableName === 'direction')
		const [action] = preset.steps[0].down
		const atAngle = preset.feedbacks.find((feedback) => feedback.feedbackId === 'at_angle')

		assert.equal(localDirection.startupValue, initialDirection)
		assert.deepEqual(action.options.direction, { isExpression: true, value: '$(local:direction)' })
		assert.ok(preset.style.textExpression)
		assert.match(preset.style.text, /\$\(local:direction\)/)
		assert.deepEqual(atAngle.options.angle, expectedAngle)
	}
	assert.match(presets.zero_forward.style.text, /"invalid"/)
	assert.equal(presets.zero_forward.style.text.split('\n').length, 2)
	assert.match(presets.go_90.style.text, /"shortest"/)
})

test('the three ZERO presets return to 0° and differ only in the initial direction', () => {
	const { presets, structure } = getPresetDefinitions()
	const zeroIds = ['zero_backward', 'zero_forward', 'zero_shortest']
	for (const id of zeroIds) {
		const [action] = presets[id].steps[0].down
		assert.equal(action.actionId, 'go_to', id)
		assert.equal(action.options.angle, 0, id)
		assert.match(
			presets[id].style.text,
			/"shortest"/,
			`${id}: a direction edited to shortest is shown, not marked invalid`,
		)
	}
	assert.deepEqual(
		zeroIds.map((id) => presets[id].localVariables[0].startupValue),
		['backward', 'forward', 'shortest'],
	)
	assert.equal(presets.zero_shortest.name, 'Return to zero (shortest path)')
	const positions = structure.find((section) => section.id === 'positions')
	assert.deepEqual(positions.definitions.slice(0, 3), zeroIds, 'listed together, ◀ ▶ then shortest')
})

function recordingMotion(calls) {
	return {
		stopMotion: async () => void calls.push(['stop']),
		step: async (direction, degrees) => void calls.push(['step', direction, degrees]),
		nudge: async (direction) => void calls.push(['nudge', direction]),
		goTo: async (degrees, direction) => void calls.push(['go_to', degrees, direction]),
		setZero: async () => void calls.push(['set_zero']),
	}
}

test('actions delegate to the session; steps are 1°, 5°, 10°, 30°, 90°, 180° or a custom multiple of 0.5°, fine adjustment is a separate action', async () => {
	const calls = []
	const actions = getActionDefinitions(recordingMotion(calls))
	assert.deepEqual(Object.keys(actions), ['stop', 'step', 'nudge', 'go_to', 'set_zero'])

	await actions.stop.callback({ options: {} })
	await actions.step.callback({ options: { direction: 'backward', amount: 90, angle: 5 } })
	await actions.step.callback({ options: { direction: 'forward', amount: 'custom', angle: 12.5 } })
	await actions.nudge.callback({ options: { direction: 'backward' } })
	await actions.go_to.callback({ options: { angle: 90, direction: 'shortest' } })
	await actions.set_zero.callback({ options: {} })
	assert.deepEqual(calls, [
		['stop'],
		['step', 'backward', 90],
		['step', 'forward', 12.5],
		['nudge', 'backward'],
		['go_to', 90, 'shortest'],
		['set_zero'],
	])

	const amount = actions.step.options.find((option) => option.id === 'amount')
	assert.deepEqual(
		amount.choices.map((choice) => choice.id),
		[1, 5, 10, 30, 90, 180, 'custom'],
	)
	const custom = actions.step.options.find((option) => option.id === 'angle')
	assert.deepEqual([custom.min, custom.max, custom.step], [0.5, 359.5, 0.5])
	assert.match(custom.description, /Multiples of 0\.5°/)
	assert.equal(custom.isVisibleExpression, "$(options:amount) == 'custom'")
	const goToAngle = actions.go_to.options.find((option) => option.id === 'angle')
	assert.deepEqual([goToAngle.min, goToAngle.max, goToAngle.step], [0, 360, 0.5])
	assert.match(goToAngle.description, /Multiples of 0\.5°/)
	assert.equal(actions.go_to.options.find((option) => option.id === 'direction').default, 'shortest')
})

test('the set-zero preset needs a 2 s press', () => {
	const { presets } = getPresetDefinitions()
	const [step] = presets.set_zero.steps
	assert.deepEqual([step.down, step.up], [[], []], 'a tap does nothing')
	assert.deepEqual(step[2000], { options: { runWhileHeld: true }, actions: [{ actionId: 'set_zero', options: {} }] })
})

test('a move sent by the module counts as motion until telemetry ends it', () => {
	const reading = { tenths: 100, moving: false, direction: 'forward' }
	const pendingMove = { direction: 'backward', fromTenths: 100, sentAt: 0, uncertain: false, started: false }
	const state = onlineState(reading, { pendingMove })
	assert.equal(currentMotion(state), 'backward')
	assert.equal(isAtAngle(state, 10, 0.5), false)
	assert.match(movementBlocker(state), /moving/)
	assert.equal(movementBlocker(onlineState(reading)), null)
	assert.match(movementBlocker(onlineState(reading, { stop: 'confirming' })), /STOP/)
	assert.match(movementBlocker(onlineState(reading, { identityStatus: 'mismatch' })), /different turntable/)
})

test('an unconfirmed STOP is a warning in the connection status', () => {
	const reading = { tenths: 100, moving: true, direction: 'forward' }
	const { status, message } = connectionStatus(onlineState(reading, { stop: 'unconfirmed' }), TARGET)
	assert.equal(status, InstanceStatus.UnknownWarning)
	assert.match(message, /STOP not confirmed/)
})
