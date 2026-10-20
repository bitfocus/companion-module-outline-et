import assert from 'node:assert/strict'
import test from 'node:test'

import {
	circularDistance,
	degreesToTenths,
	formatDegrees,
	halfDegreesToTenths,
	planGoTo,
	travelDistance,
	wrapTenths,
} from '../dist/protocol/angles.js'
import { Opcode } from '../dist/protocol/constants.js'
import { preferredLocalPort } from '../dist/protocol/local-port.js'
import {
	encodeLoadMemory,
	encodeMove,
	encodeReadPosition,
	encodeSetZero,
	encodeStop,
	xorChecksum,
} from '../dist/protocol/frames.js'
import {
	decodeCommandReply,
	decodeIdentityBlock,
	decodePositionReply,
	decodeTurntableType,
	detectModel,
	formatMac,
	readFixedString,
} from '../dist/protocol/parser.js'

const hex = (buffer) => buffer.toString('hex')

function positionReply(motion, tenths, direction) {
	const reply = Buffer.alloc(7)
	reply[0] = motion
	reply.writeUInt32BE(tenths, 1)
	reply[5] = direction
	reply[6] = xorChecksum(reply.subarray(0, 6))
	return reply
}

function identityBlock({ mac = [0, 0x50, 0xc2, 1, 2, 3], name = 'ET PALCO', firmware = '2.1.3.1' } = {}) {
	const block = Buffer.alloc(77)
	Buffer.from(mac).copy(block, 16)
	block.write(name, 22, 'latin1')
	block.write(firmware, 54, 'latin1')
	return block
}

test('command frames carry the value big-endian and an XOR checksum', () => {
	assert.equal(hex(encodeReadPosition()), '04000004')
	assert.equal(hex(encodeStop()), '03000003')
	assert.equal(hex(encodeSetZero()), '05000005')
	assert.equal(hex(encodeMove('forward', 50)), '01003233')
	assert.equal(hex(encodeMove('backward', 3600)), '020e101c')
})

test('move frames reject distances outside one full turn', () => {
	for (const tenths of [0, -1, 3601, 1.5, Number.NaN]) {
		assert.throws(() => encodeMove('forward', tenths), RangeError, String(tenths))
	}
})

test('memory reads are limited to the two identity blocks', () => {
	assert.equal(hex(encodeLoadMemory('Identity')), '1a80004d00')
	assert.equal(hex(encodeLoadMemory('Settings')), '1af4013200')
})

test('the protocol layer can only emit the six allowed opcodes', () => {
	assert.deepEqual(
		Object.values(Opcode).sort((a, b) => a - b),
		[0x01, 0x02, 0x03, 0x04, 0x05, 0x1a],
	)
	const frames = [
		encodeMove('forward', 1),
		encodeMove('backward', 1),
		encodeStop(),
		encodeReadPosition(),
		encodeSetZero(),
		encodeLoadMemory('Identity'),
		encodeLoadMemory('Settings'),
	]
	for (const frame of frames) assert.ok(Object.values(Opcode).includes(frame[0]), hex(frame))
})

test('command replies: ACK, NACK and anything else', () => {
	assert.equal(decodeCommandReply(Buffer.from([0x33, 0x00])), 'ack')
	assert.equal(decodeCommandReply(Buffer.from([0x66, 0x00])), 'nack')
	assert.equal(decodeCommandReply(Buffer.from([0x77, 0x00])), 'nack')
	assert.equal(decodeCommandReply(Buffer.from([0x33, 0x01])), 'invalid')
	assert.equal(decodeCommandReply(Buffer.from([0x33, 0x00, 0x00])), 'invalid')
})

test('position replies are validated like ET Controller does', () => {
	assert.deepEqual(decodePositionReply(positionReply(0x05, 1234, 0x01)), {
		tenths: 1234,
		moving: false,
		direction: 'forward',
	})
	assert.deepEqual(decodePositionReply(positionReply(0x04, 3599, 0x02)), {
		tenths: 3599,
		moving: true,
		direction: 'backward',
	})

	const badChecksum = positionReply(0x05, 10, 0x01)
	badChecksum[6] ^= 0xff
	assert.equal(decodePositionReply(badChecksum), null)
	assert.equal(decodePositionReply(positionReply(0x06, 10, 0x01)), null, 'unknown motion code')
	assert.equal(decodePositionReply(positionReply(0x05, 10, 0x03)), null, 'unknown direction code')
	assert.equal(decodePositionReply(positionReply(0x05, 3600, 0x01)), null, 'position out of range')
	assert.equal(decodePositionReply(Buffer.alloc(6)), null, 'wrong length')
})

test('identity block: MAC, name and firmware, incomplete reads rejected', () => {
	assert.deepEqual(decodeIdentityBlock(identityBlock()), {
		mac: '00:50:C2:01:02:03',
		name: 'ET PALCO',
		firmware: '2.1.3.1',
	})
	assert.equal(decodeIdentityBlock(identityBlock({ mac: [0, 0, 0, 0, 0, 0] })), null, 'empty MAC')
	assert.equal(decodeIdentityBlock(identityBlock({ firmware: '' })), null, 'empty firmware')
	assert.equal(decodeIdentityBlock(Buffer.alloc(76)), null, 'wrong length')
})

