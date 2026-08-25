import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { backendEnvironment, ensureDir, packageCompatibleVersion, runtimePaths } from './context.js';
import { downloadFileWithResume, fileExists, normalizeSha256, sha256FileHex } from './download.js';
import type { RuntimeContext } from './model.js';
import { runCommand, logVerbose } from '../system.js';
import { parseFinalMpcCrsProvenance } from '../generated/crs-provenance.generated.js';

interface DriveArchiveSelection {
  compatibleBackendVersion: string;
  fileId: string;
  name: string;
  generatedAt: string;
  sizeBytes: number;
}

interface BackendBuildMetadata {
  compatibleBackendVersion?: string;
  dependencies?: {
    subcircuitLibrary?: {
      buildVersion?: string;
      packageName?: string;
    };
  };
  packageVersion?: string;
}

type FinalMpcCrsProvenance = import("../generated/crs-provenance.generated.js").FinalMpcCrsProvenance;
type Phase1SourceProvenance = FinalMpcCrsProvenance['phase1SourceProvenance'];

interface CrsProvenanceDocumentContract {
  requiredFields: string[];
}

interface CrsProvenanceContract {
  fileName: string;
  documentKinds: Record<string, CrsProvenanceDocumentContract>;
}

const BACKEND_BINARY_NAMES = ['preprocess', 'prove', 'verify'] as const;
const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';
const FINAL_CRS_ARTIFACT_FILES = [
  'combined_sigma.rkyv',
  'sigma_preprocess.rkyv',
  'sigma_verify.json',
  'crs_provenance.json',
] as const;
const FINAL_MPC_CRS_DOCUMENT_KIND = 'finalMpcCrs';

const CRS_DRIVE_FOLDER_ID = '14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv';

const CRS_DRIVE_FOLDER_URL = 'https://drive.google.com/drive/mobile/folders';

const CRS_DOWNLOAD_BASE_URL = 'https://drive.usercontent.google.com/download';

const CRS_DOWNLOAD_ANONYMOUS_MAX_RETRIES = 5;

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function readCrsProvenanceContract(): Promise<CrsProvenanceContract> {
  return readJsonFile<CrsProvenanceContract>(
    path.resolve(__dirname, '..', '..', 'manifests', 'crs-provenance-contract.json'),
  );
}

async function findNamedFile(rootDir: string, filename: string): Promise<string> {
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return entryPath;
      }
      if (entry.isDirectory()) {
        queue.push(entryPath);
      }
    }
  }
  throw new Error(`Missing ${filename} under ${rootDir}`);
}

function parseDriveArchiveName(
  name: string,
): Pick<DriveArchiveSelection, 'compatibleBackendVersion' | 'generatedAt'> | null {
  const parsed = name.match(/^tokamak-backend-crs-v(\d+)\.(\d+)-(\d{8}T\d{6}Z)\.zip$/iu);
  if (!parsed) {
    return null;
  }
  return {
    compatibleBackendVersion: `${Number(parsed[1])}.${Number(parsed[2])}`,
    generatedAt: parsed[3],
  };
}

function parseDriveArchiveSelection(html: string, expectedCompatibleVersion: string): DriveArchiveSelection {
  const match = html.match(/window\['_DRIVE_ivd'\]\s*=\s*('(?:\\.|[^'])*')/u);
  if (!match) {
    throw new Error('Unable to locate Google Drive listing payload.');
  }

  const decoded = vm.runInNewContext(match[1]) as string;
  const payload = JSON.parse(decoded) as unknown;
  const entriesById = new Map<string, DriveArchiveSelection>();

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) {
      return;
    }

    if (typeof node[0] === 'string' && typeof node[2] === 'string' && node[3] === 'application/zip') {
      const parsedName = parseDriveArchiveName(node[2]);
      const sizeBytes = typeof node[13] === 'number' && Number.isFinite(node[13]) ? node[13] : null;
      if (
        parsedName &&
        parsedName.compatibleBackendVersion === expectedCompatibleVersion &&
        sizeBytes !== null &&
        sizeBytes > 0
      ) {
        entriesById.set(node[0], {
          fileId: node[0],
          name: node[2],
          compatibleBackendVersion: parsedName.compatibleBackendVersion,
          generatedAt: parsedName.generatedAt,
          sizeBytes,
        });
      }
    }

    for (const child of node) {
      walk(child);
    }
  };

  walk(payload);

  const entries = [...entriesById.values()];
  if (entries.length === 0) {
    throw new Error(
      `No CRS archive matching compatibility version ${expectedCompatibleVersion} was found in Google Drive.`,
    );
  }

  entries.sort((left, right) => {
    return right.generatedAt.localeCompare(left.generatedAt);
  });
  return entries[0];
}

