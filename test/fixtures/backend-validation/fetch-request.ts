// An HTTP client wrapping its own outgoing Fetch API `Request`: `request.body`
// is the raw byte stream it is about to send, not client input to a server.
declare const withProgress: (body: ReadableStream, onProgress: () => void) => ReadableStream;

// not flagged: global Fetch `Request` parameter
export const streamRequest = (request: Request, onProgress: () => void): Request => {
  if (!request.body) {
    return request;
  }
  return new Request(request, {body: withProgress(request.body, onProgress)});
};

export class Client {
  // not flagged: `globalThis.Request | undefined` is the same global type
  wrap(request: globalThis.Request | undefined): ReadableStream | null {
    return request === undefined ? null : request.body;
  }
}
