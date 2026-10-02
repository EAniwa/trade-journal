export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new ApiError(status, message);
}
