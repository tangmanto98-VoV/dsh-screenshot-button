/**
 * Screenshot button — Host half.
 *
 * Three routes: one lists the monitors, one captures a chosen monitor (or the
 * whole virtual desktop), and one lets the pointer drag any rectangle across
 * every screen. A capture answers with a JSON envelope carrying a base64
 * image, because a text-only bridge cannot be trusted with raw binary bodies.
 * The browser half (`client.js`) posts those bytes into the composer through
 * the app's own paste intake.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
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
/** One capture finishes in about a second; the interactive selector waits for the pointer. */
const CAPTURE_TIMEOUT_MS = 90_000
const REGION_TIMEOUT_MS = 300_000
/** Where both halves record what happened; read it when the button misbehaves. */
const LOG_FILE = join(tmpdir(), 'dsh-screenshot-button.log')
/**
 * The helper's C# source, written to disk for every call: `-EncodedCommand`
 * carries the whole script on the Windows command line, and that line is capped
 * at 32767 characters — the selector pushed the source past it (ENAMETOOLONG).
 * The call itself now only refers to this file.
 */
const HELPER_SOURCE_FILE = join(tmpdir(), 'dsh-screenshot-button-helper-v3.cs')
/** Cached helper assembly, so later clicks skip the C# compile. */
const DLL_FILE = join(tmpdir(), 'dsh-screenshot-button-capture-v3.dll')

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // A missing log file must never fail a capture.
  }
}

