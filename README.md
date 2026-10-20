# companion-module-outline-et

[Bitfocus Companion](https://bitfocus.io/companion) module for Outline ET turntables (ET50-3D, ET250R2-3D and the legacy ET250-3D). It offers STOP, step, nudge (fine adjustment), go-to and set-zero actions, reads the position and motion state over UDP, and publishes them as variables, feedbacks and presets.

User documentation is in [companion/HELP.md](companion/HELP.md).

## Requirements

- Bitfocus Companion 4.3 or later (module API 2.0)
- An ET turntable reachable over UDP: command port `6667` by default, position telemetry on the next port

## Development

Requires Node.js 22 and Yarn 4 (via Corepack).

```bash
yarn install
yarn dev          # watch build
yarn build        # compile to dist/
yarn test         # build, then run the tests
yarn typecheck
yarn lint
yarn format:check
yarn package      # build the release package
yarn package:beta # build a prerelease package (isPrerelease: true)
```

The package can be imported in Companion under _Modules → Import module package_.

The tests run against a simulated turntable on `127.0.0.1`; no hardware is needed.

## Layout

| Path                                                           | Responsibility                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/main.ts`                                                  | Entrypoint: exports the instance class and the upgrade scripts             |
| `src/instance.ts`                                              | Companion adapter: configuration lifecycle, definitions, publishing        |
| `src/et-session.ts`                                            | Device session: socket, polling, identity reads, motion commands, state    |
| `src/state.ts`                                                 | Session state and pure derived views (motion, at-angle, connection status) |
| `src/settings.ts`                                              | Fixed runtime timings, not exposed in the configuration                    |
| `src/protocol/`                                                | Frame encoding and decoding, angle maths, UDP link, request scheduling     |
| `src/actions.ts`, `feedbacks.ts`, `variables.ts`, `presets.ts` | Companion definitions                                                      |
| `src/config.ts`                                                | Connection configuration: address and port                                 |
| `tests/`                                                       | Unit tests and session tests against the simulated turntable               |

## Protocol surface

The protocol layer can build only these frames; everything else in the ET protocol (speed, memory writes, network settings, firmware update) is deliberately not implemented, and a test enforces it.

| Operation           | Port | Request          |
| ------------------- | ---- | ---------------- |
| Move forward        | P    | `01 NH NL CK`    |
| Move backward       | P    | `02 NH NL CK`    |
| Stop                | P    | `03 00 00 03`    |
| Set zero            | P    | `05 00 00 05`    |
| Read position       | P+1  | `04 00 00 04`    |
| Read identity       | P    | `1A 80 00 4D 00` |
| Read turntable type | P    | `1A F4 01 32 00` |

## Transport

The turntable firmware handles a limited number of network clients and can stop answering under extra traffic, so the transport is deliberately conservative:

- One UDP socket per connection, for both the command and the position port. Replies are told apart by their length, not by their source port, because legacy units answer from a port numbered like the request's source port.
- The local port is the same at every restart: `20000` plus the last two octets of the turntable address, modulo `10000`. If it is taken, an automatic port is used and the log says so.
- One request at a time, at least 10 ms between datagrams and after the end of a movement. STOP is exempt and always leaves at once.
- When the fixed port opens, position reads wait 2 s so that late replies to a previous connection are ignored.

The protocol has no request IDs and no sequence numbers; see the comments in `src/protocol/` and `src/et-session.ts` for the remaining limits.

## License

[MIT](LICENSE)
