// Generated from packages/backend/common/contracts/univariate-domain-contract.v1.json.
export const UNIVARIATE_DOMAIN_CONTRACT = {
  "contractVersion": 1,
  "owner": "backend",
  "protocolSchema": "tokamak-zk-evm-univariate",
  "scalarRootOfUnity": {
    "twoAdicity": 32,
    "maxRootCanonicalHex": "0212d79e5b416b6f0fd56dc8d168d6c0c4024ff270b3e0941b788f500b912f1f",
    "derivation": "root(N) = maxRoot^(2^32/N) for power-of-two N"
  },
  "arithmeticDomain": {
    "size": "n * s_max",
    "index": "i + s_max * r",
    "vanishingPolynomial": "Z_A(Z) = Z^N_A - 1"
  },
  "connectionDomain": {
    "size": "(l_D - l) * s_max",
    "index": "i + s_max * h",
    "vanishingPolynomial": "Z_C(Z) = Z^N_C - 1"
  },
  "combinedDomain": {
    "intersectionSize": "gcd(N_A, N_C)",
    "unionSize": "N_A + N_C - gcd(N_A, N_C)",
    "intersectionVanishingPolynomial": "Z_G(Z) = Z^gcd(N_A,N_C) - 1",
    "unionVanishingPolynomial": "Z_union(Z) = Z_A(Z) * Z_C(Z) / Z_G(Z)"
  },
  "maskingPolynomials": {
    "arithmetic": "M_A(Z) = Z_C(Z) / Z_G(Z)",
    "connection": "M_C(Z) = Z_A(Z) / Z_G(Z)"
  },
  "selectionDomain": {
    "size": "s_max * t",
    "index": "i + s_max * k",
    "typeCapacity": {
      "symbol": "t",
      "derivation": "ceilPow2(s_D + 1)",
      "emptySubcircuitId": "t - 1",
      "unselectableSubcircuitIdRange": "[s_D, t - 1)",
      "externalInactiveSelector": -1
    },
    "vanishingPolynomial": "Z_S(Z) = Z^(s_max*t) - 1"
  },
  "publicDomain": {
    "size": "l_free",
    "index": "globalWireIndex",
    "root": "canonicalRootOfUnity(l_free)",
    "fixedPublicRange": "[l_free, l)",
    "fixedBufferPlacement": "placementIndex == subcircuitId"
  },
  "capacity": {
    "d": "max(N_A + 1, N_C + 1)",
    "h": "d + 1",
    "P": "max(2*d + 1, N_S + 1, h + s_max*(t - 1), l_free - 1)",
    "K": "P - d",
    "S": "P + 1",
    "ordinaryMaximumExponent": "2*P",
    "taggedMaximumExponent": "P"
  }
} as const;

export default UNIVARIATE_DOMAIN_CONTRACT;
