export type JobErrorKind = 'cli' | 'parse' | 'validation' | 'timeout' | 'auth' | 'unavailable' | 'storage';

/** Excerpts are diagnostics, never full stderr/commands. Redact before truncating
 * so a token crossing the excerpt boundary cannot leak its prefix. */
export function diagnosticExcerpt(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/authorization\s*:[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted credential]')
    .replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\bsk[-_][A-Za-z0-9_-]+/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/)[^\s]+/g, '[redacted path]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export class JobError extends Error {
  readonly stderr: string;
  constructor(public kind: JobErrorKind, public detail: string, stderr?: unknown) {
    const excerpt = diagnosticExcerpt(stderr);
    super(`[${kind}] ${detail}${excerpt ? ` Stderr: ${excerpt}` : ''}`);
    this.stderr = excerpt;
  }
}

export function commandError(error: unknown): JobError {
  if (error instanceof JobError) return error;
  const info = error as { code?: unknown; stderr?: unknown } | null;
  const code = typeof info?.code === 'number' ? String(info.code)
    : typeof info?.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(info.code) ? info.code : undefined;
  const detail = code === 'ENOENT' ? 'Claude executable was not found on PATH (ENOENT).'
    : code ? `Claude CLI failed (exit ${code}).` : 'Claude background command failed.';
  // Error.message from execFile can contain the entire command and prompt.
  return new JobError('cli', detail, info?.stderr);
}
