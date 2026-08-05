pragma circom 2.1.6;

include "./transaction_signature_fixed_base_extended_window.circom";

template FixedBaseExtendedWindowScalarMulTest(N, W) {
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = FixedG8ExtendedWindowScalarMulFromConstrainedBits_unsafe(N, W);
    core.bits <== scalarBits.out;

    component affine = ExtendedJubjubToAffine_unsafe();
    affine.point <== core.result;
    result <== affine.affine;
}
