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
    signal output evmTransactionInputs[N][2];
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

    component transactionInputViews[N];
    for (var index = 0; index < N; index++) {
        transactionInputViews[index] = TransactionSignatureCanonicalFrView();
        transactionInputViews[index].in[0] <== challengeInputs[7 + index];
        evmTransactionInputs[index][0] <== transactionInputViews[index].out[255];
        evmTransactionInputs[index][1] <== transactionInputViews[index].out[256];
    }
    component challengeView = TransactionSignatureCanonicalFrView();
    challengeView.in[0] <== finalHashBatch.out[1];
    component publicKeyHashView = TransactionSignatureCanonicalFrView();
    publicKeyHashView.in[0] <== finalHashBatch.out[0];

    component policy = TransactionSignaturePolicyFixedPrefix();
    for (var index = 0; index < 4; index++) {
        policy.in[index] <== challengeInputs[index];
    }
    policy.in[4] <== contractAddress;
    policy.in[5] <== functionSelector;
    policy.in[6] <== S;
    policy.in[7] <== O[0];
    policy.in[8] <== O[1];
    evmContractAddress <== [policy.out[0], policy.out[1]];
    evmFunctionSelector <== [policy.out[2], policy.out[3]];

    component bridge = TransactionSignatureFixedVariableBridge();
    for (var bit = 0; bit < 114; bit++) {
        bridge.in[bit] <== policy.out[4 + bit];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        bridge.in[114 + coordinate] <== policy.out[145 + coordinate];
    }
    for (var bit = 0; bit < 33; bit++) {
        bridge.in[118 + bit] <== challengeView.out[222 + bit];
    }
    for (var coordinate = 0; coordinate < 8; coordinate++) {
        bridge.in[151 + coordinate] <== policy.out[149 + coordinate];
    }

    component variableBatches[3];
    var challengeStarts[3] = [154, 86, 18];
    for (var batch = 0; batch < 3; batch++) {
        variableBatches[batch] = TransactionSignatureVariableBatch();
        for (var bit = 0; bit < 68; bit++) {
            variableBatches[batch].in[bit] <==
                challengeView.out[challengeStarts[batch] + bit];
        }
        for (var coordinate = 0; coordinate < 8; coordinate++) {
            variableBatches[batch].in[68 + coordinate] <== policy.out[149 + coordinate];
        }
        for (var coordinate = 0; coordinate < 4; coordinate++) {
            if (batch == 0) {
                variableBatches[batch].in[76 + coordinate] <== bridge.out[4 + coordinate];
            } else {
                variableBatches[batch].in[76 + coordinate] <==
                    variableBatches[batch - 1].out[coordinate];
            }
        }
    }

    component final = TransactionSignatureFinal();
    for (var bit = 0; bit < 27; bit++) {
        final.in[bit] <== policy.out[118 + bit];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[27 + coordinate] <== bridge.out[coordinate];
    }
    for (var bit = 0; bit < 18; bit++) {
        final.in[31 + bit] <== challengeView.out[bit];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[49 + coordinate] <== variableBatches[2].out[coordinate];
    }
    for (var coordinate = 0; coordinate < 8; coordinate++) {
        final.in[53 + coordinate] <== policy.out[149 + coordinate];
    }
    for (var coordinate = 0; coordinate < 4; coordinate++) {
        final.in[61 + coordinate] <== policy.out[157 + coordinate];
    }
    for (var bit = 0; bit < 160; bit++) {
        final.in[65 + bit] <== publicKeyHashView.out[bit];
    }
    origin <== final.out;
}

component main {public [contractAddress, functionSelector, S, O]} =
    TransactionSignatureProductionComposition(nPrivateMessageInputs());
