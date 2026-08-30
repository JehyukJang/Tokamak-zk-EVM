const fs = require('node:fs')
const path = require('node:path')

function writeLibraryArtifacts(outputDir, {
  subcircuits,
  globalWireList,
  setupParams,
}) {
  fs.writeFileSync(
    path.join(outputDir, 'subcircuitInfo.json'),
    JSON.stringify(subcircuits, null),
    'utf8',
  )
  fs.writeFileSync(
    path.join(outputDir, 'globalWireList.json'),
    JSON.stringify(globalWireList, null),
    'utf8',
  )
  fs.writeFileSync(
    path.join(outputDir, 'setupParams.json'),
    JSON.stringify(setupParams, null, 2),
    'utf8',
  )
}

module.exports = {
  writeLibraryArtifacts,
}
