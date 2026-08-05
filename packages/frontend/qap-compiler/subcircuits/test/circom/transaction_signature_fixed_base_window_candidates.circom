pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";

template FixedG8WindowScalarMulTest(N, W) {
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = FixedG8WindowScalarMulFromConstrainedBits_unsafe(N, W);
    core.bits <== scalarBits.out;
    result <== core.result;
}

template FixedG8BinaryScalarMulTest(N) {
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = JubjubScalarMulFromConstrainedBits_unsafe(N);
    core.identity <== [0, 1];
    core.base <== [
        52363696936650001301287582521711853146588465673974699354184720335305084401224,
        12024993157431732930272824407495979791132374572895036891122288541794509830761
    ];
    core.bits <== scalarBits.out;
    result <== core.result;
}
