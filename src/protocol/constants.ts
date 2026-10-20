/** Default command port (P) of an ET turntable. */
export const DEFAULT_COMMAND_PORT = 6667

/** Position telemetry is served on the port right after the command port (P+1). */
export const POSITION_PORT_OFFSET = 1

/** Highest command port that still leaves room for the telemetry port. */
export const MAX_COMMAND_PORT = 65535 - POSITION_PORT_OFFSET

/**
 * The only opcodes this module can emit. Speed, memory writes, network
 * settings, firmware update, TTL output and panel lock are deliberately not
 * part of the protocol layer.
 */
export const Opcode = {
	MoveForward: 0x01,
	MoveBackward: 0x02,
	Stop: 0x03,
	ReadPosition: 0x04,
	/** "RESET TO 0" in ET Controller: the current position becomes 0°. */
	SetZero: 0x05,
	LoadMemory: 0x1a,
} as const

export type Opcode = (typeof Opcode)[keyof typeof Opcode]

/** Move, stop and set-zero commands are answered with two bytes: `33 00` or `66 00` / `77 00`. */
export const COMMAND_REPLY_LENGTH = 2
export const ACK_MARKER = 0x33
export const NACK_MARKERS: readonly number[] = [0x66, 0x77]

/** Position reply: motion, position (u32 big-endian), direction, XOR checksum. */
export const POSITION_REPLY_LENGTH = 7

export const MotionCode = {
	Moving: 0x04,
	Stopped: 0x05,
} as const

export const DirectionCode = {
	Forward: 0x01,
	Backward: 0x02,
} as const

/** Angles travel on the wire as tenths of a degree. */
export const TENTHS_PER_TURN = 3600

/**
 * Read-only memory blocks: the same two reads ET Controller performs when it
 * connects. They carry the identity (MAC, name, firmware) and the turntable
 * type. Nothing is ever written back.
 */
export const MemoryBlock = {
	Identity: { address: 128, length: 77 },
	Settings: { address: 500, length: 50 },
} as const

export type MemoryBlockName = keyof typeof MemoryBlock

/** Field offsets inside `MemoryBlock.Identity`. */
export const IdentityLayout = {
	macOffset: 16,
	macLength: 6,
	nameOffset: 22,
	nameLength: 16,
	firmwareOffset: 54,
	firmwareLength: 16,
} as const

/** Field offsets inside `MemoryBlock.Settings`. */
export const SettingsLayout = {
	turntableTypeOffset: 48,
} as const

/** Turntable type codes stored in memory by current models. */
export const TurntableTypeCode = {
	Et50: 1,
	Et250R2: 2,
} as const

/**
 * Legacy ET250-3D (v1) units ship with this placeholder MAC prefix; their
 * stored turntable type is not reliable. Other Outline devices use the same
 * prefix (it was found on a Newton), so it identifies the model only for a
 * device that has already answered the ET identity read.
 */
export const LEGACY_MAC_PREFIX = '12:34:56'
