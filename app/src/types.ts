export interface Expr {
  op: string;
  q?: number;
  q2?: number;
  v?: number | number[];
  args?: Expr[];
}

export interface Condition { type: "suppress" | "grayout" | "disable"; expr: Expr | null }

export interface Option {
  value: number;
  label: string;
  default?: boolean;
  default_mfg?: boolean;
  conditions?: Condition[];
}

export interface Item {
  kind: "subtitle" | "text" | "oneof" | "checkbox" | "numeric" | "string" | "password" | "ref" | "action" | "date" | "time" | "orderedlist" | "reset";
  prompt?: string;
  help?: string;
  form: string;
  question_id?: number;
  varstore?: string;
  varstore_key?: string;
  offset?: number;
  size?: number;
  flags?: string[];
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  display?: "dec" | "udec" | "hex";
  default?: number;
  default_mfg?: number;
  target?: string;
  text_two?: string;
  conditions?: Condition[];
  /** Real range/unit from the option's own help text (Gigabyte keeps a placeholder IFR range). */
  range_hint?: { min?: number; max?: number; unit?: string; scale?: number; source?: string };
  /** The menu data defines no real range: the BIOS GUI enforces limits we can't see. */
  range_unknown?: boolean;
  default_visibility?: "visible" | "hidden" | "uncertain";
  default_grayed?: boolean;
}

export interface Schema {
  schema_version: number;
  meta: Record<string, string | number>;
  formsets: Record<string, { guid: string; title: string; help: string; module: string; root_form: string | null }>;
  forms: Record<string, { title: string; formset: string; items: string[] }>;
  items: Record<string, Item>;
  roots: string[];
  driver_pages: string[];
}

export interface Profile {
  system?: Record<string, string>;
  varstore_defaults?: Record<string, number>;
  values?: Record<string, Record<string, number>>;
}

export type LayoutEntry =
  | { subtitle: string }
  | { inline_form: string; only?: string[]; heading?: string }
  | { pick: string[]; only: string[] }
  | { heading: string }
  | { ref: string; label?: string }
  | { page: string; forms: string[]; only?: string[] }
  | { action: string; label: string };

export interface Tab {
  id: string;
  title: string;
  icon: string;
  form?: string;
  entries?: LayoutEntry[];
  append?: LayoutEntry[];
}

export interface Layout {
  skin: string;
  tabs: Tab[];
  hotkeys: Record<string, string>;
  numeric_zero_means_auto?: boolean;
}

export type Row =
  | { type: "item"; iid: string }
  | { type: "subtitle"; text: string; iid?: string; accent?: boolean }
  | { type: "link"; label: string; page: string; iid?: string }
  | { type: "action"; label: string; action: string };

export interface Page { id: string; title: string; rows: Row[]; formKey?: string }

export interface Change {
  key: string;
  iid: string;
  path: string;
  prompt: string;
  from: string;
  to: string;
}
