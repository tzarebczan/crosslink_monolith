/**
 * Tiny JSON-RPC client for zebrad. Plain Node fetch + AbortSignal.timeout.
 * We don't use a heavyweight client because zebrad has only a handful of
 * methods we care about and we want predictable timeouts.
 */
export class RpcError extends Error {
  public readonly method: string;
  public override readonly cause?: unknown;

  constructor(message: string, method: string, cause?: unknown) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.cause = cause;
  }
}

export interface RpcOpts {
  /** abort signal for cancelling the request from the caller side */
  signal?: AbortSignal;
  /** override default timeout (ms) */
  timeoutMs?: number;
}

export class RpcClient {
  constructor(
    private url: string,
    private defaultTimeoutMs = 30_000,
  ) {}

  setUrl(url: string): void {
    this.url = url;
  }

  async call<T = unknown>(
    method: string,
    params: unknown[] = [],
    opts: RpcOpts = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => ac.abort(opts.signal?.reason));
    }

    let raw: string;
    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: ac.signal,
      });
      raw = await resp.text();
    } catch (e: unknown) {
      const reason =
        e instanceof Error
          ? e.name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : e.message
          : String(e);
      throw new RpcError(`${method}: ${reason}`, method, e);
    } finally {
      clearTimeout(timer);
    }

    let data: { result?: unknown; error?: unknown } = {};
    try {
      data = JSON.parse(raw);
    } catch (e: unknown) {
      throw new RpcError(
        `${method}: non-json response: ${raw.slice(0, 120)}`,
        method,
        e,
      );
    }
    if (data.error) {
      const msg =
        typeof data.error === "object" && data.error
          ? (data.error as { message?: string }).message ?? JSON.stringify(data.error)
          : String(data.error);
      throw new RpcError(`${method}: ${msg}`, method);
    }
    return data.result as T;
  }
}