const HELPER_SOURCE = String.raw`using System;
using System.Collections.Generic;
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

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

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

    private static void RestorePerMonitor(IntPtr previous)
    {
        if (previous != IntPtr.Zero)
        {
            try { SetThreadDpiAwarenessContext(previous); } catch { }
        }
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
            RestorePerMonitor(previous);
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

    /** Fit the frame into the byte budget: native PNG, then JPEG, then smaller frames. */
    private static string EncodeWithinBudget(Bitmap source, int maxWidth, int maxBytes)
    {
        double baseScale = maxWidth > 0 && source.Width > maxWidth
            ? (double)maxWidth / (double)source.Width
            : 1.0;

        for (int attempt = 0; attempt < 7; attempt++)
        {
            double scale = baseScale * Math.Pow(0.72, attempt);
            int width = Math.Max(1, (int)Math.Round(source.Width * scale));
            int height = Math.Max(1, (int)Math.Round(source.Height * scale));

            using (Bitmap frame = Render(source, width, height))
            {
                byte[] png = Encode(frame, false);
                if (png.Length <= maxBytes) return "image/png\n" + Convert.ToBase64String(png);
                byte[] jpeg = Encode(frame, true);
                if (jpeg.Length <= maxBytes) return "image/jpeg\n" + Convert.ToBase64String(jpeg);
            }
        }
        throw new InvalidOperationException("no screenshot encodes within the byte budget");
    }

    /** Put the absolute rectangle on the header line: "<media>[;rect=x,y,w,h]\n<base64>". */
    private static string WithRect(string encoded, Rectangle absolute)
    {
        int split = encoded.IndexOf('\n');
        if (split < 0) return encoded;
        string media = encoded.Substring(0, split);
        string data = encoded.Substring(split + 1);
        return media + ";rect=" + absolute.X + "," + absolute.Y + "," + absolute.Width + "," + absolute.Height + "\n" + data;
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
                return EncodeWithinBudget(full, maxWidth, maxBytes);
            }
        }
        finally
        {
            RestorePerMonitor(previous);
        }
    }

    /** Re-capture one exact rectangle, in virtual-screen pixels. */
    public static string CaptureRect(int x, int y, int width, int height, int maxWidth, int maxBytes)
    {
        if (width <= 0 || height <= 0)
        {
            throw new InvalidOperationException("the requested rectangle has no drawable area");
        }
        IntPtr previous = EnterPerMonitor();
        try
        {
            using (Bitmap region = new Bitmap(width, height))
            {
                using (Graphics screen = Graphics.FromImage(region))
                {
                    screen.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                }
                return WithRect(EncodeWithinBudget(region, maxWidth, maxBytes), new Rectangle(x, y, width, height));
            }
        }
        finally
        {
            RestorePerMonitor(previous);
        }
    }

    /**
     * Freeze the whole virtual desktop, let the pointer drag a rectangle on it,
     * and return that rectangle. The selection layer is one borderless window
     * spanning every monitor, so a drag can cross screen edges; Esc or a
     * right-click returns "cancel".
     */
    public static string SelectRegion(int maxWidth, int maxBytes)
    {
        IntPtr previous = EnterPerMonitor();
        try
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                throw new InvalidOperationException("no drawable screen area");
            }

            using (Bitmap full = new Bitmap(bounds.Width, bounds.Height))
            {
                using (Graphics screen = Graphics.FromImage(full))
                {
                    screen.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
                }

                Rectangle selection;
                using (RegionSelector selector = new RegionSelector(full, bounds))
                {
                    if (selector.ShowDialog() != DialogResult.OK) return "cancel";
                    selection = selector.Selection;
                }
                if (selection.Width < 2 || selection.Height < 2) return "cancel";

                using (Bitmap cropped = new Bitmap(selection.Width, selection.Height))
                {
                    using (Graphics target = Graphics.FromImage(cropped))
                    {
                        target.DrawImage(full, new Rectangle(0, 0, selection.Width, selection.Height), selection, GraphicsUnit.Pixel);
                    }
                    Rectangle absolute = new Rectangle(bounds.X + selection.X, bounds.Y + selection.Y, selection.Width, selection.Height);
                    return WithRect(EncodeWithinBudget(cropped, maxWidth, maxBytes), absolute);
                }
            }
        }
        finally
        {
            RestorePerMonitor(previous);
        }
    }

    /**
     * The dragging layer: the frozen desktop drawn over every monitor at 1:1,
     * dimmed outside the rectangle, with the live pixel size beside it.
     */
    public class RegionSelector : Form
    {
        private readonly Bitmap source;
        private Point anchor;
        private Rectangle selection;
        private bool dragging;

        public Rectangle Selection { get { return selection; } }

        public RegionSelector(Bitmap source, Rectangle virtualBounds)
        {
            this.source = source;
            AutoScaleMode = AutoScaleMode.None;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = virtualBounds;
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            DoubleBuffered = true;
            Text = "DSH region selector";
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try { SetForegroundWindow(Handle); } catch { }
            try { Activate(); } catch { }
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right) { Cancel(); return; }
            if (e.Button != MouseButtons.Left) return;
            dragging = true;
            anchor = e.Location;
            selection = Rectangle.Empty;
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (!dragging) return;
            Rectangle previous = selection;
            selection = Normalize(anchor, e.Location);
            Invalidate(RepaintFor(previous, selection));
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (!dragging || e.Button != MouseButtons.Left) return;
            dragging = false;
            Rectangle previous = selection;
            selection = Normalize(anchor, e.Location);
            Invalidate(RepaintFor(previous, selection));
            if (selection.Width < 2 || selection.Height < 2) { Cancel(); return; }
            DialogResult = DialogResult.OK;
            Close();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) { Cancel(); return; }
            base.OnKeyDown(e);
        }

        private void Cancel()
        {
            DialogResult = DialogResult.Cancel;
            Close();
        }

        private static Rectangle Normalize(Point from, Point to)
        {
            return Rectangle.FromLTRB(
                Math.Min(from.X, to.X),
                Math.Min(from.Y, to.Y),
                Math.Max(from.X, to.X),
                Math.Max(from.Y, to.Y));
        }

        /** A dirty region that also covers the size badge and the border. */
        private static Rectangle RepaintFor(Rectangle previous, Rectangle current)
        {
            Rectangle union = Rectangle.Union(previous, current);
            if (union.Width <= 0 || union.Height <= 0) union = Rectangle.FromLTRB(current.Left, current.Top, current.Right, current.Bottom);
            union.Inflate(190, 80);
            return union;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics graphics = e.Graphics;
            Rectangle clip = e.ClipRectangle;
            graphics.DrawImage(source, clip, clip, GraphicsUnit.Pixel);

            using (SolidBrush veil = new SolidBrush(Color.FromArgb(118, 0, 0, 0)))
            {
                foreach (Rectangle band in Subtract(clip, selection))
                {
                    if (band.Width > 0 && band.Height > 0) graphics.FillRectangle(veil, band);
                }
            }

            if (selection.Width > 0 && selection.Height > 0)
            {
                using (Pen border = new Pen(Color.FromArgb(255, 96, 165, 250), 2f))
                {
                    graphics.DrawRectangle(border, selection.Left, selection.Top,
                        Math.Max(1, selection.Width - 1), Math.Max(1, selection.Height - 1));
                }
                DrawBadge(graphics, selection.Width + " \u00d7 " + selection.Height, selection.Left, selection.Top, true);
            }
            else
            {
                DrawBadge(graphics, "\u62d6\u52a8\u6846\u9009\uff08\u53ef\u8df3\u5c4f\u5e55\uff09 \u00b7 \u53f3\u952e\u6216 Esc \u53d6\u6d88", 24, 24, false);
            }
        }

        private void DrawBadge(Graphics graphics, string text, int x, int y, bool above)
        {
            Font font = SystemFonts.MessageBoxFont;
            Size measured = TextRenderer.MeasureText(text, font);
            int width = measured.Width + 12;
            int height = measured.Height + 6;
            int left = x;
            int top = above ? y - height - 6 : y;
            if (top < 2) top = above ? y + 4 : 2;
            if (left + width > ClientSize.Width - 2) left = Math.Max(2, ClientSize.Width - width - 2);
            if (left < 2) left = 2;

            Rectangle box = new Rectangle(left, top, width, height);
            using (SolidBrush background = new SolidBrush(Color.FromArgb(214, 17, 17, 20)))
            {
                graphics.FillRectangle(background, box);
            }
            TextRenderer.DrawText(graphics, text, font, box, Color.FromArgb(255, 244, 244, 245),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }

        /** The parts of "outer" that fall outside "inner". */
        private static IEnumerable<Rectangle> Subtract(Rectangle outer, Rectangle inner)
        {
            if (outer.Width <= 0 || outer.Height <= 0) yield break;
            Rectangle overlap = Rectangle.Intersect(outer, inner);
            if (overlap.Width <= 0 || overlap.Height <= 0)
            {
                yield return outer;
                yield break;
            }
            if (overlap.Top > outer.Top)
            {
                yield return Rectangle.FromLTRB(outer.Left, outer.Top, outer.Right, overlap.Top);
            }
            if (overlap.Bottom < outer.Bottom)
            {
                yield return Rectangle.FromLTRB(outer.Left, overlap.Bottom, outer.Right, outer.Bottom);
            }
            if (overlap.Left > outer.Left)
            {
                yield return Rectangle.FromLTRB(outer.Left, overlap.Top, overlap.Left, overlap.Bottom);
            }
            if (overlap.Right < outer.Right)
            {
                yield return Rectangle.FromLTRB(overlap.Right, overlap.Top, outer.Right, overlap.Bottom);
            }
        }
    }
}`

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Build the helper script: reuse the cached assembly, otherwise compile it,
 * then run one call whose result is printed on stdout. The C# source is read
 * from {@link HELPER_SOURCE_FILE} instead of being embedded here, so the
 * command line stays far below the Windows limit.
 * @param call - C# expression printed to stdout.
 */
