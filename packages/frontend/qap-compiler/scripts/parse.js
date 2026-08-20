const { S_MAX, LIBRARY_LAYOUT } = require('./configure.js')

const fs = require('fs')
const path = require('path')
const {
  validateCompiledSubcircuitInterfaces,
} = require('./parse-interfaces.js')
const {
  parseSymbolTable,
  validateCompiledSymbolInterfaces,
} = require('./parse-symbols.js')
const { parseCompilerReport } = require('./parse-compiler-report.js')
const {
  buildGlobalWireLayout,
  buildSetupParams,
} = require('./build-wire-layout.js')
const { writeLibraryArtifacts } = require('./write-library-artifacts.js')

const interfaceDir = path.resolve(__dirname, '../subcircuits/interface')
const constantsPath = path.resolve(__dirname, '../subcircuits/circom/constants.circom')

function parseCliArguments(args) {
  if (!Array.isArray(args) || args.length !== 2) {
    throw new Error('Usage: node scripts/parse.js <output-dir> <compiler-output-path>')
  }

  return {
    outputDir: path.resolve(args[0]),
    compilerOutputPath: path.resolve(args[1]),
  }
}

function main({ outputDir, compilerOutputPath }) {
  fs.readFile(compilerOutputPath, 'utf8', (error, compilerReport) => {
    if (error) throw error

    let subcircuits = parseCompilerReport(compilerReport, compilerOutputPath)
    const symbolTables = new Map()
    for (const subcircuit of subcircuits) {
      const symbolPath = path.join(outputDir, `${subcircuit.name}_circuit.sym`)
      const symbolSource = fs.readFileSync(symbolPath, 'utf8')
      symbolTables.set(subcircuit.name, {
        entries: parseSymbolTable(symbolSource, symbolPath),
        source: symbolPath,
      })
    }
    validateCompiledSymbolInterfaces(subcircuits, symbolTables)

    subcircuits = validateCompiledSubcircuitInterfaces(
      subcircuits,
      interfaceDir,
      constantsPath,
    )
    const globalWireInfo = buildGlobalWireLayout(subcircuits, LIBRARY_LAYOUT)
    const setupParams = buildSetupParams(
      globalWireInfo,
      subcircuits,
      LIBRARY_LAYOUT,
      S_MAX,
    )

    writeLibraryArtifacts(outputDir, {
      subcircuits,
      globalWireList: globalWireInfo.wireList,
      setupParams,
    })
  })
}

if (require.main === module) {
  main(parseCliArguments(process.argv.slice(2)))
}

module.exports = {
  parseCliArguments,
}
