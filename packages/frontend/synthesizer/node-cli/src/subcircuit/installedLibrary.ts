import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseSubcircuitLibraryData,
} from '../../../core/src/subcircuit.ts';
import {
  resolveSubcircuitLibraryData,
} from '../../../core/src/app.ts';
import {
  loadSubcircuitWasmBuffer,
  resolveSubcircuitLibraryDirectory,
} from './wasmLoader.ts';
import type {
  ResolvedSubcircuitLibrary,
  SubcircuitLibraryData,
} from '../../../core/src/subcircuit.ts';

const subcircuitLibraryDirectory = resolveSubcircuitLibraryDirectory();

const readLibraryJson = (fileName: string): unknown => JSON.parse(readFileSync(
  path.join(subcircuitLibraryDirectory, fileName),
  'utf8',
));

export const installedSubcircuitLibraryData: SubcircuitLibraryData = parseSubcircuitLibraryData({
  setupParams: readLibraryJson('setupParams.json'),
  globalWireList: readLibraryJson('globalWireList.json'),
  frontendCfg: readLibraryJson('frontendCfg.json'),
  subcircuitInfo: readLibraryJson('subcircuitInfo.json'),
});

export const installedSubcircuitLibrary: ResolvedSubcircuitLibrary =
  resolveSubcircuitLibraryData(installedSubcircuitLibraryData, loadSubcircuitWasmBuffer);
