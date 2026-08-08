pragma circom 2.1.6;

include "../../../templates/255bit/transaction_signature.circom";

template TransactionSignatureProductionComposition(N) {
    assert(N == 29);

    signal input privateIn[N + 5];
    signal input contractAddress;
    signal input functionSelector;
    signal input S;
    signal input O[2];
    signal output evmContractAddress[2];
    signal output evmFunctionSelector[2];
    signal output origin[2];

    signal challengeInputs[N + 7];
    for (var index = 0; index < 5; index++) {
        challengeInputs[index] <== privateIn[index];
    }
    challengeInputs[5] <== contractAddress;
    challengeInputs[6] <== functionSelector;
    for (var index = 0; index < N; index++) {
        challengeInputs[7 + index] <== privateIn[5 + index];
    }

    component challengeBatches[8];
    for (var batch = 0; batch < 8; batch++) {
        challengeBatches[batch] = TransactionSignaturePoseidonBatch4();
        challengeBatches[batch].in[0] <== 1;
        if (batch == 0) {
            challengeBatches[batch].in[1] <== challengeInputs[0];
        } else {
            challengeBatches[batch].in[1] <== challengeBatches[batch - 1].out[1];
        }
        challengeBatches[batch].in[2] <== challengeInputs[4 * batch + 1];
        challengeBatches[batch].in[3] <== 0;
        challengeBatches[batch].in[4] <== challengeInputs[4 * batch + 2];
        challengeBatches[batch].in[5] <== challengeInputs[4 * batch + 3];
        challengeBatches[batch].in[6] <== challengeInputs[4 * batch + 4];
    }

    component finalHashBatch = TransactionSignaturePoseidonBatch4();
    finalHashBatch.in[0] <== 0;
    finalHashBatch.in[1] <== challengeInputs[2];
    finalHashBatch.in[2] <== challengeInputs[3];
    finalHashBatch.in[3] <== challengeBatches[7].out[1];
    finalHashBatch.in[4] <== challengeInputs[33];
    finalHashBatch.in[5] <== challengeInputs[34];
    finalHashBatch.in[6] <== challengeInputs[35];

    component pointPolicy = TransactionSignaturePointPolicy();
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        pointPolicy.in[coordinate] <== challengeInputs[coordinate];
    }
    pointPolicy.in[4] <== contractAddress;
    pointPolicy.in[5] <== functionSelector;
    pointPolicy.in[6] <== O[0];
    pointPolicy.in[7] <== O[1];
    evmContractAddress <== [pointPolicy.out[0], pointPolicy.out[1]];
    evmFunctionSelector <== [pointPolicy.out[2], pointPolicy.out[3]];

    component fixedPrefix = TransactionSignatureFixedPrefix70();
    fixedPrefix.in[0] <== S;

    component challengePrefix = TransactionSignatureChallengeVariablePrefix();
    challengePrefix.in[0] <== finalHashBatch.out[1];
    for (var coordinate = 0; coordinate < 8; coordinate++) {
        challengePrefix.in[1 + coordinate] <== pointPolicy.out[4 + coordinate];
    }

    component variableBatches[3];
    var challengeStarts[3] = [154, 86, 18];
    for (var batch = 0; batch < 3; batch++) {
        variableBatches[batch] = TransactionSignatureVariableBatch();
        for (var bit = 0; bit < 68; bit++) {
            variableBatches[batch].in[bit] <==
                challengePrefix.out[challengeStarts[batch] + bit];
        }
        for (var coordinate = 0; coordinate < 8; coordinate++) {
            variableBatches[batch].in[68 + coordinate] <==
                pointPolicy.out[4 + coordinate];
        }
        for (var coordinate = 0; coordinate < 4; coordinate++) {
            if (batch == 0) {
                variableBatches[batch].in[76 + coordinate] <==
                    challengePrefix.out[222 + coordinate];
            } else {
                variableBatches[batch].in[76 + coordinate] <==
                    variableBatches[batch - 1].out[coordinate];
            }
        }
    }

    component final = TransactionSignatureFinal();
    for (var bit = 0; bit < 42; bit++) {
        final.in[bit] <== fixedPrefix.out[bit];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[42 + coordinate] <== fixedPrefix.out[42 + coordinate];
    }
    for (var bit = 0; bit < 18; bit++) {
        final.in[46 + bit] <== challengePrefix.out[bit];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[64 + coordinate] <== variableBatches[2].out[coordinate];
    }
    for (var coordinate = 0; coordinate < 8; coordinate++) {
        final.in[68 + coordinate] <== pointPolicy.out[4 + coordinate];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[76 + coordinate] <== pointPolicy.out[12 + coordinate];
    }
    final.in[80] <== finalHashBatch.out[0];
    origin <== final.out;
}

component main {public [contractAddress, functionSelector, S, O]} =
    TransactionSignatureProductionComposition(nPrivateMessageInputs());
