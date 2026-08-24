import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { backendEnvironment, ensureDir, packageCompatibleVersion, runtimePaths } from './context.js';
import { downloadFileWithResume, fileExists, normalizeSha256, sha256FileHex } from './download.js';
import type { RuntimeContext } from './model.js';
import { runCommand, logVerbose } from '../system.js';

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

interface CrsProvenance {
  compatibleBackendVersion?: string;
  subcircuitLibrary?: {
    packageName?: string;
    packageVersion?: string;
  };
  combined_sigma_sha256?: string;
  sigma_preprocess_sha256?: string;
  sigma_verify_sha256?: string;
}

const BACKEND_BINARY_NAMES = ['preprocess', 'prove', 'verify'] as const;
const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';

const CRS_DRIVE_FOLDER_ID = '14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv';

const CRS_DRIVE_FOLDER_URL = 'https://drive.google.com/drive/mobile/folders';

const CRS_DOWNLOAD_BASE_URL = 'https://drive.usercontent.google.com/download';

const CRS_DOWNLOAD_ANONYMOUS_MAX_RETRIES = 5;

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
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

function parseDriveArchiveName(name: string): Pick<DriveArchiveSelection, 'compatibleBackendVersion' | 'generatedAt'> | null {
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
      logVerbose(verbose, `Ignoring cached CRS archive ${archivePath}: archive name does not match the expected CRS naming convention.`);
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

  await downloadFileWithResume(
    archivePath,
    resumableState,
    verbose,
    {
      describe: 'Anonymous CRS download',
      maxRetries: CRS_DOWNLOAD_ANONYMOUS_MAX_RETRIES,
      request: (offset, chunkEnd) => ({
        url,
        headers: {
          Range: `bytes=${offset}-${chunkEnd}`,
        },
      }),
    },
  );
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

async function validateDownloadedCrsVersions(
  extractedDir: string,
  backendReleaseDir: string,
  archiveName: string,
  compatibleBackendVersion: string,
): Promise<{
  mpcMetadataPath: string;
  provenancePath: string;
}> {
  const provenancePath = await findNamedFile(extractedDir, 'crs_provenance.json');
  const provenance = await readJsonFile<CrsProvenance>(provenancePath);
  if (provenance.compatibleBackendVersion !== compatibleBackendVersion) {
    throw new Error(
      `CRS archive ${archiveName} has compatibleBackendVersion ${provenance.compatibleBackendVersion ?? '<missing>'}, expected ${compatibleBackendVersion}.`,
    );
  }
  await validateCrsArtifactHashes(extractedDir, archiveName, provenance);

  const mpcMetadataPath = await findNamedFile(extractedDir, 'build-metadata-mpc-setup.json');
  const mpcMetadata = await readJsonFile<BackendBuildMetadata>(mpcMetadataPath);
  const mpcSubcircuitVersion = mpcMetadata.dependencies?.subcircuitLibrary?.buildVersion;
  const mpcSubcircuitPackageName = mpcMetadata.dependencies?.subcircuitLibrary?.packageName;
  const mpcVersion = mpcMetadata.packageVersion;
  const mpcCompatibleVersion = mpcMetadata.compatibleBackendVersion;
  if (!mpcSubcircuitVersion || !mpcSubcircuitPackageName || !mpcVersion || !mpcCompatibleVersion) {
    throw new Error(`CRS archive ${archiveName} is missing required metadata.`);
  }
  if (mpcCompatibleVersion !== compatibleBackendVersion) {
    throw new Error(
      `CRS archive ${archiveName} metadata compatibleBackendVersion ${mpcCompatibleVersion} does not match expected ${compatibleBackendVersion}.`,
    );
  }
  if (packageCompatibleVersion(mpcVersion, 'CRS metadata packageVersion') !== compatibleBackendVersion) {
    throw new Error(
      `CRS archive ${archiveName} metadata packageVersion ${mpcVersion} is not compatible with ${compatibleBackendVersion}.`,
    );
  }
  if (mpcSubcircuitPackageName !== SUBCIRCUIT_LIBRARY_PACKAGE_NAME) {
    throw new Error(
      `CRS archive ${archiveName} metadata subcircuit-library package ${mpcSubcircuitPackageName} does not match ${SUBCIRCUIT_LIBRARY_PACKAGE_NAME}.`,
    );
  }
  if (
    packageCompatibleVersion(mpcSubcircuitVersion, 'CRS metadata subcircuit-library buildVersion')
    !== compatibleBackendVersion
  ) {
    throw new Error(
      `CRS archive ${archiveName} metadata subcircuit-library version ${mpcSubcircuitVersion} is not compatible with ${compatibleBackendVersion}.`,
    );
  }
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
  if (provenanceSubcircuitPackageVersion !== mpcSubcircuitVersion) {
    throw new Error(
      `CRS archive ${archiveName} provenance subcircuit-library version ${provenanceSubcircuitPackageVersion} does not match MPC metadata version ${mpcSubcircuitVersion}.`,
    );
  }
  if (
    packageCompatibleVersion(provenanceSubcircuitPackageVersion, 'CRS provenance subcircuit-library packageVersion')
    !== compatibleBackendVersion
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
    if (
      !backendVersion ||
      !backendCompatibleVersion ||
      !backendSubcircuitVersion ||
      !backendSubcircuitPackageName
    ) {
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
      packageCompatibleVersion(backendSubcircuitVersion, `${backendName} subcircuit-library buildVersion`)
      !== compatibleBackendVersion
    ) {
      throw new Error(
        `Backend package ${backendName} embeds subcircuit-library version ${backendSubcircuitVersion}, which is not compatible with CRS version ${compatibleBackendVersion}.`,
      );
    }
  }

  return {
    mpcMetadataPath,
    provenancePath,
  };
}

async function validateCrsArtifactHashes(
  extractedDir: string,
  archiveName: string,
  provenance: CrsProvenance,
): Promise<void> {
  const checks = [
    ['combined_sigma_sha256', 'combined_sigma.rkyv'],
    ['sigma_preprocess_sha256', 'sigma_preprocess.rkyv'],
    ['sigma_verify_sha256', 'sigma_verify.json'],
  ] as const;

  for (const [field, fileName] of checks) {
    const expected = normalizeSha256(provenance[field]);
    if (expected === null) {
      throw new Error(`CRS archive ${archiveName} provenance is missing ${field}.`);
    }
    const filePath = await findNamedFile(extractedDir, fileName);
    const actual = await sha256FileHex(filePath);
    if (actual !== expected) {
      throw new Error(
        `CRS archive ${archiveName} ${fileName} sha256 mismatch: expected=${expected} actual=${actual}.`,
      );
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
    const { mpcMetadataPath, provenancePath } = await validateDownloadedCrsVersions(
      extractedDir,
      backendReleaseDir,
      archiveName,
      context.compatibleBackendVersion,
    );

    await ensureDir(paths.setupOutputDir);
    await fs.copyFile(
      await findNamedFile(extractedDir, 'combined_sigma.rkyv'),
      path.join(paths.setupOutputDir, 'combined_sigma.rkyv'),
    );
    await fs.copyFile(
      await findNamedFile(extractedDir, 'sigma_preprocess.rkyv'),
      path.join(paths.setupOutputDir, 'sigma_preprocess.rkyv'),
    );
    await fs.copyFile(
      await findNamedFile(extractedDir, 'sigma_verify.json'),
      path.join(paths.setupOutputDir, 'sigma_verify.json'),
    );
    await fs.copyFile(
      mpcMetadataPath,
      path.join(paths.setupOutputDir, 'build-metadata-mpc-setup.json'),
    );
    await fs.copyFile(provenancePath, path.join(paths.setupOutputDir, 'crs_provenance.json'));
  } finally {
    await fs.rm(extractedDir, { recursive: true, force: true });
  }
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
  await runCommand(
    paths.trustedSetupBinary,
    ['--output', paths.setupOutputDir, '--fixed-tau'],
    {
      env: backendEnvironment(context),
      verbose,
    },
  );
}
