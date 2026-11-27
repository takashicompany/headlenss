// Kept separate so api.ts and helpers.ts don't import each other.
export class ApiError extends Error {
  /** `unavailable`: this server doesn't have the route (a 404, or an older server answering /api/* with its index.html). */
  constructor(public status: number, message: string, public unavailable = false) {
    super(message);
  }
}