test('settings block carries the turntable type big-endian', () => {
	const block = Buffer.alloc(50)
	block.writeUInt16BE(2, 48)
	assert.equal(decodeTurntableType(block), 2)
	assert.equal(decodeTurntableType(Buffer.alloc(49)), null)
})

test('fixed strings stop at NUL and drop trailing spaces', () => {
	const field = Buffer.from('ET50  \0garbage', 'latin1')
	assert.equal(readFixedString(field, 0, field.length), 'ET50')
	assert.equal(formatMac(Uint8Array.from([0x0a, 0xbc, 0, 1, 2, 0xff])), '0A:BC:00:01:02:FF')
})

test('model detection: legacy MAC first, then stored type, then name', () => {
	assert.equal(detectModel('12:34:56:78:9A:BC', 1, ''), 'ET250-3D')
	assert.equal(detectModel('00:50:C2:00:00:01', 1, ''), 'ET50-3D')
	assert.equal(detectModel('00:50:C2:00:00:01', 2, ''), 'ET250R2-3D')
	assert.equal(detectModel('00:50:C2:00:00:01', null, 'Outline ET50'), 'ET50-3D')
	assert.equal(detectModel('00:50:C2:00:00:01', 0, 'et250 stage'), 'ET250R2-3D')
	assert.equal(detectModel('00:50:C2:00:00:01', null, 'Stage left'), null)
})

test('angles: rounding to tenths and wrapping', () => {
	assert.equal(degreesToTenths(12.36), 124)
	assert.equal(degreesToTenths(90), 900)
	assert.equal(degreesToTenths(Number.NaN), null)
	assert.equal(formatDegrees(1234), '123.4')
	assert.equal(formatDegrees(0), '0.0')
	assert.equal(wrapTenths(3600), 0)
	assert.equal(wrapTenths(-1), 3599)
	assert.equal(circularDistance(3599, 0), 1)
	assert.equal(circularDistance(900, 2700), 1800)
})

test('step angles are whole multiples of 0.5°, tolerating float noise', () => {
	for (const [degrees, tenths] of [
		[0, 0],
		[0.5, 5],
		[1, 10],
		[1.5, 15],
		[7.5, 75],
		[30, 300],
		[359.5, 3595],
		[360, 3600],
		[0.1 + 0.4, 5],
		[1.5 + 1e-12, 15],
		[3 * 0.5, 15],
	]) {
		assert.equal(halfDegreesToTenths(degrees), tenths, String(degrees))
	}
	for (const degrees of [0.2, 0.3, 0.4, 0.25, 0.54, 1.25, 1.3, 4.9, 359.9, Number.NaN, Infinity]) {
		assert.equal(halfDegreesToTenths(degrees), null, String(degrees))
	}
})

test('the local port follows from the last two octets of the turntable address', () => {
	assert.equal(preferredLocalPort('192.168.1.120', 20000), 20376)
	assert.equal(preferredLocalPort('192.168.1.121', 20000), 20377)
	assert.equal(preferredLocalPort('10.0.0.1', 20000), 20001)
	assert.equal(preferredLocalPort('172.16.39.16', 20000), 20000, '39 × 256 + 16 = 10000 wraps to 0')
	assert.equal(preferredLocalPort('192.168.255.255', 20000), 25535)
	for (const host of ['et250.local', '192.168.1', '192.168.1.256', '192.168.1.-1', '::1']) {
		assert.equal(preferredLocalPort(host, 20000), 0, `${host}: automatic port`)
	}
	assert.equal(preferredLocalPort('192.168.1.120', 0), 0, 'base 0: automatic port')
	assert.equal(preferredLocalPort('192.168.1.120', 65500), 0, 'beyond 65535: automatic port')
})

test('go-to planning follows the chosen direction and never sends a null move', () => {
	assert.equal(travelDistance(3500, 100, 'forward'), 200)
	assert.equal(travelDistance(3500, 100, 'backward'), 3400)
	assert.deepEqual(planGoTo(3500, 100, 'forward'), { direction: 'forward', tenths: 200 })
	assert.deepEqual(planGoTo(3500, 100, 'backward'), { direction: 'backward', tenths: 3400 })
	assert.deepEqual(planGoTo(1000, 900, 'shortest'), { direction: 'backward', tenths: 100 })
	assert.deepEqual(planGoTo(0, 1800, 'shortest'), { direction: 'forward', tenths: 1800 }, 'half turn goes forward')
	assert.deepEqual(planGoTo(450, 450, 'backward'), { direction: 'backward', tenths: 0 })
	assert.deepEqual(planGoTo(0, 3600, 'forward'), { direction: 'forward', tenths: 0 }, '360° is 0°')
})
