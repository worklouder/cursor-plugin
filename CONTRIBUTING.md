# Contributing

## How it works

The plugin registers Cursor lifecycle hooks, two commands and one stdio MCP server. `scripts/run-cursor` (macOS) and `scripts/run-cursor.cmd` (Windows) start the Cursor executable with `ELECTRON_RUN_AS_NODE=1`, so users don't need Node installed. Each hook and MCP process starts or attaches to one shared local helper (`src/helper`). The helper owns the connection to Input, the observed chat state, the lighting and the device gestures.

The helper connects to Input through [`@worklouder/input-kit`](https://www.npmjs.com/package/@worklouder/input-kit), using Input's public WebSocket API at `ws://127.0.0.1:19147/input`. InputKit handles the protocol, validation and timeouts. The plugin's adapter (`src/client`) handles credentials, reconnects and lifecycle. Agent Keys open chats through Cursor's native `cursor://anysphere.cursor-deeplink/agent?id=<UUID>` links. The keyboard controls are firmware-native Input actions; the helper never generates key presses.

The bundled layer is in `src/resources/layers/cursor-default.json`. `docs/input-mappings.json` documents each control's mapping, and the tests check the layer against it.

## Development

Requirements: Node 22.15 or later and Python 3.

The Cursor Marketplace installs the plugin straight from this repository, so `@worklouder/input-kit` is committed under `node_modules/@worklouder/input-kit`, exactly as it is published on npm. To update it, change the pinned version in `package.json`, run `npm install`, and commit the updated package folder together with `package-lock.json`. `npm run check` fails if the committed copy doesn't match the pinned version.

```sh
npm run check     # syntax, JSON manifests and dependency checks
npm test          # unit and integration tests (uses mock Input/device responses)
npm run package   # build dist/worklouder-<version>-plugin.zip and the layer files
```

The package bundles InputKit into the ZIP, so the installed plugin needs no dependency installation. It also writes `dist/cursor-default-layer-<version>.json` (macOS) and `dist/cursor-default-layer-<version>-windows.json`, which can be imported in Input with **Import preset**.

To try a local build, copy the extracted `worklouder` folder to `~/.cursor/plugins/local/worklouder` (macOS) or `%USERPROFILE%\.cursor\plugins\local\worklouder` (Windows) and fully restart Cursor.

Environment variables for development:

| Variable | Purpose |
| --- | --- |
| `WORKLOUDER_CURSOR_EXECUTABLE` | Path to the Cursor executable when the launcher cannot find it. |
| `WORKLOUDER_STATE_DIR` | Use a different data directory. |
| `WORKLOUDER_NO_OPEN=1` | Don't open the setup page or links in a browser. |
| `WORKLOUDER_NO_AUTO_AUTHORIZE=1` | Skip the automatic first-time authorization request. |

## Manual testing

The automated tests can't cover a physical device, firmware or Cursor's visible UI. Before a release, check these with Cursor, Input and a device:

1. Install the package, enable the `worklouder` MCP server, and confirm `/worklouder-setup` and `/worklouder-status` work.
2. With no saved state, confirm setup opens once and authorization is requested once. Reject the request, restart, and confirm neither repeats. Pair from setup, restart, and confirm the plugin reconnects without another prompt.
3. On a spare profile, accept the layer offer and confirm Input verifies it. With separate fresh state, decline the offer, restart, and confirm it isn't offered again.
4. Create activity in several chats. Check that Agent Keys open the right chats, along with the dial direction, the status colors, the pulse, dimming and wake.
5. Check New Chat, Model Picker, Approve, Decline, Send and hold-to-talk in the focused Agents Window.
6. Disconnect and reconnect the device over USB and Bluetooth. Close Cursor and confirm the helper exits.
