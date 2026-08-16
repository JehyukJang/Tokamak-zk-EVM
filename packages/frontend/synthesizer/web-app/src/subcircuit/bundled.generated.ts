import setupParamsJson from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/setupParams.json' with { type: 'json' };
import globalWireListJson from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/globalWireList.json' with { type: 'json' };
import frontendCfgJson from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/frontendCfg.json' with { type: 'json' };
import subcircuitInfoJson from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/subcircuitInfo.json' with { type: 'json' };
import wasm0 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit0.wasm';
import wasm1 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit1.wasm';
import wasm2 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit2.wasm';
import wasm3 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit3.wasm';
import wasm4 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit4.wasm';
import wasm5 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit5.wasm';
import wasm6 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit6.wasm';
import wasm7 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit7.wasm';
import wasm8 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit8.wasm';
import wasm9 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit9.wasm';
import wasm10 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit10.wasm';
import wasm11 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit11.wasm';
import wasm12 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit12.wasm';
import wasm13 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit13.wasm';
import wasm14 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit14.wasm';
import wasm15 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit15.wasm';
import wasm16 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit16.wasm';
import wasm17 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit17.wasm';
import wasm18 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit18.wasm';
import wasm19 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit19.wasm';
import wasm20 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit20.wasm';
import wasm21 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit21.wasm';
import wasm22 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit22.wasm';
import wasm23 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit23.wasm';
import wasm24 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit24.wasm';
import wasm25 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit25.wasm';
import wasm26 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit26.wasm';
import wasm27 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit27.wasm';
import wasm28 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit28.wasm';
import wasm29 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit29.wasm';
import wasm30 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit30.wasm';
import wasm31 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit31.wasm';
import wasm32 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit32.wasm';
import wasm33 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit33.wasm';
import wasm34 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit34.wasm';
import wasm35 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit35.wasm';
import wasm36 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit36.wasm';
import wasm37 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit37.wasm';
import wasm38 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit38.wasm';
import wasm39 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit39.wasm';
import wasm40 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit40.wasm';
import wasm41 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit41.wasm';
import wasm42 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit42.wasm';
import wasm43 from '@tokamak-zk-evm/subcircuit-library/subcircuits/library/wasm/subcircuit43.wasm';

export {
  setupParamsJson,
  globalWireListJson,
  frontendCfgJson,
  subcircuitInfoJson,
};

export const wasmFiles: Record<number, Uint8Array> = {
  0: wasm0,
  1: wasm1,
  2: wasm2,
  3: wasm3,
  4: wasm4,
  5: wasm5,
  6: wasm6,
  7: wasm7,
  8: wasm8,
  9: wasm9,
  10: wasm10,
  11: wasm11,
  12: wasm12,
  13: wasm13,
  14: wasm14,
  15: wasm15,
  16: wasm16,
  17: wasm17,
  18: wasm18,
  19: wasm19,
  20: wasm20,
  21: wasm21,
  22: wasm22,
  23: wasm23,
  24: wasm24,
  25: wasm25,
  26: wasm26,
  27: wasm27,
  28: wasm28,
  29: wasm29,
  30: wasm30,
  31: wasm31,
  32: wasm32,
  33: wasm33,
  34: wasm34,
  35: wasm35,
  36: wasm36,
  37: wasm37,
  38: wasm38,
  39: wasm39,
  40: wasm40,
  41: wasm41,
  42: wasm42,
  43: wasm43,
};
