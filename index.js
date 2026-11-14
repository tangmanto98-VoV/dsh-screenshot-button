/**
 * Screenshot button — Host half.
 *
 * Two routes: one lists the monitors, one captures a chosen monitor (or the
 * whole virtual desktop). A capture answers with a JSON envelope carrying a
 * base64 image, because a text-only bridge cannot be trusted with raw binary
 * bodies. The browser half (`client.js`) posts those bytes into the composer
 * through the app's own paste intake.
 */
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-screenshot-button'

/** Capture one monitor (`?target=<index>`) or all of them (`?target=all`). */
const CAPTURE_PATH = '/dsh-screenshot/capture'
/** Enumerate monitors so the browser half can offer a choice. */
const MONITORS_PATH = '/dsh-screenshot/monitors'
/** Side channel the browser half writes its diagnostics to. */
const LOG_PATH = '/dsh-screenshot/client-log'
/** Longest edge of the produced image. */
const MAX_WIDTH = 3000
/** Hard byte budget for one capture, so admission limits stay satisfied. */
const MAX_BYTES = 4_000_000
/** Where both halves record what happened; read it when the button misbehaves. */
const LOG_FILE = join(tmpdir(), 'dsh-screenshot-button.log')
/** Cached helper assembly, so later clicks skip the C# compile. */
const DLL_FILE = join(tmpdir(), 'dsh-screenshot-button-capture-v2.dll')

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // A missing log file must never fail a capture.
  }
}

const HELPER_SOURCE = String.raw`using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class DshScreenshotButton
{
    private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    private static readonly IntPtr PerMonitorV1 = new IntPtr(-3);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    private static IntPtr EnterPerMonitor()
    {
        IntPtr previous = IntPtr.Zero;
        try { previous = SetThreadDpiAwarenessContext(PerMonitorV2); } catch { }
        if (previous == IntPtr.Zero)
        {
            try { previous = SetThreadDpiAwarenessContext(PerMonitorV1); } catch { }
        }
        if (previous == IntPtr.Zero)
        {
            throw new InvalidOperationException("could not enter a per-monitor DPI awareness context");
        }
        return previous;
    }

    public static string Describe()
    {
        IntPtr previous = EnterPerMonitor();
        try
        {
            Screen[] screens = Screen.AllScreens;
            StringBuilder json = new StringBuilder();
            json.Append("{\"monitors\":[");
            for (int index = 0; index < screens.Length; index++)
            {
                Rectangle bounds = screens[index].Bounds;
                if (index > 0) json.Append(',');
                json.Append("{\"index\":").Append(index);
                json.Append(",\"x\":").Append(bounds.X);
                json.Append(",\"y\":").Append(bounds.Y);
                json.Append(",\"width\":").Append(bounds.Width);
                json.Append(",\"height\":").Append(bounds.Height);
                json.Append(",\"primary\":").Append(screens[index].Primary ? "true" : "false");
                json.Append('}');
            }
            Rectangle virtualBounds = SystemInformation.VirtualScreen;
            json.Append("],\"virtual\":{\"x\":").Append(virtualBounds.X);
            json.Append(",\"y\":").Append(virtualBounds.Y);
            json.Append(",\"width\":").Append(virtualBounds.Width);
            json.Append(",\"height\":").Append(virtualBounds.Height);
            json.Append("}}");
            return json.ToString();
        }
        finally
        {
            if (previous != IntPtr.Zero)
            {
                try { SetThreadDpiAwarenessContext(previous); } catch { }
            }
        }
    }

    private static byte[] Encode(Bitmap bitmap, bool jpeg)
    {
        using (MemoryStream stream = new MemoryStream())
        {
            if (jpeg)
            {
                ImageCodecInfo chosen = null;
                foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                {
                    if (candidate.FormatID == ImageFormat.Jpeg.Guid) { chosen = candidate; break; }
                }
                if (chosen == null) throw new InvalidOperationException("no JPEG encoder available");
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
                    bitmap.Save(stream, chosen, parameters);
                }
            }
            else
            {
                bitmap.Save(stream, ImageFormat.Png);
            }
            return stream.ToArray();
        }
    }

    private static Bitmap Render(Bitmap source, int width, int height)
    {
        if (width == source.Width && height == source.Height) return (Bitmap)source.Clone();
        Bitmap scaled = new Bitmap(width, height);
        using (Graphics target = Graphics.FromImage(scaled))
        {
            target.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            target.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            target.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            target.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;
            target.DrawImage(source, new Rectangle(0, 0, width, height));
        }
        return scaled;
    }

    public static string Capture(int target, int maxWidth, int maxBytes)
    {
        IntPtr previous = EnterPerMonitor();
        try
        {
            Screen[] screens = Screen.AllScreens;
            Rectangle bounds;
            if (target >= 0 && target < screens.Length)
            {
                bounds = screens[target].Bounds;
            }
            else
            {
                bounds = SystemInformation.VirtualScreen;
            }
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                throw new InvalidOperationException("the requested screen has no drawable area");
            }

            using (Bitmap full = new Bitmap(bounds.Width, bounds.Height))
            {
                using (Graphics screen = Graphics.FromImage(full))
                {
                    screen.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
                }

                double baseScale = maxWidth > 0 && bounds.Width > maxWidth
                    ? (double)maxWidth / (double)bounds.Width
                    : 1.0;

                for (int attempt = 0; attempt < 7; attempt++)
                {
                    double scale = baseScale * Math.Pow(0.72, attempt);
                    int width = Math.Max(1, (int)Math.Round(bounds.Width * scale));
                    int height = Math.Max(1, (int)Math.Round(bounds.Height * scale));

                    using (Bitmap frame = Render(full, width, height))
                    {
                        byte[] png = Encode(frame, false);
                        if (png.Length <= maxBytes) return "image/png\n" + Convert.ToBase64String(png);
                        byte[] jpeg = Encode(frame, true);
                        if (jpeg.Length <= maxBytes) return "image/jpeg\n" + Convert.ToBase64String(jpeg);
                    }
                }
            }
            throw new InvalidOperationException("no screenshot encodes within the byte budget");
        }
        finally
        {
            if (previous != IntPtr.Zero)
            {
                try { SetThreadDpiAwarenessContext(previous); } catch { }
            }
        }
    }
}`

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Build the helper script: reuse the cached assembly, otherwise compile it,
 * then run one call whose result is printed on stdout.
 * @param call - C# expression printed to stdout.
 */
