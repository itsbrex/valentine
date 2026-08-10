// Notification channels for `valentine watch`. Three ways to get the verdict
// in front of you, all local:
//   macos      — standard banner. Uses terminal-notifier (with the Valentine
//                heart icon) when installed, else osascript display notification.
//   fullscreen — an unmissable InYourFace-style takeover: a magenta window at
//                screen size for a few seconds. For people who ignore banners.
//   stdout     — plain lines, for pipes/tmux/logs. Works on any OS.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

export type NotifyChannel = "macos" | "fullscreen" | "stdout";

const ICON = fileURLToPath(new URL("../assets/valentine.png", import.meta.url));

// JXA: borderless window at screen size, Valentine magenta, auto-dismisses.
const FULLSCREEN_JXA = String.raw`
ObjC.import('Cocoa');
function run(argv) {
  var title = argv[0] || 'Valentine';
  var body = argv[1] || '';
  var seconds = parseFloat(argv[2] || '12');
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var frame = $.NSScreen.mainScreen.frame;
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(224/255, 36/255, 94/255, 1));
  win.setLevel($.NSStatusWindowLevel);
  var w = frame.size.width, h = frame.size.height;
  var label = function (text, size, weight, y, hh) {
    var l = $.NSTextField.alloc.initWithFrame($.NSMakeRect(w * 0.08, y, w * 0.84, hh));
    l.setStringValue(text);
    l.setBezeled(false); l.setDrawsBackground(false); l.setEditable(false); l.setSelectable(false);
    l.setFont($.NSFont.systemFontOfSizeWeight(size, weight));
    l.setTextColor($.NSColor.whiteColor);
    l.cell.setLineBreakMode(0); // word wrap
    win.contentView.addSubview(l);
  };
  label('✦ ' + title, 64, 0.4, h * 0.55, 100);
  label(body, 30, 0.0, h * 0.18, h * 0.34);
  win.makeKeyAndOrderFront($());
  app.activateIgnoringOtherApps(true);
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
}
`;

async function banner(title: string, body: string): Promise<void> {
  try {
    // terminal-notifier: proper banner with our icon (brew install terminal-notifier)
    await run("terminal-notifier", ["-title", title, "-message", body, "-appIcon", ICON]);
  } catch {
    // Fallback: AppleScript notification (default icon). argv passing — no escaping.
    await run("osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      title, body,
    ]);
  }
}

async function fullscreen(title: string, body: string): Promise<void> {
  await run("osascript", ["-l", "JavaScript", "-e", FULLSCREEN_JXA, title, body, "12"]);
}

export async function notify(channel: NotifyChannel, title: string, body: string): Promise<void> {
  if (channel === "stdout" || process.platform !== "darwin") {
    console.log(`✦ ${title}\n${body.replace(/^/gm, "  ")}`);
    return;
  }
  if (channel === "fullscreen") return fullscreen(title, body);
  return banner(title, body);
}
