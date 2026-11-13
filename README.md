# Work Louder for Cursor

Control Cursor's **Agents Window** with your Work Louder device. Six Agent Keys jump straight to your chats and light up with their status, and dedicated buttons handle new chats, the model picker, approvals and hold-to-talk dictation.

Everything the plugin needs is included. It runs on the JavaScript runtime that ships with Cursor, so there is nothing else to install.

## Requirements

- Cursor desktop on macOS or Windows.
- Work Louder Input, installed and running. Input owns the connection to your device.
- A supported device: Codex Micro, or Creator Micro v2 (including the Base and Pro variants).

## Get started

1. Install **Work Louder** from the Cursor Marketplace, then fully restart Cursor.
2. If Cursor asks, enable the plugin's **worklouder** MCP server in Customize.
3. The setup page opens in your browser the first time the plugin connects. Keep Input open and approve the connection request when Input shows it.
4. When Input reports your device, the setup page offers to add the **Cursor layer**. Choose **Yes** to add it to your current profile.
5. Select the Cursor layer on your device, then start or resume a chat in the Agents Window.

You can reopen setup at any time by running **/worklouder-setup** in a Cursor chat. Run **/worklouder-status** to check the connection.

## Controls

| Control | What it does |
| --- | --- |
| Six Agent Keys | Open the chat assigned to that key. |
| Dial left / right | Move to the previous / next assigned chat. |
| Dial press | Press Enter to confirm a menu or send from the composer. |
| New Chat button | Start a new chat (Cmd+N on macOS, Ctrl+N on Windows). |
| Model picker button | Open the model picker (Cmd+/ or Ctrl+/). Use stick up/down to choose, Send to confirm and Decline to close. |
| Approve / Decline | Approve (Cmd+Enter or Ctrl+Enter) or decline (Escape) a pending request. |
| Send | Press Enter to send from the composer. |
| Microphone | Hold to dictate with Cursor's voice input, and release to finish. |

The keyboard controls act on the focused Agents Window. Stick left/right and model-parameter cycling are not available in the Agents Window yet.

### Agent Key lighting

Agent Keys show white when a chat is idle, blue while it is working, green when it has finished and red after an error. The key for the chat you last opened from the device pulses. A finished chat returns to idle when you open it from the device or send it another prompt.

Chats are assigned to keys as they become active. A chat takes a key once you send a prompt or the agent responds; empty drafts are skipped. Closing a chat frees its key. Earlier chat history is not imported.

### Preferences

On the setup page you can adjust brightness, dim the lights or turn them off after a period of inactivity, and choose how chats are arranged on the keys: most recent, by priority, or pinned.

## Updating the Cursor layer

To get the latest bundled layer after an update, open setup and choose **Add Cursor layer again**. The confirmation names the device and profile, and Input verifies the change before the plugin reports success. Each confirmed request adds a separate layer. Your existing layers are kept.

The plugin reacts to its `cursor.` actions on any profile or layer, so you can copy those mappings into your own layers.

## Privacy and data

- The plugin talks to Input only on your computer, at `ws://127.0.0.1:19147/input`. It never accesses USB or Bluetooth directly and doesn't modify Cursor.
- Hooks discard prompt text, tool inputs, transcripts and account details right away. Only chat IDs, chat status, the model name and workspace paths are kept, in memory only, while the helper runs.
- Your pairing credentials, preferences and setup choices are saved in a file that only your user account can read:
  - macOS: `~/Library/Application Support/Work Louder/Cursor Plugin/state.json`
  - Windows: `%LOCALAPPDATA%\Work Louder\Cursor Plugin\state.json`
- The setup page is served only on your computer and requires a one-time token. The plugin cannot pair or add a layer without your confirmation.

## Troubleshooting

- **Nothing happens when I press a key.** Make sure Input is running, the Cursor layer is selected on the device, and `/worklouder-status` reports a connected device.
- **Permission was revoked.** Run `/worklouder-setup` and choose **Pair with Input**.
- **Cursor isn't found.** If Cursor is installed in an unusual location, set the `WORKLOUDER_CURSOR_EXECUTABLE` environment variable to the full path of the Cursor executable and restart Cursor.
- **Adding the layer timed out.** Check Input before you try again; the layer may already have been added.

## Uninstall

Remove the plugin in Customize. The background helper exits on its own about 90 seconds later. If you no longer want the plugin's saved data, revoke its connection in Input and delete the data folder listed above.

## Feedback and issues

Report problems and share ideas at [feedback.worklouder.cc](https://feedback.worklouder.cc/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing and packaging.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
