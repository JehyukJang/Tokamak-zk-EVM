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

const outputDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../subcircuits/library')
const compilerOutputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(__dirname, 'temp.txt')
const interfaceDir = path.resolve(__dirname, '../subcircuits/interface')
const constantsPath = path.resolve(__dirname, '../subcircuits/circom/constants.circom')

function main() {
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
  main()
}
