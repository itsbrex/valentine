// The OPT-IN write contract. Deliberately a separate interface from
// CRMConnector: the read path stays structurally read-only (no mutating
// method exists on it), and nothing here is reachable unless writes are
// switched on (config `writes: true` / VALENTINE_WRITES=1). The only caller is
// the Slack interactivity endpoint (`valentine slack`), and every write there
// sits behind a Block Kit confirm dialog that spells out what gets written.
//
// Every method writes ONE thing a human just asked for — a record, an owner,
// a note, a logged touch, a cross-link — and returns where it landed. There
// is no bulk path and no delete.

export interface WriteResult {
  /** Id of the record written (created or updated). */
  id: string;
  /** Deep link to it, when the CRM has one. */
  url?: string;
  /** Human line for the Slack reply: "Company Acme created in Attio". */
  label: string;
}

export type RecordObject = "companies" | "people";

/** Where a record in the OTHER CRM lives — carried into notes / descriptions
 *  so the two systems point at each other. */
export interface CrossRef {
  crm: string;
  id: string;
  url?: string;
}

export interface CompanyDraft {
  name: string;
  domain?: string;
  /** Owner id in this CRM (SF User id / Attio workspace-member id); defaults to the caller. */
  ownerId?: string;
  /** Free text — where the record came from (the other CRM's link, "Valentine"). */
  note?: string;
}

export interface PersonDraft {
  name: string;
  email?: string;
  /** Company / Account to attach to. */
  companyId?: string;
  ownerId?: string;
  note?: string;
}

export interface ActivityDraft {
  kind: "call" | "meeting" | "note";
  subject: string;
  /** ISO date or datetime. Defaults to now. */
  at?: string;
  /** Body / description. */
  note?: string;
}

export interface CRMWriter {
  readonly name: string;
  /** The user the write token belongs to — the default owner for "claim". */
  whoami(): Promise<{ id: string; name?: string }>;
  createCompany(draft: CompanyDraft): Promise<WriteResult>;
  createPerson(draft: PersonDraft): Promise<WriteResult>;
  /** Salesforce only: a Lead (company + person in one record). */
  createLead?(draft: CompanyDraft & { person?: string; email?: string }): Promise<WriteResult>;
  /** Set the record's owner to `ownerId`, or to the caller when omitted. */
  claimOwner(object: RecordObject, recordId: string, ownerId?: string): Promise<WriteResult>;
  addNote(object: RecordObject, recordId: string, text: string): Promise<WriteResult>;
  /** Log a completed touch (call / meeting) or a note on the record. */
  logActivity(object: RecordObject, recordId: string, a: ActivityDraft): Promise<WriteResult>;
  /** Write the other CRM's id/link onto this record so the two stay linked. */
  crosslink(object: RecordObject, recordId: string, other: CrossRef): Promise<WriteResult>;
  /** Attio only: the record that owns `domain` is the wrong company — move
   *  the domain to a new record named `right.name`, leave a note on both. */
  rematch?(domain: string, wrongRecordId: string, right: { name: string; note?: string }): Promise<WriteResult>;
}