function buildScript(call) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    `$dll = ${quotePowerShellSingle(DLL_FILE)}`,
    `$source = [IO.File]::ReadAllText(${quotePowerShellSingle(HELPER_SOURCE_FILE)}, [Text.Encoding]::UTF8)`,
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

/**
 * Run one helper call and resolve its trimmed stdout.
 * @param call - C# expression printed to stdout.
 * @param timeoutMs - how long the child may run; the selector waits for a drag.
 */
function runHelper(call, timeoutMs = CAPTURE_TIMEOUT_MS) {
  try {
    writeFileSync(HELPER_SOURCE_FILE, HELPER_SOURCE, 'utf8')
  } catch (error) {
    const detail = String(error && error.message ? error.message : error)
    return Promise.reject(new Error(`could not write the helper source: ${detail}`))
  }

  const encoded = Buffer.from(buildScript(call), 'utf16le').toString('base64')
  // The Windows command line caps at 32767 characters; spawn fails with
  // ENAMETOOLONG, which reads like a missing tool rather than a long argument.
  if (encoded.length > 30_000) {
    return Promise.reject(new Error(`the helper command line is too long (${encoded.length} characters)`))
  }

  return new Promise((resolve, reject) => {
    execFile(
      powershellExecutable(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
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

/** Resolve a `rect=x,y,width,height` query value, in virtual-screen pixels. */
function parseRect(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const parts = raw.split(',').map((value) => Number.parseInt(value, 10))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  const [x, y, width, height] = parts
  if (width < 2 || height < 2) return null
  return { x, y, width, height }
}

/** Split `<media>[;rect=x,y,w,h]\n<base64>` into its parts. */
function parseEnvelope(text) {
  const split = text.indexOf('\n')
  if (split === -1) throw new Error('the capture helper returned no image')
  const header = text.slice(0, split).trim()
  const base64 = text.slice(split + 1).replace(/\s+/g, '')
  const fields = header.split(';')
  const mediaType = fields[0].trim()
  let rect = null
  for (const field of fields.slice(1)) {
    if (field.startsWith('rect=')) rect = field.slice(5).trim()
  }
  return { mediaType, base64, rect }
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

    const notAllowed = (response) => sendJson(response, 405, { ok: false, error: 'method not allowed' })
    const allowed = (request) => request.method === 'GET' || request.method === 'HEAD'

    hostCtx.effect(() => {
      const disposers = []

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: MONITORS_PATH,
          handler(request, response) {
            if (!allowed(request)) {
              notAllowed(response)
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
            if (!allowed(request)) {
              notAllowed(response)
              return
            }

            let call
            let label
            let timeoutMs = CAPTURE_TIMEOUT_MS
            try {
              const url = new URL(String(request.url ?? ''), 'http://127.0.0.1')
              const rawTarget = url.searchParams.get('target')
              const rect = parseRect(url.searchParams.get('rect'))
              if (rect !== null) {
                // Repeat an exact rectangle: no selection layer, just the crop.
                label = `rect=${rect.x},${rect.y},${rect.width},${rect.height}`
                call = `[DshScreenshotButton]::CaptureRect(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height}, ${MAX_WIDTH}, ${MAX_BYTES})`
              } else if (rawTarget === 'region') {
                label = 'region'
                timeoutMs = REGION_TIMEOUT_MS
                call = `[DshScreenshotButton]::SelectRegion(${MAX_WIDTH}, ${MAX_BYTES})`
              } else {
                const target = parseTarget(rawTarget)
                label = `target=${target}`
                call = `[DshScreenshotButton]::Capture(${target}, ${MAX_WIDTH}, ${MAX_BYTES})`
              }
            } catch {
              label = 'target=-1'
              call = `[DshScreenshotButton]::Capture(-1, ${MAX_WIDTH}, ${MAX_BYTES})`
            }

            log(`capture request ${label}`)
            if (busy) {
              sendJson(response, 429, { ok: false, error: 'a capture is already running' })
              return
            }
            busy = true
            runHelper(call, timeoutMs)
              .then((text) => {
                if (text === 'cancel') {
                  log(`capture cancelled ${label}`)
                  sendJson(response, 200, { ok: true, cancelled: true, target: label })
                  return
                }
                const { mediaType, base64, rect } = parseEnvelope(text)
                log(`capture ok ${label} ${mediaType} ${base64.length} base64 chars${rect === null ? '' : ` rect=${rect}`}`)
                sendJson(response, 200, { ok: true, mediaType, base64, target: label, rect })
              })
              .catch((error) => {
                const message = String(error && error.message ? error.message : error)
                log(`capture failed ${label}: ${message}`)
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
