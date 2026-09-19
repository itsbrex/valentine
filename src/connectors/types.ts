// The CRM connector contract. The agent and triggers depend ONLY on this —
// never on a specific CRM. Adding a CRM (e.g. HubSpot) = one new file
// implementing this interface, zero changes elsewhere.
//
// Note: there are NO mutating methods here, by design. Valentine is read-only,
// enforced by the absence of any write capability in the contract itself.
// `webUrls` builds links to the CRM's own web app (record tabs, search, a
// prefilled new-record form) — pure string construction, no I/O, and nothing
// is written until a human submits the form in their browser.

export interface CRMMatch {
  recordId: string;
  object: "companies" | "people";
  /** The CRM's own record type when it matters — "Lead" for a Salesforce Lead
   *  (a person + company in one record, not yet a Contact). */
  recordType?: string;
  name?: string;
  domain?: string;
  /** Relationship owner (resolved member name), if any. */
  owner?: string;
  /** Owner's id in the CRM (SF User id, Attio workspace-member id). */
  ownerId?: string;
  /** Deep link to the owner's record, when the CRM has one (SF User). */
  ownerUrl?: string;
  /** False when the CRM says the owner is deactivated / a placeholder. */
  ownerActive?: boolean;
  /** e.g. "Very strong". */
  connectionStrength?: string;
  /** YYYY-MM-DD of the most recent logged email, if any. */
  lastEmail?: string;
  /** YYYY-MM-DD of the most recent logged meeting, if any. */
  lastMeeting?: string;
  /** "<type> · YYYY-MM-DD" of the single most recent interaction. */
  lastInteraction?: string;
  /** YYYY-MM-DD of the first-ever logged interaction. */
  firstInteraction?: string;
  /** Number of linked people/contacts. */
  linkedPeople?: number;
  /** Deep link to the record in the CRM's web app, when the API exposes one. */
  url?: string;
  /** The record this one hangs off (a Contact's Account, a person's company). */
  parent?: RecordLink & { id: string };
  /** Deep links to the record's tabs / related lists, when the web app has them. */
  views?: RecordViews;
}

/** Tabs of a record in the CRM's web app. Every field optional — a CRM
 *  without a tab simply leaves it out and the surfaces fall back to `url`. */
export interface RecordViews {
  /** Activity timeline / Activity History related list. */
  activity?: string;
  /** Logged emails. */
  emails?: string;
  /** Linked people / Contacts related list. */
  people?: string;
}

export interface SearchQuery {
  object: "companies" | "people";
  domain?: string;
  name?: string;
}

/** One logged activity on a record — a Task, Event, email or meeting. */
export interface Activity {
  id?: string;
  /** YYYY-MM-DD. */
  date?: string;
  /** "task" | "event" | "email" | "call" | "meeting" … as the CRM labels it. */
  kind: string;
  subject?: string;
  url?: string;
  /** Who it is assigned to (an upcoming task's owner). */
  owner?: string;
  /** Open activities only: "Not Started", "In Progress"… */
  status?: string;
}

/** A list / pipeline / campaign membership. */
export interface ListMembership {
  list: string;
  stage?: string;
  /** What the "list" is in this CRM — drives the label and the verdict pill. */
  kind?: "list" | "opportunity" | "campaign";
  /** Deep link to the list / opportunity / campaign. */
  url?: string;
  /** Deep link to the membership record itself (SF CampaignMember). */
  memberUrl?: string;
  /** Opportunity only: false once closed (won or lost). */
  open?: boolean;
  id?: string;
  /** Opportunity only: deal size, close date, owner, and any deal-shape
   *  detail the org's custom fields carry ("45,000 SF · Office · 60 mo"). */
  amount?: number;
  closeDate?: string;
  owner?: string;
  detail?: string;
}

/** Everything else attached to a record — the "look across as much as possible" sweep. */
export interface CRMContext {
  /** Note bodies (where "passed, too early" lives). */
  notes: string[];
  /** List memberships, e.g. { list: "Passed" } or { list: "Pipeline", stage: "In DD" }. */
  lists: ListMembership[];
  /** Names of linked people / contacts. */
  people: string[];
  /** The same people with deep links, when the CRM gives record ids. */
  peopleLinks?: RecordLink[];
  /** Most recent logged activities, newest first. */
  activities?: Activity[];
  /** Scheduled / open activities, soonest first — someone is already on it. */
  upcoming?: Activity[];
}

