# Outline ET

Control Outline ET turntables (ET50-3D, ET250R2-3D and the legacy ET250-3D) from Bitfocus Companion: STOP, step, nudge, go to an angle and set zero, with live position, motion state and turntable identity.

The module sends only movement commands, set zero and reads. It never changes any setting of the turntable: speed, memory writes, network settings and firmware update are not implemented. Set zero redefines the position reference only when you ask for it.

**Safety: the network STOP is not an emergency stop.** Keep the turntable's own safety measures in place.

## Configuration

- **Turntable IP address**: the IPv4 address of the turntable.
- **Command port**: default `6667`. Position telemetry is read from the next port (`6668` by default).

Add one connection per turntable, and only one: see One client per turntable. ET Controller does not need to be running.

When the fixed local port opens, including after a restart, position polling waits 2 s so replies from the previous connection cannot become telemetry or confirm a STOP during that window. The connection stays Connecting until fresh telemetry and identity are available. STOP can still be sent as soon as the socket is ready. The protocol has no request IDs: replies delayed beyond the guard can still be ambiguous. With an automatic port, used when the fixed one is taken, polling starts at once.

## Actions

- **STOP**: stops the turntable. It is sent at once, even while another command waits for its reply. Presses closer than 0.2 s to the previous STOP are merged with it.
- **Step**: moves forward ▶ or backward ◀ from the current position by 1°, 5°, 10°, 30°, 90° or 180°, or by a custom angle: a multiple of `0.5°` from `0.5°` to `359.5°`. Other values, such as `0.3°`, are refused.
- **Nudge (fine adjustment)**: moves forward ▶ or backward ◀ by a fixed `0.5°`, like MAN in ET Controller.
- **Go to angle**: moves to an absolute angle (a multiple of `0.5°` from `0°` to `360°`, where `360°` is `0°`), forward, backward or along the shortest path (an exact half turn goes forward). Nothing is sent when the turntable is already there.
- **Set zero here**: the current position becomes `0°` (RESET TO 0 in ET Controller). Only while the turntable is stopped; a position read afterwards must show `0°`. The turntable does not move. The previous zero reference is lost. Check the zero after the turntable has been switched off and on.

Angles accept fixed values, variables and expressions. Step and go-to angles must be multiples of `0.5°`, the granularity of the movement: other values, such as `0.3°`, are refused and the log tells why.

How movements are handled:

- Before each movement the module reads the position once more, so a movement started from the front panel or ET Controller a moment earlier is not overlooked.
- A movement is refused, with a message in the log, while the turntable moves, while a STOP is being confirmed, without valid telemetry, or before the turntable identity has been read. Presses are never queued.
- An action ends when the turntable confirms the command, not when it arrives: Companion stops waiting for an action after 5 s, while a full turn takes minutes. Use the `motion` variable to know when the turntable has stopped (see Sequences).
- A command is never sent twice. When the turntable does not confirm a movement, the module treats it as possibly moving and follows the position until it stops.
- STOP is not instantaneous: the turntable decelerates. An ET250R2-3D stops up to about 1° further, within about 0.6 s; a faster motor, as on the ET50-3D, can travel further.
- After a STOP, the stop is confirmed only by a position reading. If none confirms it within about 2.5 s, the connection shows a warning and movements stay blocked until the turntable reports it has stopped.
- If telemetry is lost for 8 s while the turntable is moving, the module sends one STOP automatically, as ET Controller does.
- The turntable does not count turns: no mode protects cables from twisting. With cabled loads choose the direction explicitly and return to zero the other way.

## Sequences

The `motion` variable switches to `forward` or `backward` as soon as a movement is confirmed and back to `stopped` when the turntable stops, even for a movement shorter than one position reading. A trigger on the change of `motion`, with the condition `motion = stopped`, can start the next step of a sequence, for example a measurement in another program.

## Network traffic

- **Position**: one request to the telemetry port every second while the turntable is stopped, every 0.5 s while it moves, every 0.25 s while a STOP is confirmed. After a missed reply the next request waits 3 s (1 s while moving), and no new request is sent while an unanswered one is less than 2 s old.
- **Identity**: two memory reads on the command port each time telemetry comes online: MAC, name, firmware and model. At most three attempts, never while the turntable moves, and at most once every 30 s.
- **Commands**: movement, STOP and set-zero frames on the command port, one at a time.

