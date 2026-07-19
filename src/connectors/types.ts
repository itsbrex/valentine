// The CRM connector contract. The agent and triggers depend ONLY on this —
// never on a specific CRM. Adding a CRM (e.g. HubSpot) = one new file
// implementing this interface, zero changes elsewhere.
//
// Note: there are NO mutating methods here, by design. Valentine is read-only,
// enforced by the absence of any write capability in the contract itself.

export interface CRMMatch {
  recordId: string;
  object: "companies" | "people";
  name?: string;
  domain?: string;
  /** Relationship owner (resolved member name), if any. */
  owner?: string;
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
}

export interface SearchQuery {
  object: "companies" | "people";
  domain?: string;
  name?: string;
}

/** Everything else attached to a record — the "look across as much as possible" sweep. */
export interface CRMContext {
  /** Note bodies (where "passed, too early" lives). */
  notes: string[];
  /** List memberships, e.g. { list: "Passed" } or { list: "Pipeline", stage: "In DD" }. */
  lists: { list: string; stage?: string }[];
  /** Names of linked people / contacts. */
  people: string[];
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
}

// --- The verdict: the one thing every run resolves to. ---

export type VerdictKind = "prior_contact" | "clean" | "ambiguous";

export interface Verdict {
  verdict: VerdictKind;
  /** One line a partner reads and acts on. */
  summary: string;
  owner?: string;
  lastTouch?: string;
  /** Outcome pulled from notes, e.g. "passed, too early". */
  status?: string;
  /** Record IDs the verdict is based on. */
  citations: string[];
}
