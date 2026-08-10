// macOS Calendar source — reads EventKit via JXA (osascript), so every account
// the Calendar app syncs is visible with zero extra auth: iCloud, Google, and
// notably Outlook/Microsoft 365 added under System Settings → Internet
// Accounts → Microsoft Exchange. That last one is the cheap workaround for
// Outlook calendars when you can't get Graph API admin consent — if the Mac
// Calendar app shows the meeting, Valentine sees it.
//
// First run triggers the macOS calendar-access prompt (grant it to the app
// that launched the process: Terminal, iTerm, etc.). Read-only: EventKit is
// only ever queried, never written.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CalendarSource, Meeting } from "./types.js";

const run = promisify(execFile);

// JXA, executed by `osascript -l JavaScript`. Prints a JSON Meeting[] to
// stdout. Handles both the macOS 14+ full-access request and the older API.
const JXA = String.raw`
ObjC.import('EventKit');
ObjC.import('Foundation');
function run(argv) {
  var minutes = parseInt(argv[0] || '60', 10);
  var store = $.EKEventStore.alloc.init;
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  if (status === 0) {
    var done = false;
    var cb = function () { done = true; };
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) {
      store.requestFullAccessToEventsWithCompletion(cb);
    } else {
      store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, cb);
    }
    var until = Date.now() + 20000;
    while (!done && Date.now() < until) {
      $.NSRunLoop.currentRunLoop.runModeBeforeDate(
        $.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.1));
    }
    status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  }
  if (status !== 3 && status !== 4) {
    return JSON.stringify({ error: 'calendar-access-denied' });
  }
  var start = $.NSDate.date;
  var end = $.NSDate.dateWithTimeIntervalSinceNow(minutes * 60);
  var pred = store.predicateForEventsWithStartDateEndDateCalendars(start, end, $());
  var events = store.eventsMatchingPredicate(pred);
  var out = [];
  for (var i = 0; i < events.count; i++) {
    var e = events.objectAtIndex(i);
    if (e.isAllDay) continue;
    var atts = [];
    if (!e.attendees.isNil()) {
      for (var j = 0; j < e.attendees.count; j++) {
        var a = e.attendees.objectAtIndex(j);
        var email;
        if (!a.URL.isNil()) {
          var spec = ObjC.unwrap(a.URL.resourceSpecifier) || '';
          if (spec.indexOf('@') !== -1) email = spec.replace(/^\/*/, '');
        }
        atts.push({
          email: email,
          name: a.name.isNil() ? undefined : ObjC.unwrap(a.name),
          self: a.isCurrentUser ? true : false,
        });
      }
    }
    out.push({
      id: ObjC.unwrap(e.eventIdentifier),
      title: e.title.isNil() ? '(untitled)' : ObjC.unwrap(e.title),
      start: Math.round(e.startDate.timeIntervalSince1970 * 1000),
      calendar: e.calendar.isNil() ? undefined : ObjC.unwrap(e.calendar.title),
      attendees: atts,
    });
  }
  return JSON.stringify(out);
}
`;

export class MacosCalendarSource implements CalendarSource {
  readonly name = "macOS Calendar";

  async upcoming(withinMinutes: number): Promise<Meeting[]> {
    const { stdout } = await run(
      "osascript",
      ["-l", "JavaScript", "-e", JXA, String(withinMinutes)],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error(
        parsed?.error === "calendar-access-denied"
          ? "Calendar access denied. Grant it in System Settings → Privacy & Security → Calendars " +
            "(to the app that runs valentine: Terminal, iTerm…), then retry."
          : `macOS Calendar returned: ${JSON.stringify(parsed).slice(0, 120)}`,
      );
    }
    return parsed as Meeting[];
  }
}