async function selectLatestDriveArchive(compatibleBackendVersion: string): Promise<DriveArchiveSelection> {
  const response = await fetch(`${CRS_DRIVE_FOLDER_URL}/${CRS_DRIVE_FOLDER_ID}`);
  if (!response.ok) {
    throw new Error(`Failed to read CRS listing: ${response.status} ${response.statusText}`);
  }
  return parseDriveArchiveSelection(await response.text(), compatibleBackendVersion);
}

async function crsArchiveCacheMatches(
  archivePath: string,
  selection: DriveArchiveSelection,
  verbose: boolean,
): Promise<boolean> {
  try {
    const archiveName = path.basename(archivePath);
    const parsedName = parseDriveArchiveName(archiveName);
    if (parsedName === null) {
      logVerbose(
        verbose,
        `Ignoring cached CRS archive ${archivePath}: archive name does not match the expected CRS naming convention.`,
      );
      return false;
    }
    if (
      parsedName.generatedAt !== selection.generatedAt ||
      parsedName.compatibleBackendVersion !== selection.compatibleBackendVersion
    ) {
      logVerbose(
        verbose,
        `Ignoring cached CRS archive ${archivePath}: archive compatibility version ${parsedName.compatibleBackendVersion} at ${parsedName.generatedAt} does not match selected CRS ${selection.compatibleBackendVersion} at ${selection.generatedAt}.`,
      );
      return false;
    }

    const stats = await fs.stat(archivePath);
    if (!stats.isFile()) {
      logVerbose(verbose, `Ignoring cached CRS archive ${archivePath}: cached path is not a file.`);
      return false;
    }
    if (stats.size !== selection.sizeBytes) {
      logVerbose(
        verbose,
        `Ignoring cached CRS archive ${archivePath}: file size ${stats.size} does not match latest CRS size ${selection.sizeBytes}.`,
      );
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVerbose(verbose, `Ignoring cached CRS archive ${archivePath}: ${message}`);
    return false;
  }
}

async function downloadLatestCrsArchive(
  context: RuntimeContext,
  selection: DriveArchiveSelection,
  verbose: boolean,
): Promise<{ archivePath: string; archiveName: string }> {
  const url = `${CRS_DOWNLOAD_BASE_URL}?id=${selection.fileId}&export=download&confirm=t`;
  const downloadDir = path.join(context.platformDir, 'downloads', 'crs');
  const archivePath = path.join(downloadDir, selection.name);
  if (await fileExists(archivePath)) {
    if (await crsArchiveCacheMatches(archivePath, selection, verbose)) {
      logVerbose(verbose, `Using cached CRS archive ${archivePath}`);
      return {
        archivePath,
        archiveName: selection.name,
      };
    }
    await fs.rm(archivePath, { force: true });
  }

  const resumableState = {
    archiveName: selection.name,
    contentLength: selection.sizeBytes,
    fileId: selection.fileId,
  };

  await downloadFileWithResume(archivePath, resumableState, verbose, {
    describe: 'Anonymous CRS download',
    maxRetries: CRS_DOWNLOAD_ANONYMOUS_MAX_RETRIES,
    request: (offset, chunkEnd) => ({
      url,
      headers: {
        Range: `bytes=${offset}-${chunkEnd}`,
      },
    }),
  });
  if (!(await crsArchiveCacheMatches(archivePath, selection, verbose))) {
    await fs.rm(archivePath, { force: true });
    throw new Error(`Downloaded CRS archive ${selection.name} failed archive name and size validation.`);
  }
  return {
    archivePath,
    archiveName: selection.name,
  };
}

async function extractZipArchive(zipPath: string, destinationDir: string, verbose: boolean): Promise<void> {
  await ensureDir(destinationDir);
  await runCommand('unzip', ['-q', zipPath, '-d', destinationDir], {
    verbose,
  });
}

export async function validateDownloadedCrsArchive(
  extractedDir: string,
  backendReleaseDir: string,
  archiveName: string,
  compatibleBackendVersion: string,
): Promise<{
  provenancePath: string;
}> {
  const provenancePath = await findNamedFile(extractedDir, 'crs_provenance.json');
  const provenance = await validateFinalMpcCrsProvenanceContract(
    await readJsonFile<unknown>(provenancePath),
    archiveName,
  );
  if (provenance.compatibleBackendVersion !== compatibleBackendVersion) {
    throw new Error(
      `CRS archive ${archiveName} has compatibleBackendVersion ${provenance.compatibleBackendVersion ?? '<missing>'}, expected ${compatibleBackendVersion}.`,
    );
  }
  await validateCrsArtifactHashes(extractedDir, archiveName, provenance);

  const provenanceSubcircuitPackageName = provenance.subcircuitLibrary?.packageName;
  const provenanceSubcircuitPackageVersion = provenance.subcircuitLibrary?.packageVersion;
  if (!provenanceSubcircuitPackageName || !provenanceSubcircuitPackageVersion) {
    throw new Error(`CRS archive ${archiveName} provenance is missing subcircuit-library package information.`);
  }
  if (provenanceSubcircuitPackageName !== SUBCIRCUIT_LIBRARY_PACKAGE_NAME) {
    throw new Error(
      `CRS archive ${archiveName} provenance subcircuit-library package ${provenanceSubcircuitPackageName} does not match ${SUBCIRCUIT_LIBRARY_PACKAGE_NAME}.`,
    );
  }
  if (
    packageCompatibleVersion(provenanceSubcircuitPackageVersion, 'CRS provenance subcircuit-library packageVersion') !==
    compatibleBackendVersion
  ) {
    throw new Error(
      `CRS archive ${archiveName} provenance subcircuit-library version ${provenanceSubcircuitPackageVersion} is not compatible with ${compatibleBackendVersion}.`,
    );
  }

  for (const backendName of BACKEND_BINARY_NAMES) {
    const backendMetadataPath = path.join(backendReleaseDir, `build-metadata-${backendName}.json`);
    const backendMetadata = await readJsonFile<BackendBuildMetadata>(backendMetadataPath);
    const backendVersion = backendMetadata.packageVersion;
    const backendCompatibleVersion = backendMetadata.compatibleBackendVersion;
    const backendSubcircuitVersion = backendMetadata.dependencies?.subcircuitLibrary?.buildVersion;
    const backendSubcircuitPackageName = backendMetadata.dependencies?.subcircuitLibrary?.packageName;
    if (!backendVersion || !backendCompatibleVersion || !backendSubcircuitVersion || !backendSubcircuitPackageName) {
      throw new Error(`Backend package ${backendName} is missing required build metadata.`);
    }
    if (backendCompatibleVersion !== compatibleBackendVersion) {
      throw new Error(
        `Backend package ${backendName} has compatibleBackendVersion ${backendCompatibleVersion}, but the downloaded CRS expects ${compatibleBackendVersion}.`,
      );
    }
    if (packageCompatibleVersion(backendVersion, `${backendName} packageVersion`) !== compatibleBackendVersion) {
      throw new Error(
        `Backend package ${backendName} has version ${backendVersion}, which is not compatible with CRS version ${compatibleBackendVersion}.`,
      );
    }
    if (backendSubcircuitPackageName !== SUBCIRCUIT_LIBRARY_PACKAGE_NAME) {
      throw new Error(
        `Backend package ${backendName} records subcircuit-library package ${backendSubcircuitPackageName}, expected ${SUBCIRCUIT_LIBRARY_PACKAGE_NAME}.`,
      );
    }
    if (
      packageCompatibleVersion(backendSubcircuitVersion, `${backendName} subcircuit-library buildVersion`) !==
      compatibleBackendVersion
    ) {
      throw new Error(
        `Backend package ${backendName} embeds subcircuit-library version ${backendSubcircuitVersion}, which is not compatible with CRS version ${compatibleBackendVersion}.`,
      );
    }
  }

  return {
    provenancePath,
  };
}

export async function validateFinalMpcCrsProvenanceContract(
  provenance: unknown,
  archiveName: string,
): Promise<FinalMpcCrsProvenance> {
  const contract = await readCrsProvenanceContract();
  const finalMpcCrs = contract.documentKinds[FINAL_MPC_CRS_DOCUMENT_KIND];
  if (contract.fileName !== 'crs_provenance.json' || finalMpcCrs === undefined) {
    throw new Error('The packaged CRS provenance contract does not define finalMpcCrs.');
  }
  const record = requiredExactObject(
    provenance,
    `CRS archive ${archiveName} finalMpcCrs provenance`,
    finalMpcCrs.requiredFields,
  );
  if (record.documentKind !== FINAL_MPC_CRS_DOCUMENT_KIND) {
    throw new Error(
      `CRS archive ${archiveName} has documentKind ${describeValue(record.documentKind)}, expected ${FINAL_MPC_CRS_DOCUMENT_KIND}.`,
    );
  }
  const generatedAtUtc = requiredDateTime(record.generatedAtUtc, 'generatedAtUtc', archiveName);
  const compatibleBackendVersion = requiredString(
    record.compatibleBackendVersion,
    'compatibleBackendVersion',
    archiveName,
  );
  const subcircuitLibrary = validateSubcircuitLibrary(record.subcircuitLibrary, archiveName);
  const phase1SourceProvenance = validatePhase1SourceProvenance(record.phase1SourceProvenance, archiveName);

  return {
    documentKind: FINAL_MPC_CRS_DOCUMENT_KIND,
    releaseEligible: requiredBoolean(record.releaseEligible, 'releaseEligible', archiveName),
    generatedAtUtc,
    compatibleBackendVersion,
    subcircuitLibrary,
    phase1SourceProvenance,
    combinedSigmaSha256: requiredSha256(record.combinedSigmaSha256, 'combinedSigmaSha256', archiveName),
    sigmaPreprocessSha256: requiredSha256(record.sigmaPreprocessSha256, 'sigmaPreprocessSha256', archiveName),
    sigmaVerifySha256: requiredSha256(record.sigmaVerifySha256, 'sigmaVerifySha256', archiveName),
  };
}

function requiredExactObject(
  value: unknown,
  label: string,
  requiredFields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(requiredFields);
  for (const field of requiredFields) {
    if (!Object.hasOwn(record, field)) {
      throw new Error(`${label} is missing ${field}.`);
    }
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw new Error(`${label} has an unsupported field ${field}.`);
    }
  }
  return record;
}

