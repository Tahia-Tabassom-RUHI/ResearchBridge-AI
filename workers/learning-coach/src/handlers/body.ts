import { BODY_TIMEOUT_MS, MAX_REQUEST_BYTES } from "../config/index";
import { HttpError } from "../errors/index";

export async function readJson(request: Request, timeoutMs = BODY_TIMEOUT_MS): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) throw new HttpError(415, "invalid_request", "Use application/json with UTF-8 encoding.");
  if (request.headers.has("Content-Encoding")) throw new HttpError(415, "invalid_request", "Encoded request bodies are not supported.");
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new HttpError(413, "invalid_request", "The request body is too large.");
  if (!request.body) throw new HttpError(400, "invalid_request", "A JSON request body is required.");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HttpError(408, "invalid_request", "The request body timed out.")), timeoutMs); });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "invalid_request", "The request body is too large.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request", "The request body must be valid UTF-8 JSON.");
  } finally { clearTimeout(timer); }
}
