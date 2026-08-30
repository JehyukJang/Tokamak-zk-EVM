import { normalizeCompatibleBackendVersion } from './context.js';

export interface DriveArchiveSelection {
  readonly compatibleBackendVersion: string;
  readonly fileId: string;
  readonly name: string;
  readonly generatedAt: string;
  readonly sizeBytes: number;
}

const DRIVE_LISTING_ASSIGNMENT = "window['_DRIVE_ivd']";
const MAX_DRIVE_LISTING_CHARACTERS = 8 * 1024 * 1024;

export function parseDriveArchiveName(
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

function decodeHexQuad(value: string): string {
  if (!/^[0-9a-f]{4}$/iu.test(value)) {
    throw new Error('Google Drive listing uses an invalid Unicode escape.');
  }
  return String.fromCharCode(Number.parseInt(value, 16));
}

/**
 * Decodes only the single-quoted JavaScript string used by the Drive listing.
 * It deliberately accepts a small JSON-compatible escape subset rather than
 * evaluating server-provided JavaScript.
 */
export function decodeDriveListingLiteral(html: string): string {
  if (html.length > MAX_DRIVE_LISTING_CHARACTERS) {
    throw new Error('Google Drive listing is larger than the supported decoder limit.');
  }
  const assignmentStart = html.indexOf(DRIVE_LISTING_ASSIGNMENT);
  if (assignmentStart < 0) {
    throw new Error('Unable to locate Google Drive listing payload.');
  }
  let index = assignmentStart + DRIVE_LISTING_ASSIGNMENT.length;
  while (/\s/u.test(html[index] ?? '')) index += 1;
  if (html[index] !== '=') {
    throw new Error('Google Drive listing payload assignment is malformed.');
  }
  index += 1;
  while (/\s/u.test(html[index] ?? '')) index += 1;
  if (html[index] !== "'") {
    throw new Error('Google Drive listing payload must use a single-quoted literal.');
  }
  index += 1;

  let decoded = '';
  while (index < html.length) {
    const character = html[index];
    index += 1;
    if (character === "'") {
      return decoded;
    }
    if (character === '\\') {
      const escape = html[index];
      index += 1;
      switch (escape) {
        case "'":
        case '"':
        case '\\':
        case '/':
          decoded += escape;
          break;
        case 'b':
          decoded += '\b';
          break;
        case 'f':
          decoded += '\f';
          break;
        case 'n':
          decoded += '\n';
          break;
        case 'r':
          decoded += '\r';
          break;
        case 't':
          decoded += '\t';
          break;
        case 'u':
          decoded += decodeHexQuad(html.slice(index, index + 4));
          index += 4;
          break;
        default:
          throw new Error(`Google Drive listing uses unsupported escape ${JSON.stringify(`\\${escape ?? ''}`)}.`);
      }
      continue;
    }
    if (character === '\n' || character === '\r') {
      throw new Error('Google Drive listing payload contains an unescaped line break.');
    }
    decoded += character;
  }
  throw new Error('Google Drive listing payload string is not terminated.');
}

function parseListingPayload(html: string): unknown {
  const decoded = decodeDriveListingLiteral(html);
  try {
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    throw new Error(`Google Drive listing payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Selects the unambiguous latest archive candidate from an untrusted Drive listing. */
export function selectLatestDriveArchive(
  html: string,
  expectedCompatibleVersion: string,
): DriveArchiveSelection {
  const payload = parseListingPayload(html);
  const entriesById = new Map<string, DriveArchiveSelection>();

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string' && typeof node[2] === 'string' && node[3] === 'application/zip') {
      const parsedName = parseDriveArchiveName(node[2]);
      const sizeBytes = typeof node[13] === 'number' && Number.isFinite(node[13]) ? node[13] : null;
      if (
        parsedName &&
        parsedName.compatibleBackendVersion === expectedCompatibleVersion &&
        sizeBytes !== null &&
        sizeBytes > 0
      ) {
        if (entriesById.has(node[0])) {
          throw new Error(`Google Drive listing repeats CRS archive entry ${JSON.stringify(node[0])}.`);
        }
        entriesById.set(node[0], {
          fileId: node[0],
          name: node[2],
          compatibleBackendVersion: parsedName.compatibleBackendVersion,
          generatedAt: parsedName.generatedAt,
          sizeBytes,
        });
      }
    }
    for (const child of node) walk(child);
  };

  walk(payload);
  const entries = [...entriesById.values()];
  if (entries.length === 0) {
    throw new Error(
      `No CRS archive matching compatibility version ${expectedCompatibleVersion} was found in Google Drive.`,
    );
  }
  entries.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  if (entries.length > 1 && entries[0].generatedAt === entries[1].generatedAt) {
    throw new Error(`Google Drive listing has multiple latest CRS archives for ${expectedCompatibleVersion}.`);
  }
  return entries[0];
}
