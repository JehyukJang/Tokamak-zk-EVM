# Synthesizer: Class Structure

This document provides detailed information about [Synthesizer](synthesizer-terminology.md#synthesizer)'s class structure, relationships, and implementation details.

---

## Synthesizer Class Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│                      Synthesizer                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  StateManager                                       │ │
│  │  - placements: Map<number, PlacementEntry>         │ │
│  │  - auxin: Auxin (auxiliary inputs)                 │ │
│  │  - storagePt, logPt, keccakPt, etc.                │ │
│  │  - placementIndex: number                           │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  OperationHandler                                   │ │
│  │  - placeArith(op, inputs)                          │ │
│  │  - placeExp(base, exponent)                        │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  DataLoader                                         │ │
│  │  - loadStorage(addr, key)                          │ │
│  │  - storeStorage(addr, key, value)                  │ │
│  │  - loadEnvInf/loadBlkInf                           │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  MemoryManager                                      │ │
│  │  - placeMemoryToStack(aliasInfos)                  │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  BufferManager                                      │ │
│  │  - addWireToInBuffer(val, placementId)             │ │
│  │  - addWireToOutBuffer(sym, val, placementId)       │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Finalizer                                          │ │
│  │  - refactor(): optimize placements                 │ │
│  │  - buildPermutation(): wire connections            │ │
│  │  - outputFiles(): permutation.json, witness        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Detailed Class Breakdown

### 1. Synthesizer Class

**Location**: [`src/tokamak/core/synthesizer/index.ts:27-181`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/synthesizer/index.ts#L27-L181)

**Role**: Central coordinator using Facade pattern

**Architecture**:

```typescript
export class Synthesizer
  implements ISynthesizerProvider, IDataLoaderProvider, IMemoryManagerProvider
{
  private _state: StateManager;                    // Line 30
  private operationHandler: OperationHandler;      // Line 31
  private dataLoader: DataLoader;                  // Line 32
  private memoryManager: MemoryManager;            // Line 33
  private bufferManager: BufferManager;            // Line 34

  constructor() {
    this._state = new StateManager();
    this.operationHandler = new OperationHandler(this, this._state);
    this.dataLoader = new DataLoader(this, this._state);
    this.memoryManager = new MemoryManager(this, this._state);
    this.bufferManager = new BufferManager(this, this._state);
  }

  public get state(): StateManager {
    return this._state;
  }

  // Delegate to handlers
  public placeArith(name: ArithmeticOperator, inPts: DataPt[]): DataPt[] {
    return this.operationHandler.placeArith(name, inPts);
  }

  public loadStorage(codeAddress: string, key: bigint, value: bigint): DataPt {
    return this.dataLoader.loadStorage(codeAddress, key, value);
  }

  // ... more delegation methods
}
```

**Design**: Facade pattern delegates to specialized handlers

---

### 2. StateManager Class

**Location**: [`src/tokamak/core/handlers/stateManager.ts:24-102`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/handlers/stateManager.ts#L24-L102)

**Role**: Central state repository

**Key Data Structures**:

```typescript
export class StateManager {
  public placements!: Placements;              // All placement instances
  public auxin!: Auxin;                        // Auxiliary inputs
  public envInf!: Map<string, {...}>;          // Environment info (CALLER, etc.)
  public blkInf!: Map<string, {...}>;          // Block info (NUMBER, etc.)
  public storagePt!: Map<string, DataPt>;      // Storage symbols
  public logPt!: {...}[];                      // Log data
  public keccakPt!: {...}[];                   // Keccak inputs/outputs
  public TStoragePt!: Map<...>;                // Transient storage
  public placementIndex!: number;              // Sequential counter
  public subcircuitInfoByName!: SubcircuitInfoByName;
  public subcircuitNames!: SubcircuitNames[];

  constructor() {
    this._initializeState();                   // Reset all state
    this._initializeSubcircuitInfo();          // Load subcircuit metadata
    this._initializePlacements();              // Create buffer placements (0-3)
    this.placementIndex = INITIAL_PLACEMENT_INDEX;  // Start from 4
  }

  public getNextPlacementIndex(): number {
    return this.placementIndex++;              // Atomic increment
  }
}
```

**Key Points**:

- Single source of truth for all Synthesizer state
- [Placements](synthesizer-terminology.md#placement) 0-3 reserved for [buffers](synthesizer-terminology.md#buffer-placements)
- Placement IDs start from 4

---

### 3. OperationHandler Class

**Location**: [`src/tokamak/core/handlers/operationHandler.ts`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/handlers/operationHandler.ts)

**Role**: Create [placements](synthesizer-terminology.md#placement) for arithmetic/logic operations

**Key Method**:

```typescript
public placeArith(name: ArithmeticOperator, inPts: DataPt[]): DataPt[] {
  // 1. Map operation to subcircuit
  const [subcircuitName, selector] = SUBCIRCUIT_MAPPING[name];

  // 2. Create selector DataPt
  const selectorPt = DataPointFactory.create({
    source: 'literal',
    value: selector,
    // ...
  });

  // 3. Create output DataPt
  const outPt = DataPointFactory.create({
    source: this.state.getNextPlacementIndex(),  // New placement ID
    wireIndex: outWireIndex,
    value: computedValue,
    // ...
  });

  // 4. Call Synthesizer.place()
  this.provider.place(
    subcircuitName,
    [selectorPt, ...inPts],
    [outPt],
    name
  );

  return [outPt];
}
```

---

### 4. DataLoader Class

**Location**: [`src/tokamak/core/handlers/dataLoader.ts`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/handlers/dataLoader.ts)

**Role**: Handle external data (storage, environment, block info)

**Key Methods**:

```typescript
public loadStorage(codeAddress: string, key: bigint, value: bigint): DataPt
public storeStorage(codeAddress: string, key: bigint, inPt: DataPt): void
public loadEnvInf(name: EnvInfNames, value: bigint): DataPt
public loadBlkInf(name: BlkInfNames, value: bigint): DataPt
public storeLog(valPts: DataPt[], topicPts: DataPt[]): void
public loadAndStoreKeccak(inPts: DataPt[], outValue: bigint, length: bigint): DataPt
```

**Example**: `loadStorage()`

```typescript
public loadStorage(codeAddress: string, key: bigint, value: bigint): DataPt {
  const keyString = `${codeAddress}_${key.toString()}`;

  // Check if already loaded (warm access)
  if (this.state.storagePt.has(keyString)) {
    return this.state.storagePt.get(keyString)!;
  }

  // Cold access: load from PRV_IN buffer
  const inPt = DataPointFactory.create({ value, ... });
  const outPt = this.provider.addWireToInBuffer(inPt, PRV_IN_PLACEMENT_INDEX);

  // Cache for future accesses
  this.state.storagePt.set(keyString, outPt);

  return outPt;
}
```

---

### 5. MemoryManager Class

**Location**: [`src/tokamak/core/handlers/memoryManager.ts`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/handlers/memoryManager.ts)

**Role**: Resolve [memory aliasing](synthesizer-terminology.md#data-aliasing)

**Key Method**:

```typescript
public placeMemoryToStack(dataAliasInfos: DataAliasInfos): DataPt {
  // Generate subcircuits to reconstruct overlapping memory
  // Uses SHR, SHL, AND, OR to combine fragments
  // Returns reconstructed symbol
}
```

**Used by**: `MLOAD`, `CALLDATACOPY`, `KECCAK256`, `LOG`, etc.

---

### 6. BufferManager Class

**Location**: [`src/tokamak/core/handlers/bufferManager.ts`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/handlers/bufferManager.ts)

**Role**: Manage LOAD and RETURN [buffer placements](synthesizer-terminology.md#buffer-placements)

**Key Methods**:

```typescript
public addWireToInBuffer(inPt: DataPt, placementId: number): DataPt {
  // Placement 0 (PUB_IN) or 2 (PRV_IN)
  // External value → Symbol conversion

  const outPt = DataPointFactory.create({
    source: placementId,
    wireIndex: nextIndex,
    value: inPt.value,
    // ...
  });

  this.state.placements.get(placementId)!.inPts.push(inPt);
  this.state.placements.get(placementId)!.outPts.push(outPt);

  return outPt;  // Symbol for circuit
}

public addWireToOutBuffer(inPt: DataPt, outPt: DataPt, placementId: number): void {
  // Placement 1 (PUB_OUT) or 3 (PRV_OUT)
  // Symbol → External value conversion

  this.state.placements.get(placementId)!.inPts.push(inPt);
  this.state.placements.get(placementId)!.outPts.push(outPt);
}
```

---

### 7. Finalizer Class

**Location**: [`src/tokamak/core/finalizer/index.ts:5-26`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/finalizer/index.ts#L5-L26)

**Role**: Transform symbolic execution results into concrete circuit files for the backend prover

#### Key Points

- **Post-execution processor**: Runs after transaction execution completes
- **EVM-to-Circom conversion**: Converts EVM 256-bit words into Circom-compatible 128-bit [limbs](synthesizer-terminology.md#limb)
- **Witness generation**: Produces concrete values that will be converted into a proof by the backend
- **Permutation analysis**: Analyzes chains of symbolic references and generates [permutation](synthesizer-terminology.md#permutation) polynomials
- **Backend interface**: Produces JSON files that the Rust backend can consume

#### Three Core Purposes

The Finalizer performs three essential transformations:

**Purpose 1: Convert EVM Words to Circom Words**

- **Problem**: EVM uses 256-bit values, but Circom's BLS12-381 scalar field is 254-bit
- **Risk**: Direct use of 256-bit values can cause field overflow
- **Solution**: Split each 256-bit value into two 128-bit limbs (lower + upper)
- **Trade-off**: This splitting **increases** circuit size and **slows down** proving time, but it's mathematically necessary
- **Note**: If we could avoid this conversion, performance would be significantly better

**Purpose 2: Generate Circuit Witness**

- **What it is**: Concrete numerical values for every wire in the circuit
- **Why needed**: The backend prover needs actual values (not symbolic pointers) to compute the proof
- **Process**: Converts symbolic data ([StackPt](synthesizer-terminology.md#stackpt), [MemoryPt](synthesizer-terminology.md#memorypt)) into numerical witness values
- **Output**: Placement-specific witness files that align with circuit structure

**Purpose 3: Analyze Symbol Chains and Generate Permutation**

- **What it is**: A permutation tracks which wires across different [placements](synthesizer-terminology.md#placement) must have the same value
- **Why needed**: In zk-SNARKs, when one placement's output feeds into another placement's input, the proof system must verify they're equal
- **How it works**:
  - Analyzes data flow between placements (e.g., ADD's output → MUL's input)
  - Groups wires that reference the same value into "permutation groups"
  - Generates permutation polynomials (X and Y) that encode these equality constraints
- **Mathematical basis**: Implements Section 3.1 "Compilers" of the [Tokamak zk-SNARK paper](https://eprint.iacr.org/2024/507)
- **Output**: `permutation.json` containing the circuit structure and wire connection mappings

#### Execution Flow

```typescript
export class Finalizer {
  private state: StateManager;

  constructor(stateManager: StateManager) {
    this.state = stateManager;
  }

  public async exec(_path?: string, writeToFS: boolean = true): Promise<Permutation> {
    // 1. Refactor placements (convert EVM words to Circom words)
    const placementRefactor = new PlacementRefactor(this.state);
    const refactoriedPlacements = placementRefactor.refactor();

    // 2. Generate permutation and witness
    const permutation = new Permutation(refactoriedPlacements, _path);
    permutation.placementVariables = await permutation.outputPlacementVariables(
      refactoriedPlacements,
      _path,
    );

    // 3. Write permutation.json
    permutation.outputPermutation(_path);

    return permutation;
  }
}
```

#### Three-Step Process in Detail

**Step 1: Placement Refactoring (EVM-to-Circom Conversion)**

```typescript
const placementRefactor = new PlacementRefactor(this.state);
const refactoriedPlacements = placementRefactor.refactor();
```

This step performs two critical transformations:

1. **Remove Unused Wires**

   - Identifies wires that were created but never used by any placement
   - Example: If LOAD [buffer](synthesizer-terminology.md#buffer-placements) creates 10 wires but only 7 are referenced → remove 3 unused wires
   - This is a true optimization that reduces circuit size

2. **Split 256-bit Values into 128-bit Limbs** (Precision Alignment for Elliptic Curve Fields)

   - **Why necessary**: Circom's BLS12-381 scalar field is 254-bit, but Ethereum uses 256-bit values
   - **Consequence**: This is NOT an optimization—it **increases circuit size** and **slows down proving**
   - **Alternative**: If Circom could handle 256-bit values natively, we wouldn't need this step and performance would improve
   - **Implementation** ([`placementRefactor.ts:53-82`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/finalizer/placementRefactor.ts#L53-L82)):

     ```typescript
     private halveWordSizeOfWires(newDataPts: DataPt[], origDataPt: DataPt): number[] {
       const newIndex = newDataPts.length;
       const indLow = newIndex;
       const indHigh = indLow + 1;

       if (origDataPt.sourceSize > 16) {  // If > 128 bits (16 bytes)
         // Create two DataPt entries for lower and upper limbs
         newDataPts[indLow] = { ...origDataPt };
         newDataPts[indLow].wireIndex = indLow;
         newDataPts[indHigh] = { ...origDataPt };
         newDataPts[indHigh].wireIndex = indHigh;

         // Split the 256-bit value
         newDataPts[indHigh].value = origDataPt.value >> 128n;        // Upper 128 bits
         newDataPts[indLow].value = origDataPt.value & (2n ** 128n - 1n); // Lower 128 bits

         // Convert to hex (16 bytes each)
         newDataPts[indHigh].valueHex = bytesToHex(
           setLengthLeft(bigIntToBytes(newDataPts[indHigh].value), 16)
         );
         newDataPts[indLow].valueHex = bytesToHex(
           setLengthLeft(bigIntToBytes(newDataPts[indLow].value), 16)
         );

         return [indLow, indHigh];  // Return both wire indices
       } else {
         // Values ≤ 128 bits don't need splitting
         newDataPts[newIndex] = { ...origDataPt };
         newDataPts[newIndex].wireIndex = newIndex;
         return [newIndex];
       }
     }
     ```

   - **Example**:

     ```typescript
     // Input: 256-bit value
     origDataPt = {
       value: 0x123456789ABCDEF0FEDCBA9876543210123456789ABCDEF0FEDCBA9876543210n,
       sourceSize: 32,  // 256 bits
       wireIndex: 5
     }

     // Output: Two 128-bit limbs
     newDataPts[10] = {
       value: 0xFEDCBA9876543210n,  // Lower 128 bits
       valueHex: "0xFEDCBA9876543210",
       wireIndex: 10
     }
     newDataPts[11] = {
       value: 0x123456789ABCDEF0n,  // Upper 128 bits
       valueHex: "0x123456789ABCDEF0",
       wireIndex: 11
     }
     // Returns: [10, 11]
     ```

   - **Result**: Each original wire becomes two wires: `[wireIndex_low, wireIndex_high]`
   - **Impact**: Backend circuits must now operate on pairs of 128-bit limbs instead of single 256-bit values

3. **Update Wire Connections**
   - Remaps all wire references to reflect the new split structure
   - Example: Placement A's output `wire[5]` → `[wire[10], wire[11]]`
   - All placements that referenced `wire[5]` now reference `[wire[10], wire[11]]`

**Step 2: Permutation & Witness Generation**

```typescript
const permutation = new Permutation(refactoriedPlacements, _path);
permutation.placementVariables = await permutation.outputPlacementVariables(
  refactoriedPlacements,
  _path,
);
```

**What happens in this step**:

1. **Build Permutation Groups** ([`permutation.ts:441-562`](https://github.com/JehyukJang/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/src/tokamak/core/finalizer/permutation.ts#L441-L562))

   - Analyzes data flow: which placement outputs feed into which placement inputs
   - Groups wires that must have identical values
   - Example: If `ADD.outPts[0]` → `MUL.inPts[1]`, they belong to the same permutation group

2. **Generate Permutation Polynomials** (implements [paper equation 8](https://eprint.iacr.org/2024/507))

   - `permutationX[i][h]`: which wire index in placement h
   - `permutationY[i][h]`: which placement that wire references
   - Example: `permutationY[5][3]=1` and `permutationX[5][3]=2` means "wire 5 of placement 3 equals wire 2 of placement 1"

3. **Generate Witness Data**
   - For each placement, computes concrete values for all wires
   - Uses Circom's `witness_calculator` to run each [subcircuit](synthesizer-terminology.md#subcircuit) with its inputs
   - Outputs placement-specific witness files (e.g., `placement_0_witness.json`)

**Step 3: Output Permutation File**

```typescript
permutation.outputPermutation(_path);
```

**What this produces**:

- Writes `permutation.json` containing:
  - Complete placement list with subcircuit IDs
  - Wire connection mappings (X and Y polynomials)
  - Input/output buffer sizes
  - Global wire indices

> **Why permutation is essential**: In zk-SNARKs, the prover must prove that wires carrying the same logical value actually have equal field elements. The permutation polynomials encode these equality constraints, allowing the backend to verify consistency across all placements.

> **Output Files**: For detailed information about the generated files and their structure, see [Output Files](synthesizer-output-files.md).
