import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import AdmZip from 'adm-zip';
import {
  ensureDir,
  normalizeCompatibleBackendVersion,
  packageCompatibleVersion,
  runtimePaths,
} from './context.js';
import { downloadFileWithResume, fileExists, normalizeSha256, sha256FileHex } from './download.js';
import type { RuntimeContext } from './model.js';
import { logVerbose } from '../system.js';
import {
  crsProvenanceFileName,
  finalMpcCrsArchiveRootFileNames,
  parseFinalMpcCrsProvenance,
} from '../generated/crs-provenance-validator.generated.js';
import {
  BACKEND_PACKAGE_NAMES,
  backendBuildMetadataFileName,
  parseBackendBuildMetadata,
} from '../generated/backend-build-metadata-validator.generated.js';

interface DriveArchiveSelection {
  compatibleBackendVersion: string;
  fileId: string;
  name: string;
  generatedAt: string;
  sizeBytes: number;
}

type FinalMpcCrsProvenance = import('../generated/crs-provenance-validator.generated.js').FinalMpcCrsProvenance;

const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';
const CRS_PROVENANCE_FILE_NAME = crsProvenanceFileName();
const FINAL_CRS_ARTIFACT_FILES = finalMpcCrsArchiveRootFileNames();
const CRS_DRIVE_FOLDER_ID = '14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv';

const CRS_DRIVE_FOLDER_URL = 'https://drive.google.com/drive/mobile/folders';

const CRS_DOWNLOAD_BASE_URL = 'https://drive.usercontent.google.com/download';

const CRS_DOWNLOAD_ANONYMOUS_MAX_RETRIES = 5;

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDriveArchiveName(
  name: string,
): Pick<DriveArchiveSelection, 'compatibleBackendVersion' | 'generatedAt'> | null {
  const parsed = name.match(/^tokamak-backend-crs-v(\d+)\.(\d+)-(\d{8}T\d{6}Z)\.zip$/iu);
  if (!parsed) {
    return null;
  }
  try {
    return {
      compatibleBackendVersion: normalizeCompatibleBackendVersion(
        `${parsed[1]}.${parsed[2]}`,
        `CRS archive name ${JSON.stringify(name)} compatibility version`,
      ),
      generatedAt: parsed[3],
    };
  } catch {
    return null;
  }
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

type CrsZipEntry = {
  readonly entryName: string;
  readonly header: {
    readonly attr: number;
    readonly flags: number;
  };
  readonly isDirectory: boolean;
  getData(): Buffer;
};

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMBOLIC_LINK_TYPE = 0o120000;

/**
 * Validates the complete central-directory entry set before any archive data
 * is written to disk. The backend-owned contract defines the only accepted
 * root-level filenames.
 */
export function validateFinalMpcCrsArchiveEntries(entries: readonly CrsZipEntry[]): Map<string, CrsZipEntry> {
  const expectedFileNames = new Set(FINAL_CRS_ARTIFACT_FILES);
  const accepted = new Map<string, CrsZipEntry>();

  for (const entry of entries) {
    const fileName = entry.entryName;
    validateCrsArchiveEntryName(fileName);
    if (entry.isDirectory) {
      throw new Error(`CRS archive entry ${JSON.stringify(fileName)} must be a root-level file, not a directory.`);
    }
    if ((entry.header.flags & 0x1) !== 0) {
      throw new Error(`CRS archive entry ${JSON.stringify(fileName)} must not be encrypted.`);
    }
    if (isSymbolicLink(entry)) {
      throw new Error(`CRS archive entry ${JSON.stringify(fileName)} must not be a symbolic link.`);
    }
    if (!expectedFileNames.has(fileName)) {
      throw new Error(`CRS archive contains unexpected entry ${JSON.stringify(fileName)}.`);
    }
    if (accepted.has(fileName)) {
      throw new Error(`CRS archive repeats entry ${JSON.stringify(fileName)}.`);
    }
    accepted.set(fileName, entry);
  }

  for (const fileName of FINAL_CRS_ARTIFACT_FILES) {
    if (!accepted.has(fileName)) {
      throw new Error(`CRS archive is missing required entry ${JSON.stringify(fileName)}.`);
    }
  }
  return accepted;
}

/** Extracts only a prevalidated final-MPC CRS archive into a caller-owned staging directory. */
export async function extractApprovedFinalMpcCrsArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  let archive: AdmZip;
  try {
    archive = new AdmZip(archivePath);
  } catch (error) {
    throw new Error(`Cannot read CRS ZIP archive ${archivePath}: ${errorMessage(error)}`);
  }
  const acceptedEntries = validateFinalMpcCrsArchiveEntries(archive.getEntries());
  await ensureDir(destinationDir);
  for (const fileName of FINAL_CRS_ARTIFACT_FILES) {
    const contents = acceptedEntries.get(fileName)!.getData();
    await fs.writeFile(path.join(destinationDir, fileName), contents, {
      flag: 'wx',
      mode: 0o600,
    });
  }
}

function validateCrsArchiveEntryName(fileName: string): void {
  if (fileName.length === 0 || fileName.includes('\0')) {
    throw new Error('CRS archive contains an empty or NUL-containing entry name.');
  }
  if (
    fileName.startsWith('/') ||
    fileName.startsWith('\\') ||
    /^[A-Za-z]:/u.test(fileName) ||
    fileName.includes('\\') ||
    fileName.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`CRS archive contains an unsafe entry path ${JSON.stringify(fileName)}.`);
  }
}

