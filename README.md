# dsh-screenshot-button

A camera button in the DeepSeek Harness composer that captures **one chosen monitor**, **every screen**, or **any rectangle you drag across several screens**, and attaches the image to your draft, so a screenshot goes to the agent without opening a second app first.

在 DeepSeek Harness 的输入框里加一个相机按钮：截你选中的那一块屏幕、全部屏幕，或者用鼠标跨屏拖出来的任意大小一块，图片直接进草稿的附件栏，不用再借微信或截图工具中转。

## Install

```sh
dsh plugin add github:tangmanto98-VoV/dsh-screenshot-button
```

Or install it from the plugin market / **Settings → Plugins**. After installing, reload the window (Ctrl+R) so the browser half loads.

需要 **DeepSeek Harness 0.2.2-rc.1 或更新的 0.2.x**（`engines.dsh` 已声明），**仅支持 Windows 10/11**。

Install a **copy** of the package into the profile rather than a `link:` that points at a folder you may reorganize — see [If the button disappears](#if-the-button-disappears) for why a moved folder turns into a silently missing button.

## Usage

The button sits in the composer toolbar, between the model selector and Send.

| Action | Result |
|---|---|
| Click the camera | Captures what you chose last time: a screen, all screens, or the last framed rectangle |
| Click the small arrow, or right-click the camera | Opens the list: **All screens**, one row per monitor, then **Free region (any size)** |
| Pick a monitor row or **All screens** | Captures immediately and remembers that choice |
| Pick **Free region** | The screen freezes and the pointer becomes a crosshair: drag any rectangle — it may cross monitor edges — and release to capture it |
| Right-click or Esc while selecting | Cancels; nothing is captured |
| Esc / click elsewhere | Closes the list without capturing |

While capturing, the camera becomes a spinner (about one second per monitor). On success the icon flashes green and a thumbnail appears in the draft's attachment rail — exactly as if you had pasted the image from the clipboard. Send it like any other message. On failure the icon turns red and the reason appears above it.

Nothing is captured until you click, and nothing leaves the machine until you send the message that carries the image.

## How it works

1. The Host half (`index.js`) registers three routes on `ctx.webServer`:
   - `GET /dsh-screenshot/monitors` — the monitor layout from `Screen.AllScreens`
   - `GET /dsh-screenshot/capture?target=<index|all|region>` — one capture, returned as JSON with a base64 image; `?rect=x,y,width,height` re-captures one rectangle without asking
   - `GET /dsh-screenshot/log?message=…` — best-effort client diagnostics

   Every route asks the composition's `connection` service for a rejection first (`ctx.connection.requestRejection(req)`). That Host/Origin fence answers DNS-rebinding and cross-site callers with **403**, and callers without a live browser session with **401**, so a foreign page cannot drive a capture even though it can reach the loopback port.
2. The capture itself is a PowerShell + `System.Drawing` helper that enters a per-monitor DPI awareness context, copies the requested screen with `CopyFromScreen`, scales it to a 3000 px longest edge, and encodes PNG — falling back to JPEG and then to a smaller frame until it fits a 4 MB budget. The compiled helper is cached in `%TEMP%` so later clicks skip the C# compile.
3. The browser half (`client.js`) wraps those bytes in a `File` and dispatches one synthetic `paste` event on the document. The app's own paste intake therefore handles it exactly like a clipboard image: attachment rail, upload progress, retry, and delivery all stay inside the harness.
4. The chosen screen is stored in `localStorage` under `dsh-screenshot-button:target`.

No file is written to disk; the image exists only as bytes on its way into the draft.

## Limitations

- **Windows only.** There is no macOS or Linux capture path.
- **Free region freezes the screen.** The rectangle is cut out of a still taken the moment you pick the mode, so anything that moves during the drag is not recorded — the same behaviour as the Windows snipping tool. There is no window or control snapping.
- **One occupant of the activity seat.** The button uses `conversation.input.activity`, which hosts a single control, so the experimental voice-input plugin cannot occupy it at the same time.
- **4 MB budget per capture.** Larger screens are downscaled (or re-encoded as JPEG) until they fit; a 4K portrait monitor typically lands as JPEG at native resolution.
- **Diagnostics** are appended to `%TEMP%\dsh-screenshot-button.log` by both halves; a failed click writes the reason there.

## If the button disappears

A profile composes its plugin rows **at boot**. If the package directory the profile points at is missing at that moment — for example because you moved or renamed the folder a `link:` install pointed to — DSH skips the whole bundle **silently**: the reason goes to stderr, and the desktop build keeps no stderr, so the button vanishes with no error anywhere in the UI.

Recovery:

1. Make sure the package directory exists again at the path the profile points at.
2. Re-apply the bundle: toggle this plugin's row in **Settings → Plugins**, or re-select the bundle.
3. Reload the window (Ctrl+R) for the browser half.

Restarting the app is not required — the bundle can be re-applied to the running Host, and the session survives.

Because a missing directory is invisible, prefer a **copy** of the package inside the profile over a `link:` to a folder you may reorganize.

一个提醒：如果你打算移动或重命名插件所在的文件夹，请往 profile 里装一份**副本**，不要用 `link:` 指过去。启动时目录不在，DSH 只会静默跳过整个 bundle，界面上看不到任何报错；把目录放回去再重新应用一次 bundle 即可，不用重启应用。

## Development

The package is plain ESM and hand-written browser code — no build step. Edit `index.js` or `client.js`, then disable and re-enable the plugin row in **Settings → Plugins** (the Host half needs a fresh module generation) and reload the window for the browser half.

If you installed the profile copy instead of linking the checkout, re-copy the changed files into the profile before re-applying the bundle.

The C# helper is written to `%TEMP%\dsh-screenshot-button-helper-v3.cs` and invoked through `powershell -EncodedCommand`. The source is kept out of the command line on purpose: Windows caps that line at 32767 characters, and passing the source inline fails as `spawn ENAMETOOLONG`, which reads like a missing tool rather than a long argument.

## License

MIT
