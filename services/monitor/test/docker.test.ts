import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crearClienteDocker } from '../src/docker.ts';

describe('crearClienteDocker', () => {
  const cierres: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cierres.length > 0) {
      await cierres.pop()?.();
    }
  });

  it('rechaza limpiamente sin matar el proceso si Docker devuelve JSON truncado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monitor-docker-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\trotamundos-docker-${Date.now()}-${Math.random().toString(16).slice(2)}`
        : join(dir, 'docker.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"truncado":');
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cierres.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            rmSync(dir, { recursive: true, force: true });
            resolve();
          });
        }),
    );

    const cliente = crearClienteDocker({ socket: socketPath, proyecto: 'r1' });
    await expect(cliente.listar()).rejects.toThrow();
  });
});