/** Prefill for a new-record form. Only what the CRM can take on its URL. */
export interface CreatePrefill {
  domain?: string;
  name?: string;
  /** Person to attach (Lead / Contact), "First Last". */
  person?: string;
  /** Free text carried into a description/notes field — e.g. the other CRM's record id. */
  note?: string;
}

/** Pure URL builders into the CRM's web app. No I/O; nothing is written by
 *  following them — a form still needs a human to press Save. */
export interface WebUrls {
  /** The CRM's search page for a term, when it has one. */
  search?(term: string): string | undefined;
  /** A prefilled new-record form: a company/account, a lead, or an activity on a record. */
  create?(kind: "company" | "lead" | "call" | "task" | "meeting", prefill: CreatePrefill & { recordId?: string; subject?: string }): string | undefined;
}

export interface CRMConnector {
  /** Display name, e.g. "Attio". */
  readonly name: string;
  /** Verify credentials; return the workspace identity. */
  whoami(): Promise<{ workspace: string }>;
  /** Read-only search for a company or person, with interaction signals. */
  search(query: SearchQuery): Promise<CRMMatch[]>;
  /** Pull notes, list memberships, and linked people for a record. */
  getContext(object: "companies" | "people", recordId: string): Promise<CRMContext>;
  /** Links into the web app. Optional; pure. */
  readonly webUrls?: WebUrls;
}

// --- The verdict: the one thing every run resolves to. ---

export type VerdictKind = "prior_contact" | "clean" | "ambiguous";

export interface Verdict {
  verdict: VerdictKind;
  /** One line a partner reads and acts on. */
  summary: string;
  /** One suggested next step ("Valentine says"), model-written and grounded
   *  the same way as `summary`, else a template line. */
  nextStep?: string;
  owner?: string;
  lastTouch?: string;
  /** Outcome pulled from notes, e.g. "passed, too early". */
  status?: string;
  /** Record IDs the verdict is based on. */
  citations: string[];
  /** Structured evidence behind the verdict — what the rich surfaces (Slack
   *  Block Kit, CLI, --json) render as fields and click-through links. */
  facts?: BriefFacts;
  /** Wall time of this source's sweep, ms. */
  elapsedMs?: number;
}

/** A click-to-act link: the CRM record, the company site, a LinkedIn search. */
export interface RecordLink {
  label: string;
  url: string;
}

/** Everything a deterministic sweep found, laid out for rendering. Every
 *  field is a fact read from the CRM — nothing here comes from a model. */
export interface BriefFacts {
  /** Name of the record the verdict rests on. */
  matchName?: string;
  /** Deep link to that record. */
  matchUrl?: string;
  /** "companies" | "people" — what kind of record the match is. */
  matchObject?: "companies" | "people";
  /** The match's parent record (a Contact's Account). */
  parent?: RecordLink;
  domain?: string;
  /** How many records matched the target. */
  matches: number;
  ownerUrl?: string;
  /** False when the owner is deactivated / an "Unassigned" placeholder. */
  ownerActive?: boolean;
  connectionStrength?: string;
  firstInteraction?: string;
  lastEmail?: string;
  lastMeeting?: string;
  /** Deep link for the last touch (the Task/Event, or the activity tab). */
  lastTouchUrl?: string;
  /** Age of the last touch as of the sweep: "9y 3m", "5mo", "78d", "2d". */
  stale?: string;
  /** Record tabs in the web app. */
  views?: RecordViews;
  /** Linked people already in the CRM (display names, cleaned). */
  people: string[];
  /** The same people with deep links, when available. */
  peopleLinks?: RecordLink[];
  /** List / pipeline / campaign memberships with stage. */
  lists: ListMembership[];
  /** The open opportunity the verdict keys on, when the CRM has pipeline objects. */
  opportunity?: ListMembership;
  /** Most recent logged activities, newest first. */
  activities?: Activity[];
  /** The soonest scheduled activity on the record, if any — a colleague is
   *  already on it; the card and next step say so. */
  nextActivity?: Activity;
  /** Most recent note bodies, trimmed. */
  notes: string[];
  /** Click-to-act: the record, the company site, a LinkedIn search. */
  links: RecordLink[];
  /** Read-only "act" links: prefilled new-record forms in the CRM (Log call,
   *  New task, + Lead…). Following one opens a form; nothing is saved by Valentine. */
  actions?: RecordLink[];
  /** The CRM's search page for the target, when it has one. */
  searchUrl?: string;
}
