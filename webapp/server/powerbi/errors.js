export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message)
    this.status = status
    this.detail = detail
  }
}
