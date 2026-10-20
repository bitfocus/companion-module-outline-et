import { MemoryBlock, Opcode, TENTHS_PER_TURN, type MemoryBlockName } from './constants.js'

export type Direction = 'forward' | 'backward'

/** XOR of every byte: the checksum of command frames and position replies. */
export function xorChecksum(bytes: Uint8Array): number {
	let checksum = 0
	for (const byte of bytes) checksum ^= byte
	return checksum
}

function commandFrame(opcode: Opcode, value: number): Buffer {
	const frame = Buffer.alloc(4)
	frame[0] = opcode
	frame.writeUInt16BE(value, 1)
	frame[3] = xorChecksum(frame.subarray(0, 3))
	return frame
}

/** Relative move of `tenths` tenths of a degree, one full turn at most. */
export function encodeMove(direction: Direction, tenths: number): Buffer {
	if (!Number.isInteger(tenths) || tenths < 1 || tenths > TENTHS_PER_TURN) {
		throw new RangeError(`Move distance must be 1…${TENTHS_PER_TURN} tenths of a degree, got ${tenths}`)
	}
	return commandFrame(direction === 'forward' ? Opcode.MoveForward : Opcode.MoveBackward, tenths)
}

export function encodeStop(): Buffer {
	return commandFrame(Opcode.Stop, 0)
}

export function encodeReadPosition(): Buffer {
	return commandFrame(Opcode.ReadPosition, 0)
}

/** Define the current position as 0°. */
export function encodeSetZero(): Buffer {
	return commandFrame(Opcode.SetZero, 0)
}

/** Read one of the two identity blocks: opcode, then address and length little-endian. */
export function encodeLoadMemory(block: MemoryBlockName): Buffer {
	const { address, length } = MemoryBlock[block]
	const frame = Buffer.alloc(5)
	frame[0] = Opcode.LoadMemory
	frame.writeUInt16LE(address, 1)
	frame.writeUInt16LE(length, 3)
	return frame
}
