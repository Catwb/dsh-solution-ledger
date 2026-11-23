/**
 * Trust fence for this plugin's HTTP routes.
 *
 * The routes register on the composition's `webServer`, which listens on
 * loopback. Every page open in the user's browser can reach that address, so
 * without a fence any of them could read the ledger and fire the write routes
 * with a CORS-simple POST. That was measured, not assumed: a `text/plain`
 * POST carrying `Origin: https://evil.example` reached the delete handler.
 *
 * The check itself belongs to DSH. `connection.requestRejection` applies the
 * Host/Origin fence — which defeats DNS rebinding and cross-site calls — and
 * then requires the login-token cookie. This module only decides what to do
 * with its answer, and keeps that decision testable outside a live server.
 */

/**
 * Build the fence for one composition.
 * @param connection - `ctx.get('connection')`, or undefined when the carrier is mounted without it.
 * @returns a function answering a refused request and reporting whether it did.
 */
export function createGuard(connection) {
  /**
   * @param req - the HTTP request.
   * @param res - the response to own when the request is refused.
   * @returns true when the request must not continue.
   */
  return function rejected(req, res) {
    if (connection === undefined) {
      // A Web carrier without Connection offers no trust check at all. Serving
      // nothing costs a broken panel; serving the ledger costs the user's data.
      refuse(res, 403, 'forbidden')
      return true
    }

    let rejection
    try {
      // The service accepts the request object directly: it reads `headers`.
      rejection = connection.requestRejection(req)
    } catch (error) {
      // A throwing check must not become an open door.
      console.log('solution-ledger: trust check threw, refusing:', String(error))
      rejection = 403
    }
    if (rejection === undefined) return false
    refuse(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }
}

/**
 * Write one refusal without leaking any ledger state.
 * @param res - the response to write.
 * @param status - 401 or 403.
 * @param body - plain-text reason.
 */
function refuse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
