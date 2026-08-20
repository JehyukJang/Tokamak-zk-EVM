
// import { CircomConstMap, GlobalWireList, SetupParams, SubcircuitInfo } from './types.ts';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import { CircomConstMap, CircomKey, REQUIRED_CIRCOM_KEYS } from './types.ts';
import { parseCircomConstants } from '../parse-interfaces.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CIRCOM_PATH = path.resolve(__dirname, '../../subcircuits/circom/constants.circom')
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../subcircuits/library');

export async function loadCircomConstants(): Promise<CircomConstMap> {
  const src = await readFile(CIRCOM_PATH, 'utf8');
  const constants = parseCircomConstants(src, CIRCOM_PATH);
  const found: Partial<Record<CircomKey, number>> = {};

  for (const k of REQUIRED_CIRCOM_KEYS) {
    const value = constants.get(k);
    if (!Number.isFinite(value)) {
      throw new Error(`Missing circom constant: ${k}`);
    }
    found[k] = value;
  }

  return found as CircomConstMap;
}

const main = async () => {
  const circomConsts: CircomConstMap = await loadCircomConstants();
  const frontendConfig = JSON.stringify(circomConsts, null, 2);
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT_DIR;
  const cfgPath = path.join(outputDir, 'frontendCfg.json');
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(cfgPath, frontendConfig, 'utf-8');
    console.log(`Success in writing '${cfgPath}'.`);
  } catch (error) {
    throw new Error(`Failure in writing '${cfgPath}'.`);
  }

}

void main()