function requiredString(value: unknown, field: string, archiveName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CRS archive ${archiveName} provenance ${field} must be a non-empty string.`);
  }
  return value;
}

function requiredDateTime(value: unknown, field: string, archiveName: string): string {
  const dateTime = requiredString(value, field, archiveName);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw new Error(`CRS archive ${archiveName} provenance ${field} must be an RFC 3339 date-time.`);
  }
  return dateTime;
}

function requiredBoolean(value: unknown, field: string, archiveName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`CRS archive ${archiveName} provenance ${field} must be a boolean.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string, archiveName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CRS archive ${archiveName} provenance ${field} must be a non-negative integer.`);
  }
  return value;
}

function requiredNullableString(value: unknown, field: string, archiveName: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, field, archiveName);
}

function requiredSha256(value: unknown, field: string, archiveName: string): string {
  const digest = requiredString(value, field, archiveName);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`CRS archive ${archiveName} provenance ${field} must be a lowercase SHA-256 hex digest.`);
  }
  return digest;
}

function validateSubcircuitLibrary(value: unknown, archiveName: string): FinalMpcCrsProvenance['subcircuitLibrary'] {
  const library = requiredExactObject(value, `CRS archive ${archiveName} provenance subcircuitLibrary`, [
    'packageName',
    'packageVersion',
    'origin',
  ]);
  const origin = requiredString(library.origin, 'subcircuitLibrary.origin', archiveName);
  if (origin !== 'npmSnapshot' && origin !== 'localQapCompiler') {
    throw new Error(`CRS archive ${archiveName} provenance has unsupported subcircuitLibrary.origin ${origin}.`);
  }
  return {
    packageName: requiredString(library.packageName, 'subcircuitLibrary.packageName', archiveName),
    packageVersion: requiredString(library.packageVersion, 'subcircuitLibrary.packageVersion', archiveName),
    origin,
  };
}

function validatePhase1SourceProvenance(value: unknown, archiveName: string): Phase1SourceProvenance {
  if (value === null || value === 'native') {
    return value;
  }
  const phase1 = requiredExactObject(value, `CRS archive ${archiveName} provenance phase1SourceProvenance`, [
    'duskGroth16',
  ]);
  const dusk = requiredExactObject(
    phase1.duskGroth16,
    `CRS archive ${archiveName} provenance phase1SourceProvenance.duskGroth16`,
    [
      'sourceUrl',
      'sourceSizeBytes',
      'rawEncoding',
      'pinnedContribution',
      'pinnedReadmeUrl',
      'pinnedDriveFileId',
      'expectedSourceSha256',
      'actualSourceSha256',
      'autoDownloaded',
      'downloadedContribution',
      'downloadedReadmeUrl',
      'downloadedDriveFileId',
      'maxG1ExpUsed',
      'maxG2ExpUsed',
      'transcriptConsistencyVerified',
    ],
  );
  return {
    duskGroth16: {
      sourceUrl: requiredString(dusk.sourceUrl, 'phase1SourceProvenance.duskGroth16.sourceUrl', archiveName),
      sourceSizeBytes: requiredInteger(
        dusk.sourceSizeBytes,
        'phase1SourceProvenance.duskGroth16.sourceSizeBytes',
        archiveName,
      ),
      rawEncoding: requiredString(dusk.rawEncoding, 'phase1SourceProvenance.duskGroth16.rawEncoding', archiveName),
      pinnedContribution: requiredString(
        dusk.pinnedContribution,
        'phase1SourceProvenance.duskGroth16.pinnedContribution',
        archiveName,
      ),
      pinnedReadmeUrl: requiredString(
        dusk.pinnedReadmeUrl,
        'phase1SourceProvenance.duskGroth16.pinnedReadmeUrl',
        archiveName,
      ),
      pinnedDriveFileId: requiredString(
        dusk.pinnedDriveFileId,
        'phase1SourceProvenance.duskGroth16.pinnedDriveFileId',
        archiveName,
      ),
      expectedSourceSha256: requiredSha256(
        dusk.expectedSourceSha256,
        'phase1SourceProvenance.duskGroth16.expectedSourceSha256',
        archiveName,
      ),
      actualSourceSha256: requiredSha256(
        dusk.actualSourceSha256,
        'phase1SourceProvenance.duskGroth16.actualSourceSha256',
        archiveName,
      ),
      autoDownloaded: requiredBoolean(
        dusk.autoDownloaded,
        'phase1SourceProvenance.duskGroth16.autoDownloaded',
        archiveName,
      ),
      downloadedContribution: requiredNullableString(
        dusk.downloadedContribution,
        'phase1SourceProvenance.duskGroth16.downloadedContribution',
        archiveName,
      ),
      downloadedReadmeUrl: requiredNullableString(
        dusk.downloadedReadmeUrl,
        'phase1SourceProvenance.duskGroth16.downloadedReadmeUrl',
        archiveName,
      ),
      downloadedDriveFileId: requiredNullableString(
        dusk.downloadedDriveFileId,
        'phase1SourceProvenance.duskGroth16.downloadedDriveFileId',
        archiveName,
      ),
      maxG1ExpUsed: requiredInteger(dusk.maxG1ExpUsed, 'phase1SourceProvenance.duskGroth16.maxG1ExpUsed', archiveName),
      maxG2ExpUsed: requiredInteger(dusk.maxG2ExpUsed, 'phase1SourceProvenance.duskGroth16.maxG2ExpUsed', archiveName),
      transcriptConsistencyVerified: requiredBoolean(
        dusk.transcriptConsistencyVerified,
        'phase1SourceProvenance.duskGroth16.transcriptConsistencyVerified',
        archiveName,
      ),
    },
  };
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '<missing>' : JSON.stringify(value);
}

async function validateCrsArtifactHashes(
  extractedDir: string,
  archiveName: string,
  provenance: FinalMpcCrsProvenance,
): Promise<void> {
  const checks = [
    ['combinedSigmaSha256', 'combined_sigma.rkyv'],
    ['sigmaPreprocessSha256', 'sigma_preprocess.rkyv'],
    ['sigmaVerifySha256', 'sigma_verify.json'],
  ] as const;

  for (const [field, fileName] of checks) {
    const expected = normalizeSha256(provenance[field]);
    if (expected === null) {
      throw new Error(`CRS archive ${archiveName} provenance is missing ${field}.`);
    }
    const filePath = await findNamedFile(extractedDir, fileName);
    const actual = await sha256FileHex(filePath);
    if (actual !== expected) {
      throw new Error(`CRS archive ${archiveName} ${fileName} sha256 mismatch: expected=${expected} actual=${actual}.`);
    }
  }
}

export async function installDownloadedSetup(
  context: RuntimeContext,
  backendReleaseDir: string,
  verbose: boolean,
): Promise<void> {
  const paths = runtimePaths(context);
  const selection = await selectLatestDriveArchive(context.compatibleBackendVersion);

  const extractedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-crs-extract-'));
  try {
    const { archivePath, archiveName } = await downloadLatestCrsArchive(context, selection, verbose);
    await extractZipArchive(archivePath, extractedDir, verbose);
    const { provenancePath } = await validateDownloadedCrsArchive(
      extractedDir,
      backendReleaseDir,
      archiveName,
      context.compatibleBackendVersion,
    );

    await installValidatedCrsGeneration(extractedDir, provenancePath, paths.setupOutputDir, archiveName);
  } finally {
    await fs.rm(extractedDir, { recursive: true, force: true });
  }
}

export async function installValidatedCrsGeneration(
  extractedDir: string,
  provenancePath: string,
  setupOutputDir: string,
  archiveName: string,
  copyFile: typeof fs.copyFile = fs.copyFile,
): Promise<void> {
  const setupDirectory = path.dirname(setupOutputDir);
  const generationsDirectory = path.join(setupDirectory, 'generations');
  await ensureDir(generationsDirectory);

  const stagingDirectory = await fs.mkdtemp(path.join(generationsDirectory, '.staging-'));
  let generationDirectory: string | undefined;
  let activated = false;
  try {
    for (const fileName of FINAL_CRS_ARTIFACT_FILES) {
      const sourcePath =
        fileName === 'crs_provenance.json' ? provenancePath : await findNamedFile(extractedDir, fileName);
      await copyFile(sourcePath, path.join(stagingDirectory, fileName));
    }

    const stagedProvenance = await validateFinalMpcCrsProvenanceContract(
      await readJsonFile<unknown>(path.join(stagingDirectory, 'crs_provenance.json')),
      archiveName,
    );
    await validateCrsArtifactHashes(stagingDirectory, archiveName, stagedProvenance);

    generationDirectory = path.join(
      generationsDirectory,
      `generation-${path.basename(stagingDirectory).replace(/^\.staging-/u, '')}`,
    );
    await fs.rename(stagingDirectory, generationDirectory);
    const previousGenerationDirectory = await activateCrsGeneration(
      setupOutputDir,
      generationsDirectory,
      generationDirectory,
    );
    activated = true;
    if (previousGenerationDirectory !== undefined && previousGenerationDirectory !== generationDirectory) {
      await fs.rm(previousGenerationDirectory, { recursive: true, force: true });
    }
  } finally {
    if (!activated && generationDirectory !== undefined) {
      await fs.rm(generationDirectory, { recursive: true, force: true });
    } else if (!activated) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

async function activateCrsGeneration(
  setupOutputDir: string,
  generationsDirectory: string,
  nextGenerationDirectory: string,
): Promise<string | undefined> {
  const outputState = await inspectSetupOutput(setupOutputDir, generationsDirectory);
  const temporaryLink = `${setupOutputDir}.next`;
  await fs.rm(temporaryLink, { recursive: true, force: true });
  await fs.symlink(path.relative(path.dirname(setupOutputDir), nextGenerationDirectory), temporaryLink, 'dir');

  let migratedLegacyDirectory: string | undefined;
  if (outputState.kind === 'directory') {
    migratedLegacyDirectory = path.join(generationsDirectory, `legacy-${Date.now()}-${process.pid}`);
    await fs.rename(setupOutputDir, migratedLegacyDirectory);
  }

  try {
    await fs.rename(temporaryLink, setupOutputDir);
  } catch (error) {
    await fs.rm(temporaryLink, { recursive: true, force: true });
    if (migratedLegacyDirectory !== undefined) {
      await fs.rename(migratedLegacyDirectory, setupOutputDir);
    }
    throw error;
  }

  return outputState.kind === 'symlink' ? outputState.targetGenerationDirectory : migratedLegacyDirectory;
}

type SetupOutputState =
  { kind: 'missing' } | { kind: 'directory' } | { kind: 'symlink'; targetGenerationDirectory?: string };

async function inspectSetupOutput(setupOutputDir: string, generationsDirectory: string): Promise<SetupOutputState> {
  try {
    const outputStat = await fs.lstat(setupOutputDir);
    if (outputStat.isDirectory()) {
      return { kind: 'directory' };
    }
    if (!outputStat.isSymbolicLink()) {
      throw new Error(`Existing setup output path is neither a directory nor a symbolic link: ${setupOutputDir}`);
    }
    const target = await fs.readlink(setupOutputDir);
    const resolvedTarget = path.resolve(path.dirname(setupOutputDir), target);
    return {
      kind: 'symlink',
      targetGenerationDirectory: isPathInside(generationsDirectory, resolvedTarget) ? resolvedTarget : undefined,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: 'missing' };
    }
    throw error;
  }
}

function isPathInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function writeSkippedSetupNotice(context: RuntimeContext): Promise<void> {
  const paths = runtimePaths(context);
  await ensureDir(paths.setupOutputDir);
  await fs.writeFile(
    path.join(paths.setupOutputDir, 'README.txt'),
    'Setup artifacts were skipped during installation.\n',
    'utf8',
  );
}

export async function runTrustedSetup(context: RuntimeContext, verbose: boolean): Promise<void> {
  const paths = runtimePaths(context);
  await ensureDir(paths.setupOutputDir);
  await fs.access(paths.trustedSetupBinary);
  await runCommand(paths.trustedSetupBinary, ['--output', paths.setupOutputDir, '--fixed-tau'], {
    env: backendEnvironment(context),
    verbose,
  });
}
