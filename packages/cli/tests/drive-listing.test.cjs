const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decodeDriveListingLiteral,
  selectLatestDriveArchive,
} = require('../dist/runtime/drive-listing.js');

function archiveEntry(fileId, name, sizeBytes) {
  const entry = Array(14).fill(null);
  entry[0] = fileId;
  entry[2] = name;
  entry[3] = 'application/zip';
  entry[13] = sizeBytes;
  return entry;
}

function listingHtml(payload) {
  const literal = JSON.stringify(JSON.stringify(payload)).slice(1, -1).replaceAll("'", "\\'");
  return `<script>window['_DRIVE_ivd'] = '${literal}';</script>`;
}

test('selects the latest matching CRS archive from a quoted Drive listing literal', () => {
  const selection = selectLatestDriveArchive(listingHtml([
    archiveEntry('older', 'tokamak-backend-crs-v2.1-20260828T010203Z.zip', 12),
    archiveEntry('latest', 'tokamak-backend-crs-v2.1-20260829T010203Z.zip', 34),
  ]), '2.1');
  assert.deepEqual(selection, {
    fileId: 'latest',
    name: 'tokamak-backend-crs-v2.1-20260829T010203Z.zip',
    compatibleBackendVersion: '2.1',
    generatedAt: '20260829T010203Z',
    sizeBytes: 34,
  });
});

test('fails closed for changed markup, malformed literals, and unsupported escapes', () => {
  assert.throws(() => decodeDriveListingLiteral("<script>window['OTHER'] = '[]';</script>"));
  assert.throws(() => decodeDriveListingLiteral("<script>window['_DRIVE_ivd'] = '[ ]</script>"));
  assert.throws(() => decodeDriveListingLiteral("<script>window['_DRIVE_ivd'] = '\\x5b\\x5d';</script>"));
});

test('rejects duplicate and ambiguous latest CRS entries', () => {
  const duplicate = archiveEntry('same-id', 'tokamak-backend-crs-v2.1-20260829T010203Z.zip', 12);
  assert.throws(() => selectLatestDriveArchive(listingHtml([duplicate, duplicate]), '2.1'));
  assert.throws(() => selectLatestDriveArchive(listingHtml([
    archiveEntry('first', 'tokamak-backend-crs-v2.1-20260829T010203Z.zip', 12),
    archiveEntry('second', 'tokamak-backend-crs-v2.1-20260829T010203Z.zip', 34),
  ]), '2.1'));
});
