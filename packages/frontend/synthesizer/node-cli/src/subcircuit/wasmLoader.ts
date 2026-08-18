import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export function resolveSubcircuitLibraryDirectory(): string {
  if (typeof window !== "undefined") {
    throw new Error("resolveSubcircuitLibraryDirectory must run on the server");
  }

  const workspaceQapCompilerRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../qap-compiler',
  );
  if (existsSync(workspaceQapCompilerRoot)) {
    return path.join(workspaceQapCompilerRoot, 'subcircuits', 'library');
  }

  const subcircuitLibraryRoot = path.dirname(
    typeof require === 'function' && typeof require.resolve === 'function'
      ? require.resolve('@tokamak-zk-evm/subcircuit-library/package.json')
      : fileURLToPath(import.meta.resolve('@tokamak-zk-evm/subcircuit-library/package.json')),
  );

  const isBun = Reflect.get(process, 'isBun');
  if (isBun === true && process.execPath) {
    const execDir = path.dirname(process.execPath);
    return path.resolve(execDir, '../resource/qap-compiler', 'subcircuits', 'library');
  }

  return path.join(subcircuitLibraryRoot, 'subcircuits', 'library');
}

// Derived path for WASM artifacts (filesystem path)
export const wasmDir = path.join(resolveSubcircuitLibraryDirectory(), 'wasm');

export async function loadSubcircuitWasmBuffer(subcircuitId: number): Promise<ArrayBuffer> {
  const targetWasmPath = path.resolve(wasmDir, `subcircuit${subcircuitId}.wasm`);
  let buffer: Buffer;
  try {
    buffer = readFileSync(targetWasmPath);
  } catch {
    throw new Error(`Error while reading subcircuit${subcircuitId}.wasm`);
  }
  return Uint8Array.from(buffer).buffer;
}
