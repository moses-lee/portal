/** Errors that know their HTTP status, as the ported route handlers and stores throw them. */
export type StatusError = Error & { status: number };

export function httpError(message: string, status: number): StatusError {
  return Object.assign(new Error(message), { status });
}

export function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
