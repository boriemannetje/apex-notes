export type WorkspaceDeepLink =
  | { action: "open"; rootPath: string }
  | { action: "sync"; connectionId: string };

// A link selects an existing local destination or locally trusted connection.
// It never carries file content, a remote endpoint, or authentication material.
export function parseWorkspaceDeepLink(value: string): WorkspaceDeepLink {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value) || /%(?![0-9a-f]{2})/i.test(value)) {
    throw new Error("Invalid Apex Notes link");
  }
  const url = new URL(value);
  if (url.protocol !== "apex-notes:" || url.username || url.password || url.port || url.hash || url.pathname || value.includes("#")) {
    throw new Error("Invalid Apex Notes link");
  }
  const entries = [...url.searchParams];
  if (entries.length !== 1) throw new Error("Invalid Apex Notes link parameters");
  const [key, argument] = entries[0];
  if (/[\u0000-\u001f\u007f\ufffd]/.test(argument)) throw new Error("Invalid Apex Notes link argument");
  if (url.hostname === "sync" && key === "connection" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(argument)) {
    return { action: "sync", connectionId: argument };
  }
  if (url.hostname === "open" && key === "path" && argument.startsWith("/") && !argument.startsWith("//") && !argument.includes("\\")) {
    const parts = argument.split("/");
    if (argument === "/" || parts.slice(1).some((part) => !part || part === "." || part === "..")) throw new Error("Invalid workspace path");
    return { action: "open", rootPath: argument };
  }
  throw new Error("Unsupported Apex Notes link");
}
