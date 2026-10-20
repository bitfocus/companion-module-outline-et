import dgram from 'node:dgram'
import { once } from 'node:events'

const TENTHS_PER_TURN = 3600
const MOTION_TICK_MS = 10

function xor(bytes) {
	let checksum = 0
	for (const byte of bytes) checksum ^= byte
	return checksum
}

function writeFixed(buffer, offset, length, text) {
	buffer.fill(0, offset, offset + length)
	buffer.write(text.slice(0, length), offset, 'latin1')
}

/**
 * Minimal ET turntable on 127.0.0.1: command port P and position port P+1.
 * It answers position requests and the two identity reads, executes move and
 * stop commands with a simple motion model, and records every datagram it
 * receives. Behaviour switches let tests simulate failures.
 */
export class FakeTurntable {
	tenths = 0
	moving = false
	direction = 'forward'
	mac = [0x00, 0x50, 0xc2, 0x11, 0x22, 0x33]
	name = 'ET TEST'
	firmware = '2.1.3.1'
	typeCode = 1

	answerPosition = true
	answerIdentity = true
	corruptPosition = false
	positionReplyDelayMs = 0
	identityReplyDelayMs = 0

	/** Reply to move and stop commands (with an ACK unless refused). */
	answerCommands = true
	/** Reply to STOP independently of the other command acknowledgements. */
	answerStop = true
	/** Execute move commands; false simulates a command lost on the way. */
	executeMoves = true
	/** Answer move commands with a NACK and do not move. */
	refuseMoves = false
	/** Acknowledge STOP but keep moving. */
	ignoreStop = false
	/** Answer set-zero with a NACK. */
	refuseZero = false
	/** Acknowledge set-zero without changing the position. */
	ignoreZero = false
	commandReplyDelayMs = 0
	/** The turntable reports "stopped" for this long after accepting a move. */
	startDelayMs = 0
	speedTenthsPerSecond = 2000

	/** Every datagram received, with its arrival time. */
	received = { command: [], position: [] }
	/** Position replies with the original requester endpoint, for faithful replay. */
	positionReplies = []
	/** Two-byte command replies with their original requester endpoint. */
	commandReplies = []
	port = 0

	constructor(overrides = {}) {
		Object.assign(this, overrides)
	}

	async start() {
		for (let attempt = 0; attempt < 20; attempt++) {
			const command = dgram.createSocket('udp4')
			command.bind(0, '127.0.0.1')
			await once(command, 'listening')
			const port = command.address().port
			const position = dgram.createSocket('udp4')
			try {
				position.bind(port + 1, '127.0.0.1')
				await once(position, 'listening')
			} catch {
				command.close()
				position.close()
				continue
			}
			command.on('message', (data, remote) => this.onCommand(data, remote))
			position.on('message', (data, remote) => this.onPosition(data, remote))
			this.commandSocket = command
			this.positionSocket = position
			this.port = port
			return port
		}
		throw new Error('No free pair of consecutive UDP ports')
	}

	async close() {
		this.halt()
		for (const socket of [this.commandSocket, this.positionSocket]) {
			if (!socket) continue
			socket.close()
			await once(socket, 'close')
		}
		this.commandSocket = undefined
		this.positionSocket = undefined
	}

	// ===== Motion model =====

	/** Start a movement, as a command or the front panel would. */
	startMove(direction, tenths) {
		this.halt()
		this.direction = direction
		const begin = () => {
			this.startTimer = undefined
			this.moving = true
			this.remaining = tenths
			this.motionTimer = setInterval(() => this.tick(), MOTION_TICK_MS)
		}
		if (this.startDelayMs > 0) this.startTimer = setTimeout(begin, this.startDelayMs)
		else begin()
	}

	/** Stop at once, wherever the turntable is. */
	halt() {
		clearTimeout(this.startTimer)
		clearInterval(this.motionTimer)
		this.startTimer = undefined
		this.motionTimer = undefined
		this.moving = false
		this.remaining = 0
	}

	tick() {
		const perTick = Math.max(1, Math.round((this.speedTenthsPerSecond * MOTION_TICK_MS) / 1000))
		const advance = Math.min(perTick, this.remaining)
		const signed = this.direction === 'forward' ? advance : -advance
		this.tenths = (((this.tenths + signed) % TENTHS_PER_TURN) + TENTHS_PER_TURN) % TENTHS_PER_TURN
		this.remaining -= advance
		if (this.remaining <= 0) this.halt()
	}

	// ===== Recording helpers =====

	/** Opcodes of the datagrams received on the command port. */
	commandOpcodes() {
		return this.received.command.map((entry) => entry.data[0])
	}

	/** Move, stop and set-zero frames, as hex strings. */
	motionFrames() {
		return this.received.command.filter((entry) => entry.data[0] <= 0x05).map((entry) => entry.data.toString('hex'))
	}

