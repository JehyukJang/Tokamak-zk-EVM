"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLS12_381_ToG2Point = exports.BLS12_381_ToG1Point = exports.BLS12_381_ToFrPoint = exports.BLS12_381_ToFpPoint = exports.BLS12_381_ToFp2Point = exports.BLS12_381_FromG2Point = exports.BLS12_381_FromG1Point = exports.NobleBLS = void 0;
const index_js_1 = require("@ethereumjs/util/index.js");
const bls_js_1 = require("ethereum-cryptography/bls.js");
const exceptions_js_1 = require("../../exceptions.js");
const constants_js_1 = require("./constants.js");
const G1_ZERO = bls_js_1.bls12_381.G1.ProjectivePoint.ZERO;
const G2_ZERO = bls_js_1.bls12_381.G2.ProjectivePoint.ZERO;
/**
 * Converts an Uint8Array to a Noble G1 point. Raises errors if the point is not on the curve
 * and (if activated) if the point is in the subgroup / order check.
 * @param input Input Uint8Array. Should be 128 bytes
 * @returns Noble G1 point
 */
function BLS12_381_ToG1Point(input, verifyOrder = true) {
    if ((0, index_js_1.equalsBytes)(input, constants_js_1.BLS_G1_INFINITY_POINT_BYTES)) {
        return G1_ZERO;
    }
    const x = (0, index_js_1.bytesToBigInt)(input.subarray(16, constants_js_1.BLS_G1_POINT_BYTE_LENGTH / 2));
    const y = (0, index_js_1.bytesToBigInt)(input.subarray(80, constants_js_1.BLS_G1_POINT_BYTE_LENGTH));
    const G1 = bls_js_1.bls12_381.G1.ProjectivePoint.fromAffine({
        x,
        y,
    });
    try {
        G1.assertValidity();
    }
    catch (e) {
        if (verifyOrder || e.message !== 'bad point: not in prime-order subgroup')
            throw new exceptions_js_1.EvmError(exceptions_js_1.ERROR.BLS_12_381_POINT_NOT_ON_CURVE);
    }
    return G1;
}
exports.BLS12_381_ToG1Point = BLS12_381_ToG1Point;
// input: a Noble G1 point
// output: a 128-byte Uint8Array
function BLS12_381_FromG1Point(input) {
    const xBytes = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.x), 64);
    const yBytes = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.y), 64);
    return (0, index_js_1.concatBytes)(xBytes, yBytes);
}
exports.BLS12_381_FromG1Point = BLS12_381_FromG1Point;
/**
 * Converts an Uint8Array to a Noble G2 point. Raises errors if the point is not on the curve
 * and (if activated) if the point is in the subgroup / order check.
 * @param input Input Uint8Array. Should be 256 bytes
 * @returns Noble G2 point
 */
