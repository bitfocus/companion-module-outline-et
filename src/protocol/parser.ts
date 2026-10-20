import {
	ACK_MARKER,
	COMMAND_REPLY_LENGTH,
	DirectionCode,
	IdentityLayout,
	LEGACY_MAC_PREFIX,
	MemoryBlock,
	MotionCode,
	NACK_MARKERS,
	POSITION_REPLY_LENGTH,
	SettingsLayout,
	TENTHS_PER_TURN,
	TurntableTypeCode,
} from './constants.js'
import { xorChecksum, type Direction } from './frames.js'

export type CommandReply = 'ack' | 'nack' | 'invalid'

/** A two-byte reply to a move or stop command. An ACK only confirms reception. */
export function decodeCommandReply(data: Buffer): CommandReply {
	if (data.length !== COMMAND_REPLY_LENGTH || data[1] !== 0x00) return 'invalid'
	if (data[0] === ACK_MARKER) return 'ack'
	return NACK_MARKERS.includes(data[0]) ? 'nack' : 'invalid'
}

export interface PositionReading {
	/** Position in tenths of a degree, 0…3599. */
	tenths: number
	moving: boolean
	/** Direction of the current movement, or of the last one while stopped. */
	direction: Direction
}

/** Validate a position reply the same way ET Controller does; null when it must be ignored. */
export function decodePositionReply(data: Buffer): PositionReading | null {
	if (data.length !== POSITION_REPLY_LENGTH) return null
	if (xorChecksum(data.subarray(0, 6)) !== data[6]) return null

	const motion = data[0]
	if (motion !== MotionCode.Moving && motion !== MotionCode.Stopped) return null
	const direction = data[5]
	if (direction !== DirectionCode.Forward && direction !== DirectionCode.Backward) return null
	const tenths = data.readUInt32BE(1)
	if (tenths >= TENTHS_PER_TURN) return null

	return {
		tenths,
		moving: motion === MotionCode.Moving,
		direction: direction === DirectionCode.Forward ? 'forward' : 'backward',
	}
}

export interface IdentityFields {
	/** Uppercase, colon separated. */
	mac: string
	/** Description stored in the turntable. */
	name: string
	firmware: string
}

/**
 * Decode the identity block. Like ET Controller, a zero-filled MAC or an
 * empty firmware string means the read is incomplete.
 */
export function decodeIdentityBlock(data: Buffer): IdentityFields | null {
	if (data.length !== MemoryBlock.Identity.length) return null
	const { macOffset, macLength, nameOffset, nameLength, firmwareOffset, firmwareLength } = IdentityLayout
	const macBytes = data.subarray(macOffset, macOffset + macLength)
	const firmware = readFixedString(data, firmwareOffset, firmwareLength)
	if (macBytes.every((byte) => byte === 0) || firmware === '') return null
	return {
		mac: formatMac(macBytes),
		name: readFixedString(data, nameOffset, nameLength),
		firmware,
	}
}

/** Turntable type code stored in the settings block. */
export function decodeTurntableType(data: Buffer): number | null {
	if (data.length !== MemoryBlock.Settings.length) return null
	return data.readUInt16BE(SettingsLayout.turntableTypeOffset)
}

/** Fixed-width Latin-1 field, cut at the first NUL and without trailing spaces. */
export function readFixedString(data: Buffer, offset: number, length: number): string {
	const field = data.subarray(offset, offset + length)
	const end = field.indexOf(0)
	return field
		.subarray(0, end === -1 ? field.length : end)
		.toString('latin1')
		.trimEnd()
}

export function formatMac(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

export type TurntableModel = 'ET50-3D' | 'ET250R2-3D' | 'ET250-3D'

/**
 * Model shown to the user, for a device that answered the ET identity read.
 * The MAC prefix identifies legacy units first, because their stored type is
 * not reliable; then the stored type; the stored description is the last
 * resort.
 */
export function detectModel(mac: string, typeCode: number | null, name: string): TurntableModel | null {
	if (mac.startsWith(LEGACY_MAC_PREFIX)) return 'ET250-3D'
	if (typeCode === TurntableTypeCode.Et50) return 'ET50-3D'
	if (typeCode === TurntableTypeCode.Et250R2) return 'ET250R2-3D'
	const upperName = name.toUpperCase()
	if (upperName.includes('ET50')) return 'ET50-3D'
	if (upperName.includes('ET250')) return 'ET250R2-3D'
	return null
}
