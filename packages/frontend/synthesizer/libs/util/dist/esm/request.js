import { RLP } from '@ethereumjs/rlp';
import { concatBytes } from 'ethereum-cryptography/utils';
import { bigIntToBytes, bigIntToHex, bytesToBigInt, bytesToHex, hexToBigInt, hexToBytes, } from './bytes.js';
import { BIGINT_0 } from './constants.js';
export var CLRequestType;
(function (CLRequestType) {
    CLRequestType[CLRequestType["Deposit"] = 0] = "Deposit";
    CLRequestType[CLRequestType["Withdrawal"] = 1] = "Withdrawal";
    CLRequestType[CLRequestType["Consolidation"] = 2] = "Consolidation";
})(CLRequestType = CLRequestType || (CLRequestType = {}));
export class CLRequest {
    constructor(type) {
        this.type = type;
    }
}
export class DepositRequest extends CLRequest {
    constructor(pubkey, withdrawalCredentials, amount, signature, index) {
        super(CLRequestType.Deposit);
        this.pubkey = pubkey;
        this.withdrawalCredentials = withdrawalCredentials;
        this.amount = amount;
        this.signature = signature;
        this.index = index;
    }
    serialize() {
        const indexBytes = this.index === BIGINT_0 ? new Uint8Array() : bigIntToBytes(this.index);
        const amountBytes = this.amount === BIGINT_0 ? new Uint8Array() : bigIntToBytes(this.amount);
        return concatBytes(Uint8Array.from([this.type]), RLP.encode([
            this.pubkey,
            this.withdrawalCredentials,
            amountBytes,
            this.signature,
            indexBytes,
        ]));
    }
    toJSON() {
        return {
            pubkey: bytesToHex(this.pubkey),
            withdrawalCredentials: bytesToHex(this.withdrawalCredentials),
            amount: bigIntToHex(this.amount),
            signature: bytesToHex(this.signature),
            index: bigIntToHex(this.index),
        };
    }
}
export class WithdrawalRequest extends CLRequest {
    constructor(sourceAddress, validatorPubkey, amount) {
        super(CLRequestType.Withdrawal);
        this.sourceAddress = sourceAddress;
        this.validatorPubkey = validatorPubkey;
        this.amount = amount;
    }
    serialize() {
        const amountBytes = this.amount === BIGINT_0 ? new Uint8Array() : bigIntToBytes(this.amount);
        return concatBytes(Uint8Array.from([this.type]), RLP.encode([this.sourceAddress, this.validatorPubkey, amountBytes]));
    }
    toJSON() {
        return {
            sourceAddress: bytesToHex(this.sourceAddress),
            validatorPubkey: bytesToHex(this.validatorPubkey),
            amount: bigIntToHex(this.amount),
        };
    }
}
export class ConsolidationRequest extends CLRequest {
    constructor(sourceAddress, sourcePubkey, targetPubkey) {
        super(CLRequestType.Consolidation);
        this.sourceAddress = sourceAddress;
        this.sourcePubkey = sourcePubkey;
        this.targetPubkey = targetPubkey;
    }
    serialize() {
        return concatBytes(Uint8Array.from([this.type]), RLP.encode([this.sourceAddress, this.sourcePubkey, this.targetPubkey]));
    }
    toJSON() {
        return {
            sourceAddress: bytesToHex(this.sourceAddress),
            sourcePubkey: bytesToHex(this.sourcePubkey),
            targetPubkey: bytesToHex(this.targetPubkey),
        };
    }
}
export function createDepositRequest(depositData) {
    const { pubkey, withdrawalCredentials, amount, signature, index } = depositData;
    return new DepositRequest(pubkey, withdrawalCredentials, amount, signature, index);
}
export function createDepositRequestFromJSON(jsonData) {
    const { pubkey, withdrawalCredentials, amount, signature, index } = jsonData;
    return createDepositRequest({
        pubkey: hexToBytes(pubkey),
        withdrawalCredentials: hexToBytes(withdrawalCredentials),
        amount: hexToBigInt(amount),
        signature: hexToBytes(signature),
        index: hexToBigInt(index),
    });
}
export function createDepositRequestFromRLP(bytes) {
    const [pubkey, withdrawalCredentials, amount, signature, index] = RLP.decode(bytes);
    return createDepositRequest({
        pubkey,
        withdrawalCredentials,
        amount: bytesToBigInt(amount),
        signature,
        index: bytesToBigInt(index),
    });
}
export function createWithdrawalRequest(withdrawalData) {
    const { sourceAddress, validatorPubkey, amount } = withdrawalData;
    return new WithdrawalRequest(sourceAddress, validatorPubkey, amount);
}
export function createWithdrawalRequestFromJSON(jsonData) {
    const { sourceAddress, validatorPubkey, amount } = jsonData;
    return createWithdrawalRequest({
        sourceAddress: hexToBytes(sourceAddress),
        validatorPubkey: hexToBytes(validatorPubkey),
        amount: hexToBigInt(amount),
    });
}
export function createWithdrawalRequestFromRLP(bytes) {
    const [sourceAddress, validatorPubkey, amount] = RLP.decode(bytes);
    return createWithdrawalRequest({
        sourceAddress,
        validatorPubkey,
        amount: bytesToBigInt(amount),
    });
}
export function createConsolidationRequest(consolidationData) {
    const { sourceAddress, sourcePubkey, targetPubkey } = consolidationData;
    return new ConsolidationRequest(sourceAddress, sourcePubkey, targetPubkey);
}
export function createConsolidationRequestFromJSON(jsonData) {
    const { sourceAddress, sourcePubkey, targetPubkey } = jsonData;
    return createConsolidationRequest({
        sourceAddress: hexToBytes(sourceAddress),
        sourcePubkey: hexToBytes(sourcePubkey),
        targetPubkey: hexToBytes(targetPubkey),
    });
}
export function createConsolidationRequestFromRLP(bytes) {
    const [sourceAddress, sourcePubkey, targetPubkey] = RLP.decode(bytes);
    return createConsolidationRequest({
        sourceAddress,
        sourcePubkey,
        targetPubkey,
    });
}
export class CLRequestFactory {
    static fromSerializedRequest(bytes) {
        switch (bytes[0]) {
            case CLRequestType.Deposit:
                return createDepositRequestFromRLP(bytes.subarray(1));
            case CLRequestType.Withdrawal:
                return createWithdrawalRequestFromRLP(bytes.subarray(1));
            case CLRequestType.Consolidation:
                return createConsolidationRequestFromRLP(bytes.subarray(1));
            default:
                throw Error(`Invalid request type=${bytes[0]}`);
        }
    }
}
//# sourceMappingURL=request.js.map