function BLS12_381_ToG2Point(input, verifyOrder = true) {
    if ((0, index_js_1.equalsBytes)(input, constants_js_1.BLS_G2_INFINITY_POINT_BYTES)) {
        return G2_ZERO;
    }
    const p_x_1 = input.subarray(0, 64);
    const p_x_2 = input.subarray(64, constants_js_1.BLS_G2_POINT_BYTE_LENGTH / 2);
    const p_y_1 = input.subarray(128, 192);
    const p_y_2 = input.subarray(192, constants_js_1.BLS_G2_POINT_BYTE_LENGTH);
    const Fp2X = BLS12_381_ToFp2Point(p_x_1, p_x_2);
    const Fp2Y = BLS12_381_ToFp2Point(p_y_1, p_y_2);
    const pG2 = bls_js_1.bls12_381.G2.ProjectivePoint.fromAffine({
        x: Fp2X,
        y: Fp2Y,
    });
    try {
        pG2.assertValidity();
    }
    catch (e) {
        if (verifyOrder || e.message !== 'bad point: not in prime-order subgroup')
            throw new exceptions_js_1.EvmError(exceptions_js_1.ERROR.BLS_12_381_POINT_NOT_ON_CURVE);
    }
    return pG2;
}
exports.BLS12_381_ToG2Point = BLS12_381_ToG2Point;
// input: a Noble G1 point
// output: a 128-byte Uint8Array
function BLS12_381_FromG2Point(input) {
    const xBytes1 = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.x.c0), 64);
    const xBytes2 = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.x.c1), 64);
    const yBytes1 = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.y.c0), 64);
    const yBytes2 = (0, index_js_1.setLengthLeft)((0, index_js_1.bigIntToBytes)(input.y.c1), 64);
    return (0, index_js_1.concatBytes)(xBytes1, xBytes2, yBytes1, yBytes2);
}
exports.BLS12_381_FromG2Point = BLS12_381_FromG2Point;
// input: a 32-byte hex scalar Uint8Array
// output: a Noble Fr point
function BLS12_381_ToFrPoint(input) {
    const Fr = bls_js_1.bls12_381.fields.Fr.fromBytes(input);
    // TODO: This fixes the following two failing tests:
    // bls_g1mul_random*g1_unnormalized_scalar
    // bls_g1mul_random*p1_unnormalized_scalar
    // It should be nevertheless validated if this is (fully) correct,
    // especially if ">" or ">=" should be applied.
    //
    // Unfortunately the scalar in both test vectors is significantly
    // greater than the ORDER threshold, here are th values from both tests:
    //
    // Scalar / Order
    // 69732848789442042582239751384143889712113271203482973843852656394296700715236n
    // 52435875175126190479447740508185965837690552500527637822603658699938581184513n
    //
    // There should be 4 test cases added to the official test suite:
    // 1. bls_g1mul_random*g1_unnormalized_scalar within threshold (ORDER (?))
    // 2. bls_g1mul_random*g1_unnormalized_scalar outside threshold (ORDER + 1 (?))
    // 3. bls_g1mul_random*p1_unnormalized_scalar within threshold (ORDER (?))
    // 4. bls_g1mul_random*p1_unnormalized_scalar outside threshold (ORDER + 1 (?))
    //
    return bls_js_1.bls12_381.fields.Fr.create(Fr);
}
exports.BLS12_381_ToFrPoint = BLS12_381_ToFrPoint;
// input: a 64-byte buffer
// output: a Noble Fp point
function BLS12_381_ToFpPoint(fpCoordinate) {
    // check if point is in field
    if ((0, index_js_1.bytesToBigInt)(fpCoordinate) >= constants_js_1.BLS_FIELD_MODULUS) {
        throw new exceptions_js_1.EvmError(exceptions_js_1.ERROR.BLS_12_381_FP_NOT_IN_FIELD);
    }
    const FP = bls_js_1.bls12_381.fields.Fp.fromBytes(fpCoordinate.slice(16));
    return FP;
}
exports.BLS12_381_ToFpPoint = BLS12_381_ToFpPoint;
function BLS12_381_ToFp2Point(fpXCoordinate, fpYCoordinate) {
    // check if the coordinates are in the field
    if ((0, index_js_1.bytesToBigInt)(fpXCoordinate) >= constants_js_1.BLS_FIELD_MODULUS) {
        throw new exceptions_js_1.EvmError(exceptions_js_1.ERROR.BLS_12_381_FP_NOT_IN_FIELD);
    }
    if ((0, index_js_1.bytesToBigInt)(fpYCoordinate) >= constants_js_1.BLS_FIELD_MODULUS) {
        throw new exceptions_js_1.EvmError(exceptions_js_1.ERROR.BLS_12_381_FP_NOT_IN_FIELD);
    }
    const fpBytes = (0, index_js_1.concatBytes)(fpXCoordinate.subarray(16), fpYCoordinate.subarray(16));
    const FP = bls_js_1.bls12_381.fields.Fp2.fromBytes(fpBytes);
    return FP;
}
exports.BLS12_381_ToFp2Point = BLS12_381_ToFp2Point;
/**
 * Implementation of the `EVMBLSInterface` using the `ethereum-cryptography (`@noble/curves`)
 * JS library, see https://github.com/ethereum/js-ethereum-cryptography.
 *
 * This is the EVM default implementation.
 */
