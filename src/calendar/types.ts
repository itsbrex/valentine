// The calendar source contract — provider-agnostic, like the CRM connector.
// The watch loop depends ONLY on this. Adding a source (Google API, .ics,
// CalDAV) = one new file implementing it, zero changes elsewhere.
//
// Read-only by design: no method here can create, modify, or respond to
// events. Valentine never writes to the calendar (or the CRM).

export interface Attendee {
  email?: string;
  name?: string;
  /** True when this attendee is the calendar's owner (you). */
  self?: boolean;
}

export interface Meeting {
  /** Stable identifier, used to notify once per meeting. */
  id: string;
  title: string;
  /** Epoch milliseconds. */
  start: number;
  calendar?: string;
  attendees: Attendee[];
}

export interface CalendarSource {
  /** Display name, e.g. "macOS Calendar". */
  readonly name: string;
  /** Events starting within the next `withinMinutes`, with attendees. */
  upcoming(withinMinutes: number): Promise<Meeting[]>;
}
