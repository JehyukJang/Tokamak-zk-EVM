import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCircomConstants } from './runtime/logical-interface.js';

const REQUIRED_CIRCOM_KEYS = [
  'nTxIn',
  'nStorageLoad',
  'nLogOut',
  'nStorageStore',
  'nBlockIn',
  'nEVMIn',
  'nPrvIn',
  'nPrivateMessageInputs',
  'nPoseidonInputs',
  'nPoseidonBatch',
  'nPrevBlockHashes',
] as const;

type CircomKey = typeof REQUIRED_CIRCOM_KEYS[number];
type FrontendConfig = Record<CircomKey, number>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CIRCOM_PATH = path.resolve(__dirname, '../subcircuits/circom/constants.circom');
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../subcircuits/library');

async function loadFrontendConfig(): Promise<FrontendConfig> {
  const source = await readFile(CIRCOM_PATH, 'utf8');
  const constants = parseCircomConstants(source, CIRCOM_PATH);
  const config: Partial<FrontendConfig> = {};

  for (const key of REQUIRED_CIRCOM_KEYS) {
    const value = constants.get(key);
    if (!Number.isFinite(value)) {
      throw new Error(`Missing Circom constant: ${key}`);
    }
    config[key] = value;
  }

  return config as FrontendConfig;
}

async function main() {
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT_DIR;
  const frontendConfig = JSON.stringify(await loadFrontendConfig(), null, 2);
  const outputPath = path.join(outputDir, 'frontendCfg.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, frontendConfig, 'utf8');
  console.log(`Successfully wrote '${outputPath}'.`);
}

void main();
