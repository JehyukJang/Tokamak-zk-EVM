pragma circom 2.1.6;

include "./transaction_signature_variable_base_extended_window.circom";

template VariableBaseExtendedWindowScalarMulTest(N, W) {
    signal input identity[2];
    signal input base[2];
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = VariableBaseExtendedWindowScalarMulFromConstrainedBits_unsafe(N, W);
    core.identity <== identity;
    core.base <== base;
    core.bits <== scalarBits.out;

    component affine = ExtendedJubjubToAffine_unsafe();
    affine.point <== core.result;
    result <== affine.affine;
}
