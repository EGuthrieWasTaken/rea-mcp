import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface IdleProxy {
  readonly port: number;
  /** Connections the proxy cut because nothing flowed for the idle limit. */
  cuts(): number;
  /** Bytes received from the gateway so far. */
  bytesFromUpstream(): number;
  close(): Promise<void>;
}

/**
 * A stand-in for a reverse proxy or tunnel in front of the gateway, which drops a
 * connection that has carried no bytes, in either direction, for `idleMs` (a real one
 * does this to an origin response at about 100 s). It forwards bytes unchanged.
 */
export const startIdleProxy = async (upstreamPort: number, idleMs: number): Promise<IdleProxy> => {
  let cuts = 0;
  let bytes = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    let last = Date.now();
    const finish = (): void => {
      clearInterval(timer);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    const timer = setInterval(() => {
      if (Date.now() - last > idleMs) {
        cuts += 1;
        finish();
      }
    }, 25);
    upstream.on("data", (chunk: Buffer) => {
      last = Date.now();
      bytes += chunk.length;
      client.write(chunk);
    });
    client.on("data", (chunk: Buffer) => {
      last = Date.now();
      upstream.write(chunk);
    });
    for (const socket of [client, upstream]) {
      socket.on("error", finish);
      socket.on("close", finish);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    cuts: () => cuts,
    bytesFromUpstream: () => bytes,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
