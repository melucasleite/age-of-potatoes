// A POST-JSON helper with an explicit, generous timeout — and a phase label on failure.
//
// This exists because of a specific, measured way to lose money (work item 049, measured in
// 048). Node's global `fetch` is undici, whose **default headers timeout is 300 seconds**.
// Retro Diffusion's observed generation latency is **134-309 seconds on every tier**,
// `rd_fast` included. So the cheap tier this project uses on every asset is already inside
// 10% of the default limit, and one slow afternoon turns `yarn art gen` into a run that
// throws `UND_ERR_HEADERS_TIMEOUT`.
//
// The expensive part is what happens next: **RD bills for the generation anyway.** One
// `rd_pro` call died that way during the spike and cost $0.18 for an image that was never
// received. There is no history, job or results endpoint (`/v1/history`, `/v1/jobs`,
// `/v1/results` are all 404) — the API is synchronous-only, so a dropped response is money
// gone permanently.
//
// Node does not expose undici's `Agent` publicly, so there is no supported way to raise
// that headers timeout on the global `fetch`. `node:https` is the dependency-free transport
// that *does* let us name our own timeout, and this file is that transport.
//
// The gotcha that comes with it, also from the spike: **a hand-rolled `node:https` client
// gets 403 Forbidden from RD's edge unless it sets a `User-Agent`.** undici sets one for
// free, which is exactly why swapping the transport is the moment this bites. Hence
// `USER_AGENT` below, which is not decoration.

import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';

/**
 * Fifteen minutes. Chosen as ~3x the worst latency ever measured (309s) rather than as a
 * round number: the only thing a *tight* timeout can buy here is a bill with no asset, so
 * the correct bias is to wait far too long rather than slightly too little. A genuinely
 * hung socket still fails, just late and for free.
 */
export const GENERATION_TIMEOUT_MS = 900_000;

/** `check_cost` requests generate nothing and answer immediately. No reason to wait long. */
export const QUOTE_TIMEOUT_MS = 60_000;

const USER_AGENT = 'snack-mogul-art-cli/0.1 (+node)';

/**
 * How far a request got before it died. The distinction is financial, not diagnostic:
 * nothing is billed until the provider has the request, so a failure at `connect` or
 * `send` is free and a failure at `await-response` may already have cost money.
 */
export type RequestPhase = 'connect' | 'send' | 'await-response' | 'read-body';

export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly phase: RequestPhase,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }

  /**
   * True once the request was fully handed to the provider. From that instant the
   * generation may have started and been charged, whatever happens to our socket.
   */
  get mayHaveBeenBilled(): boolean {
    return this.phase === 'await-response' || this.phase === 'read-body';
  }
}

export interface JsonResponse {
  status: number;
  body: string;
}

/**
 * POST a JSON string and read the whole response as text. Rejects with
 * `HttpTransportError` on any transport-level failure, including our own timeout; an HTTP
 * error status is *not* a transport failure and comes back as a normal resolved response
 * for the caller to interpret.
 */
export function postJson(
  url: string,
  payload: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<JsonResponse> {
  const target = new URL(url);
  const options: RequestOptions = {
    method: 'POST',
    hostname: target.hostname,
    port: target.port === '' ? 443 : Number(target.port),
    path: `${target.pathname}${target.search}`,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      // Not optional. RD's edge answers 403 without it. See the header comment.
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  };

  return new Promise<JsonResponse>((resolve, reject) => {
    let phase: RequestPhase = 'connect';
    let settled = false;

    const fail = (message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      reject(new HttpTransportError(message, phase, cause));
    };

    const req = httpsRequest(options, (res) => {
      phase = 'read-body';
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (error: Error) => fail(`response stream failed: ${error.message}`, error));
    });

    // Socket *inactivity*, which for this API is the whole generation: RD sends no bytes
    // at all until the image is ready, so this single number has to cover the full wait.
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`no response within ${Math.round(timeoutMs / 1000)}s (client-side timeout)`),
      );
    });

    // The body is flushed. Whatever happens now, the provider has the job.
    req.on('finish', () => {
      if (phase === 'connect') phase = 'await-response';
    });
    req.on('error', (error: Error) => fail(error.message, error));

    phase = 'send';
    req.end(payload);
  });
}
