export class LinkHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isLinkHttpError(error: unknown): error is LinkHttpError {
  return error instanceof LinkHttpError;
}
