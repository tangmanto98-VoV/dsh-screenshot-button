# dsh-screenshot-button

A camera button in the DeepSeek Harness composer that captures **one chosen monitor** — or every screen — and attaches the image to your draft, so a screenshot goes to the agent without opening a second app first.

在 DeepSeek Harness 的输入框里加一个相机按钮：只截你选中的那一块屏幕（也可以截全部屏幕），图片直接进草稿的附件栏，不用再借微信或截图工具中转。

## Install

```sh
dsh plugin add github:tangmanto98-VoV/dsh-screenshot-button
```

Or install it from the plugin market / **Settings → Plugins**. After installing, reload the window (Ctrl+R) so the browser half loads.

需要 **DeepSeek Harness 0.2.2-rc.1 或更新的 0.2.x**（`engines.dsh` 已声明），**仅支持 Windows 10/11**。

## Usage

The button sits in the composer toolbar, between the model selector and Send.

| Action | Result |
|---|---|
| Click the camera | Captures the screen you chose last time |
| Click the small arrow, or right-click the camera | Opens the screen list: **All screens** plus one row per monitor |
| Pick a row | Captures immediately and remembers that choice for next time |
| Esc / click elsewhere | Closes the list without capturing |

While capturing, the camera becomes a spinner (about one second per monitor). On success the icon flashes green and a thumbnail appears in the draft's attachment rail — exactly as if you had pasted the image from the clipboard. Send it like any other message. On failure the icon turns red and the reason appears above it.

Nothing is captured until you click, and nothing leaves the machine until you send the message that carries the image.

## How it works

1. The Host half (`index.js`) registers two routes on `ctx.webServer`:
   - `GET /dsh-screenshot/monitors` — the monitor layout from `Screen.AllScreens`
   - `GET /dsh-screenshot/capture?target=<index|all>` — one capture, returned as JSON with a base64 image
2. The capture itself is a PowerShell + `System.Drawing` helper that enters a per-monitor DPI awareness context, copies the requested screen with `CopyFromScreen`, scales it to a 3000 px longest edge, and encodes PNG — falling back to JPEG and then to a smaller frame until it fits a 4 MB budget. The compiled helper is cached in `%TEMP%` so later clicks skip the C# compile.
3. The browser half (`client.js`) wraps those bytes in a `File` and dispatches one synthetic `paste` event on the document. The app's own paste intake therefore handles it exactly like a clipboard image: attachment rail, upload progress, retry, and delivery all stay inside the harness.
4. The chosen screen is stored in `localStorage` under `dsh-screenshot-button:target`.

No file is written to disk; the image exists only as bytes on its way into the draft.

## Limitations

- **Windows only.** There is no macOS or Linux capture path.
- **Whole monitors, not regions.** There is no window or rectangle selection.
- **One occupant of the activity seat.** The button uses `conversation.input.activity`, which hosts a single control, so the experimental voice-input plugin cannot occupy it at the same time.
- **4 MB budget per capture.** Larger screens are downscaled (or re-encoded as JPEG) until they fit; a 4K portrait monitor typically lands as JPEG at native resolution.
- **Diagnostics** are appended to `%TEMP%\dsh-screenshot-button.log` by both halves; a failed click writes the reason there.

## Development

The package is plain ESM and hand-written browser code — no build step. Edit `index.js` or `client.js`, then disable and re-enable the plugin row in **Settings → Plugins** (the Host half needs a fresh module generation) and reload the window for the browser half.

## License

MIT