function buildScript(call) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    `$dll = ${quotePowerShellSingle(DLL_FILE)}`,
    `$source = @'\n${HELPER_SOURCE}\n'@`,
    '$referenced = @("System.Windows.Forms.dll", "System.Drawing.dll")',
    '$loaded = $false',
    'if (Test-Path -LiteralPath $dll) {',
    '  try { Add-Type -Path $dll -ErrorAction Stop; $loaded = $true }',
    '  catch { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue }',
    '}',
    'if (-not $loaded) {',
    '  try { Add-Type -TypeDefinition $source -OutputAssembly $dll -ReferencedAssemblies $referenced -ErrorAction Stop } catch { }',
    '  Add-Type -TypeDefinition $source -ReferencedAssemblies $referenced -ErrorAction Stop',
    '}',
    `[Console]::Out.Write(${call})`,
  ].join('\n')
}

function powershellExecutable() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Run one helper call and resolve its trimmed stdout. */
function runHelper(call) {
  const encoded = Buffer.from(buildScript(call), 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      powershellExecutable(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 90_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')
          reject(new Error(detail || 'the capture helper failed'))
          return
        }
        resolve(String(stdout ?? '').trim())
      },
    )
  })
}

/** Resolve a `target` query value to a monitor index, or `-1` for all screens. */
function parseTarget(raw) {
  if (raw === null || raw === '' || raw === 'all') return -1
  const index = Number.parseInt(raw, 10)
  return Number.isFinite(index) && index >= 0 ? index : -1
}

let busy = false

/**
 * Mount the routes once the composition exposes a web server.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer
    if (webServer === undefined) return

    const sendJson = (response, status, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      response.end(body)
    }

    hostCtx.effect(() => {
      const disposers = []

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: MONITORS_PATH,
          handler(request, response) {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              sendJson(response, 405, { ok: false, error: 'method not allowed' })
              return
            }
            runHelper('[DshScreenshotButton]::Describe()')
              .then((text) => {
                if (!text.startsWith('{')) {
                  throw new Error(`unexpected helper output: ${text.slice(0, 120)}`)
                }
                const parsed = JSON.parse(text)
                sendJson(response, 200, { ok: true, monitors: parsed.monitors, virtual: parsed.virtual })
              })
              .catch((error) => {
                const message = String(error && error.message ? error.message : error)
                log(`monitors failed: ${message}`)
                sendJson(response, 500, { ok: false, error: message })
              })
          },
        }),
      )

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: CAPTURE_PATH,
          handler(request, response) {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              sendJson(response, 405, { ok: false, error: 'method not allowed' })
              return
            }
            let target = -1
            try {
              target = parseTarget(new URL(String(request.url ?? ''), 'http://127.0.0.1').searchParams.get('target'))
            } catch {
              target = -1
            }
            log(`capture request target=${target}`)
            if (busy) {
              sendJson(response, 429, { ok: false, error: 'a capture is already running' })
              return
            }
            busy = true
            runHelper(`[DshScreenshotButton]::Capture(${target}, ${MAX_WIDTH}, ${MAX_BYTES})`)
              .then((text) => {
                const split = text.indexOf('\n')
                if (split === -1) throw new Error('the capture helper returned no image')
                const mediaType = text.slice(0, split).trim()
                const base64 = text.slice(split + 1).replace(/\s+/g, '')
                log(`capture ok target=${target} ${mediaType} ${base64.length} base64 chars`)
                sendJson(response, 200, { ok: true, mediaType, base64, target })
              })
              .catch((error) => {
                const message = String(error && error.message ? error.message : error)
                log(`capture failed: ${message}`)
                sendJson(response, 500, { ok: false, error: message })
              })
              .finally(() => {
                busy = false
              })
          },
        }),
      )

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: LOG_PATH,
          handler(request, response) {
            let message = ''
            try {
              message = new URL(String(request.url ?? ''), 'http://127.0.0.1').searchParams.get('message') ?? ''
            } catch {
              message = ''
            }
            log(`client: ${message.slice(0, 800)}`)
            response.writeHead(204, { 'cache-control': 'no-store' })
            response.end()
          },
        }),
      )

      log(`mounted ${MONITORS_PATH} and ${CAPTURE_PATH} from ${fileURLToPath(import.meta.url)}`)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // Disposal must not throw during shutdown.
          }
        }
      }
    }, 'dsh-screenshot-button: screenshot routes')
  })
}
