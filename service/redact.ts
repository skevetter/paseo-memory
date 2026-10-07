const PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY_ID]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GITLAB_TOKEN]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|app[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
];

export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]");
}

export function redact(text: string): string {
  let out = stripPrivate(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
