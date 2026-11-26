export class PublicError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
  }
}