function isSymbolicLink(entry: CrsZipEntry): boolean {
  const unixMode = (entry.header.attr >>> 16) & 0xffff;
  return (unixMode & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMBOLIC_LINK_TYPE;
}

export async function validateDownloadedCrsArchive(
  extractedDir: string,
  backendReleaseDir: string,
  archiveName: string,
  compatibleBackendVersion: string,
  expectedBackendPackageVersion: string,
): Promise<{
  provenancePath: string;
}> {
  const provenancePath = path.join(extractedDir, CRS_PROVENANCE_FILE_NAME);
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

  for (const backendName of BACKEND_PACKAGE_NAMES) {
    const backendMetadataPath = path.join(backendReleaseDir, backendBuildMetadataFileName(backendName));
    const backendMetadata = parseBackendBuildMetadata(
      await readJsonFile<unknown>(backendMetadataPath),
      backendName,
      `Backend package ${backendName} build metadata`,
    );
    const backendVersion = backendMetadata.packageVersion;
    const backendCompatibleVersion = backendMetadata.compatibleBackendVersion;
    const backendSubcircuitVersion = backendMetadata.dependencies.subcircuitLibrary.buildVersion;
    const backendSubcircuitPackageName = backendMetadata.dependencies.subcircuitLibrary.packageName;
    if (backendCompatibleVersion !== compatibleBackendVersion) {
      throw new Error(
        `Backend package ${backendName} has compatibleBackendVersion ${backendCompatibleVersion}, but the downloaded CRS expects ${compatibleBackendVersion}.`,
      );
    }
    if (backendVersion !== expectedBackendPackageVersion) {
      throw new Error(
        `Backend package ${backendName} has version ${backendVersion}, expected current CLI package version ${expectedBackendPackageVersion}.`,
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
  return parseFinalMpcCrsProvenance(provenance, `CRS archive ${archiveName} finalMpcCrs provenance`);
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
    const filePath = path.join(extractedDir, fileName);
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
    await extractApprovedFinalMpcCrsArchive(archivePath, extractedDir);
    const { provenancePath } = await validateDownloadedCrsArchive(
      extractedDir,
      backendReleaseDir,
      archiveName,
      context.compatibleBackendVersion,
      context.packageVersion,
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
      const sourcePath = fileName === CRS_PROVENANCE_FILE_NAME
        ? provenancePath
        : path.join(extractedDir, fileName);
      await copyFile(sourcePath, path.join(stagingDirectory, fileName));
    }

    const stagedProvenance = await validateFinalMpcCrsProvenanceContract(
      await readJsonFile<unknown>(path.join(stagingDirectory, CRS_PROVENANCE_FILE_NAME)),
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
  if (outputState.kind === 'unmanaged-symlink') {
    throw new Error(
      `Existing setup output symlink is not managed by this CLI installation: ${setupOutputDir} -> ${outputState.target}`,
    );
  }
  const temporaryLink = `${setupOutputDir}.next`;
  await removeManagedTemporarySetupLink(temporaryLink, generationsDirectory);
  await fs.symlink(path.relative(path.dirname(setupOutputDir), nextGenerationDirectory), temporaryLink, 'dir');
  let temporaryLinkCreated = true;

  let migratedLegacyDirectory: string | undefined;
  if (outputState.kind === 'directory') {
    migratedLegacyDirectory = path.join(generationsDirectory, `legacy-${Date.now()}-${process.pid}`);
    await fs.rename(setupOutputDir, migratedLegacyDirectory);
  }

  try {
    await fs.rename(temporaryLink, setupOutputDir);
    temporaryLinkCreated = false;
  } catch (error) {
    if (temporaryLinkCreated) {
      await removeManagedTemporarySetupLink(temporaryLink, generationsDirectory);
    }
    if (migratedLegacyDirectory !== undefined) {
      await fs.rename(migratedLegacyDirectory, setupOutputDir);
    }
    throw error;
  }

  return outputState.kind === 'symlink' ? outputState.targetGenerationDirectory : migratedLegacyDirectory;
}

async function removeManagedTemporarySetupLink(
  temporaryLink: string,
  generationsDirectory: string,
): Promise<void> {
  let temporaryLinkStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    temporaryLinkStat = await fs.lstat(temporaryLink);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (!temporaryLinkStat.isSymbolicLink()) {
    throw new Error(`Existing setup activation temporary path is not managed by this CLI installation: ${temporaryLink}`);
  }
  const target = await fs.readlink(temporaryLink);
  const resolvedTarget = path.resolve(path.dirname(temporaryLink), target);
  if (!isPathInside(generationsDirectory, resolvedTarget)) {
    throw new Error(
      `Existing setup activation temporary symlink is not managed by this CLI installation: ${temporaryLink} -> ${target}`,
    );
  }
  await fs.rm(temporaryLink, { force: true });
}

type SetupOutputState =
  | { kind: 'missing' }
  | { kind: 'directory' }
  | { kind: 'symlink'; targetGenerationDirectory: string }
  | { kind: 'unmanaged-symlink'; target: string };

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
    if (!isPathInside(generationsDirectory, resolvedTarget)) {
      return { kind: 'unmanaged-symlink', target };
    }
    return {
      kind: 'symlink',
      targetGenerationDirectory: resolvedTarget,
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
