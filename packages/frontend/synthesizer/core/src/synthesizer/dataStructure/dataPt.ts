import { bigIntToHex } from '@ethereumjs/util';
import type { DataPt, DataPtDescription, DataPtType, DataPtValueDomain, DataPtWireLayout } from '../types/index.ts';
import { BLS12831ARITHMODULUS, JUBJUBARITHMODULUS } from '../../synthesizer/params/constants.ts';

function copyAndFreezeValueDomain(valueDomain: DataPtValueDomain): DataPtValueDomain {
  if (valueDomain === undefined || valueDomain === null) {
    throw new Error('DataPt value domain is required');
  }
  switch (valueDomain.kind) {
    case 'uint':
      if (!Number.isInteger(valueDomain.bits) || valueDomain.bits < 1 || valueDomain.bits > 256) {
        throw new Error('DataPt uint domain bits must be an integer between 1 and 256');
      }
      return Object.freeze({ kind: 'uint', bits: valueDomain.bits });
    case 'bls12-381-fr':
      return Object.freeze({ kind: 'bls12-381-fr' });
    case 'jubjub-scalar':
      return Object.freeze({ kind: 'jubjub-scalar' });
    default:
      throw new Error(`Unsupported DataPt value domain: ${String((valueDomain as { kind?: unknown }).kind)}`);
  }
}

function copyAndFreezeWireLayout(wireLayout: DataPtWireLayout): DataPtWireLayout {
  if (wireLayout === undefined || wireLayout === null) {
    throw new Error('DataPt wire layout is required');
  }
  switch (wireLayout.kind) {
    case 'limbs-128':
      if (wireLayout.count !== 1 && wireLayout.count !== 2) {
        throw new Error('DataPt limb layout count must be 1 or 2');
      }
      return Object.freeze({ kind: 'limbs-128', count: wireLayout.count });
    case 'native-fr':
      return Object.freeze({ kind: 'native-fr' });
    default:
      throw new Error(`Unsupported DataPt wire layout: ${String((wireLayout as { kind?: unknown }).kind)}`);
  }
}

function validateDomainLayout(dataPtType: DataPtType): void {
  const { valueDomain, wireLayout } = dataPtType;
  if (wireLayout.kind === 'native-fr') {
    if (valueDomain.kind === 'uint') {
      throw new Error('DataPt uint domains cannot use the native-fr layout');
    }
    return;
  }

  if (valueDomain.kind === 'uint') {
    if (wireLayout.count === 1 && valueDomain.bits > 128) {
      throw new Error('DataPt uint domains wider than 128 bits require two limbs');
    }
    return;
  }

  if (wireLayout.count !== 2) {
    throw new Error('DataPt field and scalar domains require two limbs or the native-fr layout');
  }
}

function validateValue(dataPtType: DataPtType, value: bigint): void {
  const { valueDomain } = dataPtType;
  if (value < 0n) {
    throw new Error('DataPt values cannot be negative');
  }

  switch (valueDomain.kind) {
    case 'uint':
      if (value >= 1n << BigInt(valueDomain.bits)) {
        throw new Error(`DataPt value exceeds its uint(${valueDomain.bits}) domain`);
      }
      break;
    case 'bls12-381-fr':
      if (value >= BLS12831ARITHMODULUS) {
        throw new Error('DataPt value is outside the BLS12-381 Fr domain');
      }
      break;
    case 'jubjub-scalar':
      if (value >= JUBJUBARITHMODULUS) {
        throw new Error('DataPt value is outside the Jubjub scalar domain');
      }
      break;
  }
}

function copyAndFreezeDataPtType(dataPtType: DataPtType): DataPtType {
  if (dataPtType === undefined || dataPtType === null) {
    throw new Error('DataPt type is required');
  }
  const valueDomain = copyAndFreezeValueDomain(dataPtType.valueDomain);
  const wireLayout = copyAndFreezeWireLayout(dataPtType.wireLayout);
  const frozenDataPtType = Object.freeze({ valueDomain, wireLayout });
  validateDomainLayout(frozenDataPtType);
  return frozenDataPtType;
}

function copyDataPt(dataPt: DataPt): DataPt {
  const { value, valueHex: _valueHex, ...description } = dataPt;
  return DataPtFactory.create(description, value);
}

export class DataPtFactory {
  /**
   * Deep-copies a DataPt, a tuple [DataPt, DataPt], or an array of DataPt.
   * The return type is preserved based on the input type (via overloads).
   */
  public static deepCopy(a: DataPt): DataPt;
  public static deepCopy(a: [DataPt, DataPt]): [DataPt, DataPt];
  public static deepCopy(a: readonly [DataPt, DataPt]): [DataPt, DataPt];
  public static deepCopy<T extends ReadonlyArray<DataPt>>(a: T): T;
  public static deepCopy<T extends DataPt | ReadonlyArray<DataPt>>(a: T): T {
    if (Array.isArray(a)) {
      // Handle fixed-length 2-tuple precisely to preserve tuple type
      if (a.length === 2) {
        const [d0, d1] = a as unknown as readonly [DataPt, DataPt];
        const tuple: [DataPt, DataPt] = [copyDataPt(d0), copyDataPt(d1)];
        return tuple as unknown as T;
      }
      const arr = (a as ReadonlyArray<DataPt>).map(copyDataPt);
      return arr as unknown as T;
    }
    return copyDataPt(a as DataPt) as T;
  }

  public static create(params: DataPtDescription, value: bigint): DataPt {
    if ('sourceBitSize' in params) {
      throw new Error('DataPt sourceBitSize is no longer supported');
    }
    if ('valueDomain' in params || 'wireLayout' in params) {
      throw new Error('DataPt valueDomain and wireLayout must be provided together through dataPtType');
    }
    const dataPtType = copyAndFreezeDataPtType(params.dataPtType);
    validateValue(dataPtType, value);
    return {
      ...params,
      dataPtType,
      value,
      valueHex: bigIntToHex(value),
    };
  }

  public static createBufferTwin(dataPt: DataPt): DataPt {
    const placementId = dataPt.source;
    const thisWireIndex = dataPt.wireIndex;
    // Create output data point
    const outPtRaw: DataPtDescription = {
      source: placementId,
      wireIndex: thisWireIndex,
      dataPtType: dataPt.dataPtType,
    };
    return DataPtFactory.create(outPtRaw, dataPt.value);
  }
}