The module uses one local UDP port for the whole connection, for both the command and the position port, to take as few of the turntable's connections as possible. The port is the same at every restart of Companion or of the connection: 20000 plus the last two octets of the turntable address (third × 256 + fourth), modulo 10000; 192.168.1.120 gets 20376. If that port is taken, typically by a second connection to the same turntable, the log says so and an automatic port is used. Requests leave one at a time: each waits for the reply to the previous one, or for its timeout. Any two datagrams to the turntable are at least 10 ms apart, and a command leaves at least 10 ms after the end of the previous movement. STOP is exempt from all these rules and always leaves at once: a command still waiting for its turn is then dropped, never sent.

## Feedbacks

- **Telemetry online**: the turntable is reporting its position (last valid reply within 5 s).
- **Turntable moving**: the turntable is moving, optionally in one direction only. A movement sent by Companion counts from its confirmation until the turntable stops.
- **Turntable at angle**: the turntable is stopped on the chosen angle, within the tolerance (default `0.5°`). The distance is circular: `359.9°` is `0.1°` away from `0°`.

Without valid telemetry every feedback is false.

## Variables

| Variable        | Content                                                      |
| --------------- | ------------------------------------------------------------ |
| `position`      | Position in degrees as a number; empty without telemetry     |
| `position_text` | Position for buttons, e.g. `123.4°`; `—` without telemetry   |
| `motion`        | `stopped`, `forward`, `backward` or `unknown`                |
| `model`         | `ET50-3D`, `ET250R2-3D`, `ET250-3D`, or empty when not known |
| `name`          | Name stored in the turntable                                 |
| `firmware`      | Firmware version of the turntable                            |

Forward and backward are the directions of the ▶ and ◀ buttons in ET Controller.

## Presets

- **Status**: position and motion state.
- **Motion**: STOP (always red), STEP ◀ ▶ 5° and 90°, MAN ◀ ▶ 0.5° (fine adjustment).
- **Positions**: ZERO ◀ and ZERO ▶ with an explicit direction, and ZERO shortest along the shortest path (all three return to `0°`); GO 90°, 180° and 270° along the shortest path; SET 0, which acts only after the button is held for 2 s. They turn green when the turntable is stopped on their angle.

Buttons turn amber while the turntable moves and grey without telemetry.

After dropping a GO preset, use the button's **Local Variables** panel to change **Target angle (°)** (`0`–`360`, in multiples of `0.5°`) and **Direction** (`forward`, `backward` or `shortest`). The action, button text and at-angle feedback share that target; the action and text share the direction. For ZERO, change **Direction** (`forward`, `backward` or `shortest`); its target stays at `0°`. Keep the generated expressions in the action, feedback and button text so these values stay linked. These presets require Companion 4.3 or later.

STEP and MAN use fixed labels: if you edit their action options, also update their button text.

## Connection status

- **Connecting**: waiting for the first position reply, or reading the turntable identity.
- **OK**: telemetry is valid and the identity has been read.
- **Warning**:
  - the identity could not be read: the connection stays read-only;
  - a different turntable now answers at the configured address: disable and re-enable the connection to accept it;
  - a STOP was not confirmed: movements stay blocked until the turntable reports it has stopped.
- **Connection failure**: no valid position reply for 5 s. Check the address, the port and the network path.

## One client per turntable

The turntable supports a limited number of network clients. With a second client querying it, especially during a movement, a turntable can stop answering anything, STOP included, until it is switched off and on. Therefore:

- Control each turntable from one client only: close ET Controller, or disconnect it from the turntable, while Companion controls it.
- Add only one Companion connection per turntable. A second one cannot use the turntable's local port, and the log reports it.
- Do not run other tools that query the turntable.

If the turntable stops answering, stop it from the front panel if needed, then power-cycle it.

The front panel stays available. Movements started there appear in Companion within about a second, and Companion refuses new movements while they run. There is no arbitration between operators: use one of them at a time.

## Compatibility

| Model                 | Status                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ET250R2-3D            | Tested with firmware 1.3.1                                                                                                                                     |
| ET50-3D               | Same firmware as the ET250R2-3D, with a faster motor; recognised automatically                                                                                 |
| ET250-3D (v1, legacy) | Tested with firmware 1.03; recognised automatically by its MAC. It may miss a position reply now and then: the module retries automatically, without a warning |

The model is detected when the connection starts: there is nothing to choose in the configuration.
