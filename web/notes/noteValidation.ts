import { ISSUE_TYPES } from "../graphModel.ts";
import type { ParsedNote } from "./noteParser.ts";

export interface GraphValidationIssue {
  type?: string;
  path?: string | null;
  paths?: string[] | null;
  message?: string;
  [key: string]: unknown;
}

export interface GraphValidationIndex {
  validation?: GraphValidationIssue[];
}

export type NoteValidationIssueType = "frontmatter" | "parent" | "duplicate";

export interface NoteValidationIssue {
  type: NoteValidationIssueType;
  note: ParsedNote | null;
  message: string;
  graphIssue?: GraphValidationIssue;
}

export function validateNotes(
  notes: ParsedNote[],
  graphIndex: GraphValidationIndex | null | undefined,
  byPath: Map<string, ParsedNote> = new Map()
): NoteValidationIssue[] {
  const issues: NoteValidationIssue[] = [];

  for (const note of notes) {
    if (!note.hasFrontmatter) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing frontmatter` });
    }

    if (!note.hasTitle) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing a title` });
    }

    if (!note.hasParent) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing a parent` });
    }
  }

  if (graphIndex?.validation) {
    for (const issue of graphIndex.validation) {
      issues.push(graphIssueToValidation(issue, byPath));
    }
  }

  return issues;
}

export function graphIssueToValidation(
  issue: GraphValidationIssue,
  byPath: Map<string, ParsedNote>
): NoteValidationIssue {
  const path = issue.path || (Array.isArray(issue.paths) ? issue.paths[0] : null);
  const note = path ? byPath.get(path) || null : null;
  const type: NoteValidationIssueType = issue.type === ISSUE_TYPES.DUPLICATE_ALIAS ? "duplicate" : "parent";

  return {
    type,
    note,
    graphIssue: issue,
    message: issue.message || "Hierarchy issue"
  };
}