	framesWithOpcode(opcode) {
		return this.received.command.filter((entry) => entry.data[0] === opcode)
	}

	/** Replay an exact old position frame to the port that made that request. */
	replayPositionReply(index, delayMs = 0) {
		const response = this.positionReplies[index]
		if (!response) throw new Error(`No saved position reply ${index}`)
		const send = () => this.positionSocket?.send(response.data, response.remote.port, response.remote.address)
		if (delayMs > 0) setTimeout(send, delayMs)
		else send()
	}

	/** Replay an exact old command reply to the port that sent its command. */
	replayCommandReply(index, delayMs = 0) {
		const response = this.commandReplies[index]
		if (!response) throw new Error(`No saved command reply ${index}`)
		const send = () => this.commandSocket?.send(response.data, response.remote.port, response.remote.address)
		if (delayMs > 0) setTimeout(send, delayMs)
		else send()
	}

	/** Arrival times of the identity-block reads (the first of the two memory reads). */
	identityReadTimes() {
		return this.received.command
			.filter((entry) => entry.data[0] === 0x1a && entry.data.readUInt16LE(1) === 128)
			.map((entry) => entry.at)
	}

	identityReads() {
		return this.identityReadTimes().length
	}

	// ===== Protocol =====

	onPosition(data, remote) {
		this.received.position.push({ at: Date.now(), data: Buffer.from(data), remotePort: remote.port })
		if (!this.answerPosition) return
		const reply = Buffer.alloc(7)
		reply[0] = this.moving ? 0x04 : 0x05
		reply.writeUInt32BE(this.tenths, 1)
		reply[5] = this.direction === 'forward' ? 0x01 : 0x02
		reply[6] = xor(reply.subarray(0, 6))
		if (this.corruptPosition) reply[6] ^= 0xff
		this.positionReplies.push({
			at: Date.now(),
			data: Buffer.from(reply),
			remote: { address: remote.address, port: remote.port },
		})
		const send = () => this.positionSocket?.send(reply, remote.port, remote.address)
		if (this.positionReplyDelayMs > 0) setTimeout(send, this.positionReplyDelayMs)
		else send()
	}

	onCommand(data, remote) {
		this.received.command.push({ at: Date.now(), data: Buffer.from(data), remotePort: remote.port })
		if (data[0] === 0x1a) this.onLoad(data, remote)
		else if (data[0] >= 0x01 && data[0] <= 0x05 && data[0] !== 0x04) this.onMotionCommand(data, remote)
	}

	onLoad(data, remote) {
		if (!this.answerIdentity || data.length !== 5) return
		const address = data.readUInt16LE(1)
		const length = data.readUInt16LE(3)
		const block = address === 128 ? this.identityBlock() : address === 500 ? this.settingsBlock() : null
		if (!block || block.length !== length) return
		this.reply(block, remote, this.identityReplyDelayMs)
	}

	onMotionCommand(data, remote) {
		// Like the firmware, ignore malformed frames.
		if (data.length !== 4 || xor(data.subarray(0, 3)) !== data[3]) return
		const opcode = data[0]
		if (opcode === 0x05) {
			const ack = !this.refuseZero
			if (ack && !this.ignoreZero) this.tenths = 0
			if (this.answerCommands) this.reply(Buffer.from([ack ? 0x33 : 0x66, 0x00]), remote, this.commandReplyDelayMs)
			return
		}
		if (opcode === 0x03) {
			if (!this.ignoreStop) this.halt()
			if (this.answerCommands && this.answerStop)
				this.reply(Buffer.from([0x33, 0x00]), remote, this.commandReplyDelayMs)
			return
		}
		if (this.refuseMoves) {
			if (this.answerCommands) this.reply(Buffer.from([0x66, 0x00]), remote, this.commandReplyDelayMs)
			return
		}
		if (this.executeMoves) this.startMove(opcode === 0x01 ? 'forward' : 'backward', data.readUInt16BE(1))
		if (this.answerCommands) this.reply(Buffer.from([0x33, 0x00]), remote, this.commandReplyDelayMs)
	}

	reply(data, remote, delayMs) {
		if (data.length === 2) {
			this.commandReplies.push({
				at: Date.now(),
				data: Buffer.from(data),
				remote: { address: remote.address, port: remote.port },
			})
		}
		const send = () => this.commandSocket?.send(data, remote.port, remote.address)
		if (delayMs > 0) setTimeout(send, delayMs)
		else send()
	}

	identityBlock() {
		const block = Buffer.alloc(77)
		Buffer.from(this.mac).copy(block, 16)
		writeFixed(block, 22, 16, this.name)
		writeFixed(block, 54, 16, this.firmware)
		return block
	}

	settingsBlock() {
		const block = Buffer.alloc(50)
		block.writeUInt16BE(this.typeCode, 48)
		return block
	}
}

export async function waitFor(predicate, { timeoutMs = 2000, message = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(`Timed out waiting for ${message}`)
}

export const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