class NobleBLS {
    addG1(input) {
        const p1 = BLS12_381_ToG1Point(input.subarray(0, constants_js_1.BLS_G1_POINT_BYTE_LENGTH), false);
        const p2 = BLS12_381_ToG1Point(input.subarray(constants_js_1.BLS_G1_POINT_BYTE_LENGTH, constants_js_1.BLS_G1_POINT_BYTE_LENGTH * 2), false);
        const p = p1.add(p2);
        const result = BLS12_381_FromG1Point(p);
        return result;
    }
    mulG1(input) {
        // convert input to G1 points, add them, and convert the output to a Uint8Array.
        const p = BLS12_381_ToG1Point(input.subarray(0, constants_js_1.BLS_G1_POINT_BYTE_LENGTH));
        const scalar = BLS12_381_ToFrPoint(input.subarray(constants_js_1.BLS_G1_POINT_BYTE_LENGTH, 160));
        if (scalar === index_js_1.BIGINT_0) {
            return constants_js_1.BLS_G1_INFINITY_POINT_BYTES;
        }
        const result = p.multiplyUnsafe(scalar);
        return BLS12_381_FromG1Point(result);
    }
    addG2(input) {
        const p1 = BLS12_381_ToG2Point(input.subarray(0, constants_js_1.BLS_G2_POINT_BYTE_LENGTH), false);
        const p2 = BLS12_381_ToG2Point(input.subarray(constants_js_1.BLS_G2_POINT_BYTE_LENGTH, constants_js_1.BLS_G2_POINT_BYTE_LENGTH * 2), false);
        const p = p1.add(p2);
        const result = BLS12_381_FromG2Point(p);
        return result;
    }
    mulG2(input) {
        // convert input to G2 point/Fr point, add them, and convert the output to a Uint8Array.
        const p = BLS12_381_ToG2Point(input.subarray(0, constants_js_1.BLS_G2_POINT_BYTE_LENGTH));
        const scalar = BLS12_381_ToFrPoint(input.subarray(constants_js_1.BLS_G2_POINT_BYTE_LENGTH, 288));
        if (scalar === index_js_1.BIGINT_0) {
            return constants_js_1.BLS_G2_INFINITY_POINT_BYTES;
        }
        const result = p.multiplyUnsafe(scalar);
        return BLS12_381_FromG2Point(result);
    }
    mapFPtoG1(input) {
        // convert input to Fp1 point
        const FP = BLS12_381_ToFpPoint(input.subarray(0, 64));
        const result = bls_js_1.bls12_381.G1.mapToCurve([FP]).toAffine();
        const resultBytes = BLS12_381_FromG1Point(result);
        return resultBytes;
    }
    mapFP2toG2(input) {
        // convert input to Fp2 point
        const Fp2Point = BLS12_381_ToFp2Point(input.subarray(0, 64), input.subarray(64, 128));
        const result = bls_js_1.bls12_381.G2.mapToCurve([Fp2Point.c0, Fp2Point.c1]).toAffine();
        const resultBytes = BLS12_381_FromG2Point(result);
        return resultBytes;
    }
    msmG1(input) {
        // Note: This implementation is using the naive "algorithm" of just doing
        // p1G1*v1F1 + p2G1*v1F1 + ... while the EIP is suggesting to use an optimized
        // algorithm (Pippenger's algorithm, see https://eips.ethereum.org/EIPS/eip-2537#g1g2-msm).
        //
        // While this functionally works the approach is not "gas-cost-competitive" and an
        // optimization should be considered in the future.
        const pairLength = 160;
        const numPairs = input.length / pairLength;
        let pRes = G1_ZERO;
        for (let k = 0; k < numPairs; k++) {
            const pairStart = pairLength * k;
            const G1 = BLS12_381_ToG1Point(input.subarray(pairStart, pairStart + constants_js_1.BLS_G1_POINT_BYTE_LENGTH));
            const Fr = BLS12_381_ToFrPoint(input.subarray(pairStart + constants_js_1.BLS_G1_POINT_BYTE_LENGTH, pairStart + pairLength));
            let pMul;
            if (Fr === index_js_1.BIGINT_0) {
                pMul = G1_ZERO;
            }
            else {
                pMul = G1.multiplyUnsafe(Fr);
            }
            pRes = pRes.add(pMul);
        }
        return BLS12_381_FromG1Point(pRes);
    }
    msmG2(input) {
        // Note: This implementation is using the naive "algorithm" of just doing
        // p1G1*v1F1 + p2G1*v1F1 + ... while the EIP is suggesting to use an optimized
        // algorithm (Pippenger's algorithm, see https://eips.ethereum.org/EIPS/eip-2537#g1g2-msm).
        //
        // While this functionally works the approach is not "gas-cost-competitive" and an
        // optimization should be considered in the future.
        const pairLength = 288;
        const numPairs = input.length / pairLength;
        let pRes = G2_ZERO;
        for (let k = 0; k < numPairs; k++) {
            const pairStart = pairLength * k;
            const G2 = BLS12_381_ToG2Point(input.subarray(pairStart, pairStart + constants_js_1.BLS_G2_POINT_BYTE_LENGTH));
            const Fr = BLS12_381_ToFrPoint(input.subarray(pairStart + constants_js_1.BLS_G2_POINT_BYTE_LENGTH, pairStart + pairLength));
            let pMul;
            if (Fr === index_js_1.BIGINT_0) {
                pMul = G2_ZERO;
            }
            else {
                pMul = G2.multiplyUnsafe(Fr);
            }
            pRes = pRes.add(pMul);
        }
        return BLS12_381_FromG2Point(pRes);
    }
    pairingCheck(input) {
        // Extract the pairs from the input
        const pairLength = 384;
        const pairs = [];
        for (let k = 0; k < input.length / pairLength; k++) {
            const pairStart = pairLength * k;
            const G1 = BLS12_381_ToG1Point(input.subarray(pairStart, pairStart + constants_js_1.BLS_G1_POINT_BYTE_LENGTH));
            const g2start = pairStart + constants_js_1.BLS_G1_POINT_BYTE_LENGTH;
            const G2 = BLS12_381_ToG2Point(input.subarray(g2start, g2start + constants_js_1.BLS_G2_POINT_BYTE_LENGTH));
            pairs.push({ g1: G1, g2: G2 });
        }
        // NOTE: check for point of infinity should happen only after all points parsed (in case they are malformed)
        for (const { g1, g2 } of pairs) {
            const _g2 = g2;
            // EIP: "If any input is the infinity point, pairing result will be 1"
            if (g1.equals(G1_ZERO) || _g2.equals(G2_ZERO)) {
                return constants_js_1.BLS_ONE_BUFFER;
            }
        }
        // @ts-ignore
        const FP12 = bls_js_1.bls12_381.pairingBatch(pairs, true);
        if (bls_js_1.bls12_381.fields.Fp12.eql(FP12, bls_js_1.bls12_381.fields.Fp12.ONE)) {
            return constants_js_1.BLS_ONE_BUFFER;
        }
        else {
            return constants_js_1.BLS_ZERO_BUFFER;
        }
    }
}
exports.NobleBLS = NobleBLS;
//# sourceMappingURL=noble.js.map