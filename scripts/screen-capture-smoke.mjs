import { captureScreen, listVisibleWindows } from "../dist/screenCapture.js";

if (process.platform !== "win32") {
  console.log("screen capture smoke skipped: Windows only");
  process.exit(0);
}

const windows = await listVisibleWindows({ limit: 20, includeMinimized: true });
if (!Array.isArray(windows)) throw new Error("listVisibleWindows did not return an array");
const singleWindow = await listVisibleWindows({ limit: 1, includeMinimized: true });
if (!Array.isArray(singleWindow) || singleWindow.length > 1) throw new Error("single-window list result is not an array");
const capture = await captureScreen({ mode: "full", maxWidth: 640, maxHeight: 480 });
if (capture.png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("captureScreen did not return PNG data");
if (capture.metadata.width > 640 || capture.metadata.height > 480) throw new Error("capture exceeds requested bounds");
console.log(JSON.stringify({ ok: true, visibleWindows: windows.length, capture: capture.metadata, pngBytes: capture.png.length }));
