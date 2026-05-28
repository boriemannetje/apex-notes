import { ISSUE_TYPES } from "../graphModel.ts";

export function validateNotes(notes, graphIndex, byPath) {
  const issues = [];

  for (const note of notes) {
    if (!note.hasFrontmatter) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing frontmatter` });
    }

    if (!note.hasTitle) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing a title` });
    }

  }

  if (graphIndex) {
    for (const issue of graphIndex.validation) {
      issues.push(graphIssueToValidation(issue, byPath));
    }
  }

  return issues;
}

export function graphIssueToValidation(issue, byPath) {
  const path = issue.path || (Array.isArray(issue.paths) ? issue.paths[0] : null);
  const note = path ? byPath.get(path) || null : null;
  let type = "parent";

  if (issue.type === ISSUE_TYPES.DUPLICATE_ALIAS) {
    type = "duplicate";
  }

  return {
    type,
    note,
    graphIssue: issue,
    message: issue.message || "Hierarchy issue"
  };
}
