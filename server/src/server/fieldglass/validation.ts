export class FieldglassError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 413 | 500 | 502 = 400) { super(message); }
}

export function object(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FieldglassError('Expected a JSON object');
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some((key) => !allowed.includes(key))) throw new FieldglassError('Unknown field');
  return result;
}

export function string(value: unknown, name: string, max = 500, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new FieldglassError(`Invalid ${name}`);
  }
  return value;
}

export function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new FieldglassError(`Invalid ${name}`);
  return value;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new FieldglassError(`Invalid ${name}`);
  return value as T;
}
