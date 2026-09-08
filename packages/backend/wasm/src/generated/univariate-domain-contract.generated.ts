// Generated from packages/backend/common/contracts/univariate-domain-contract.v1.json.
export const UNIVARIATE_DOMAIN_CONTRACT = {
  "contractVersion": 1,
  "owner": "backend",
  "protocolSchema": "tokamak-zk-evm-univariate-v2",
  "arithmeticDomain": {
    "size": "n * s_max * t",
    "index": "i + s_max * k + s_max * t * r",
    "typeCapacity": {
      "symbol": "t",
      "derivation": "smallestPowerOfTwoStrictlyGreaterThan(s_D)",
      "inactiveSubcircuitIdRange": "[s_D, t)"
    },
    "vanishingPolynomial": "Z_A(Z) = Z^N_A - 1"
  },
  "connectionDomain": {
    "size": "(l_D - l) * s_max",
    "index": "i + s_max * h",
    "vanishingPolynomial": "Z_C(Z) = Z^N_C - 1"
  },
  "combinedDomain": {
    "intersectionSize": "gcd(N_A, N_C)",
    "unionSize": "lcm(N_A, N_C)",
    "intersectionVanishingPolynomial": "Z_G(Z) = Z^gcd(N_A,N_C) - 1",
    "unionVanishingPolynomial": "Z_union(Z) = Z_A(Z) * Z_C(Z) / Z_G(Z)"
  },
  "maskingPolynomials": {
    "arithmetic": "M_A(Z) = Z_C(Z) / Z_G(Z)",
    "connection": "M_C(Z) = Z_A(Z) / Z_G(Z)"
  }
} as const;

export default UNIVARIATE_DOMAIN_CONTRACT;
