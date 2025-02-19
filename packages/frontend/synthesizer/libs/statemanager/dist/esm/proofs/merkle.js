import { createMPTFromProof, createMerkleProof, updateMPTFromMerkleProof, verifyMerkleProof, } from '@synthesizer-libs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { KECCAK256_NULL, KECCAK256_NULL_S, KECCAK256_RLP, KECCAK256_RLP_S, bigIntToHex, bytesToHex, createAccountFromRLP, createAddressFromString, equalsBytes, hexToBytes, setLengthLeft, unpadBytes, } from '@ethereumjs/util';
import { MerkleStateManager } from '../merkleStateManager.js';
/**
 * Get an EIP-1186 proof
 * @param address address to get proof of
 * @param storageSlots storage slots to get proof of
 */
export async function getMerkleStateProof(sm, address, storageSlots = []) {
    await sm['flush']();
    const account = await sm.getAccount(address);
    if (!account) {
        const returnValue = {
            address: address.toString(),
            balance: '0x0',
            codeHash: KECCAK256_NULL_S,
            nonce: '0x0',
            storageHash: KECCAK256_RLP_S,
            accountProof: (await createMerkleProof(sm['_trie'], address.bytes)).map((p) => bytesToHex(p)),
            storageProof: [],
        };
        return returnValue;
    }
    const accountProof = (await createMerkleProof(sm['_trie'], address.bytes)).map((p) => bytesToHex(p));
    const storageProof = [];
    const storageTrie = sm['_getStorageTrie'](address, account);
    for (const storageKey of storageSlots) {
        const proof = (await createMerkleProof(storageTrie, storageKey)).map((p) => bytesToHex(p));
        const value = bytesToHex(await sm.getStorage(address, storageKey));
        const proofItem = {
            key: bytesToHex(storageKey),
            value: value === '0x' ? '0x0' : value,
            proof,
        };
        storageProof.push(proofItem);
    }
    const returnValue = {
        address: address.toString(),
        balance: bigIntToHex(account.balance),
        codeHash: bytesToHex(account.codeHash),
        nonce: bigIntToHex(account.nonce),
        storageHash: bytesToHex(account.storageRoot),
        accountProof,
        storageProof,
    };
    return returnValue;
}
/**
 * Adds a storage proof to the state manager
 * @param storageProof The storage proof
 * @param storageHash The root hash of the storage trie
 * @param address The address
 * @param safe Whether or not to verify if the reported roots match the current storage root
 */
export async function addMerkleStateStorageProof(sm, storageProof, storageHash, address, safe = false) {
    const trie = sm['_getStorageTrie'](address);
    trie.root(hexToBytes(storageHash));
    for (let i = 0; i < storageProof.length; i++) {
        await updateMPTFromMerkleProof(trie, storageProof[i].proof.map((e) => hexToBytes(e)), safe);
    }
}
/**
 * Create a StateManager and initialize this with proof(s) gotten previously from getProof
 * This generates a (partial) StateManager where one can retrieve all items from the proof
 * @param proof Either a proof retrieved from `getProof`, or an array of those proofs
 * @param safe Whether or not to verify that the roots of the proof items match the reported roots
 * @param opts a dictionary of StateManager opts
 * @returns A new MerkleStateManager with elements from the given proof included in its backing state trie
 */
export async function fromMerkleStateProof(proof, safe = false, opts = {}) {
    if (Array.isArray(proof)) {
        if (proof.length === 0) {
            return new MerkleStateManager(opts);
        }
        else {
            const trie = opts.trie ??
                (await createMPTFromProof(proof[0].accountProof.map((e) => hexToBytes(e)), { useKeyHashing: true }));
            const sm = new MerkleStateManager({ ...opts, trie });
            const address = createAddressFromString(proof[0].address);
            await addMerkleStateStorageProof(sm, proof[0].storageProof, proof[0].storageHash, address, safe);
            for (let i = 1; i < proof.length; i++) {
                const proofItem = proof[i];
                await addMerkleStateProofData(sm, proofItem, true);
            }
            await sm.flush(); // TODO verify if this is necessary
            return sm;
        }
    }
    else {
        return fromMerkleStateProof([proof], safe, opts);
    }
}
/**
 * Add proof(s) into an already existing trie
 * @param proof The proof(s) retrieved from `getProof`
 * @param verifyRoot verify that all proof root nodes match statemanager's stateroot - should be
 * set to `false` when constructing a state manager where the underlying trie has proof nodes from different state roots
 */
export async function addMerkleStateProofData(sm, proof, safe = false) {
    if (Array.isArray(proof)) {
        for (let i = 0; i < proof.length; i++) {
            await updateMPTFromMerkleProof(sm['_trie'], proof[i].accountProof.map((e) => hexToBytes(e)), safe);
            await addMerkleStateStorageProof(sm, proof[i].storageProof, proof[i].storageHash, createAddressFromString(proof[i].address), safe);
        }
    }
    else {
        await addMerkleStateProofData(sm, [proof], safe);
    }
}
/**
 * Verify an EIP-1186 proof. Throws if proof is invalid, otherwise returns true.
 * @param proof the proof to prove
 */
export async function verifyMerkleStateProof(sm, proof) {
    const key = hexToBytes(proof.address);
    const accountProof = proof.accountProof.map((rlpString) => hexToBytes(rlpString));
    // This returns the account if the proof is valid.
    // Verify that it matches the reported account.
    const value = await verifyMerkleProof(key, accountProof, {
        useKeyHashing: true,
    });
    if (value === null) {
        // Verify that the account is empty in the proof.
        const emptyBytes = new Uint8Array(0);
        const notEmptyErrorMsg = 'Invalid proof provided: account is not empty';
        const nonce = unpadBytes(hexToBytes(proof.nonce));
        if (!equalsBytes(nonce, emptyBytes)) {
            throw new Error(`${notEmptyErrorMsg} (nonce is not zero)`);
        }
        const balance = unpadBytes(hexToBytes(proof.balance));
        if (!equalsBytes(balance, emptyBytes)) {
            throw new Error(`${notEmptyErrorMsg} (balance is not zero)`);
        }
        const storageHash = hexToBytes(proof.storageHash);
        if (!equalsBytes(storageHash, KECCAK256_RLP)) {
            throw new Error(`${notEmptyErrorMsg} (storageHash does not equal KECCAK256_RLP)`);
        }
        const codeHash = hexToBytes(proof.codeHash);
        if (!equalsBytes(codeHash, KECCAK256_NULL)) {
            throw new Error(`${notEmptyErrorMsg} (codeHash does not equal KECCAK256_NULL)`);
        }
    }
    else {
        const account = createAccountFromRLP(value);
        const { nonce, balance, storageRoot, codeHash } = account;
        const invalidErrorMsg = 'Invalid proof provided:';
        if (nonce !== BigInt(proof.nonce)) {
            throw new Error(`${invalidErrorMsg} nonce does not match`);
        }
        if (balance !== BigInt(proof.balance)) {
            throw new Error(`${invalidErrorMsg} balance does not match`);
        }
        if (!equalsBytes(storageRoot, hexToBytes(proof.storageHash))) {
            throw new Error(`${invalidErrorMsg} storageHash does not match`);
        }
        if (!equalsBytes(codeHash, hexToBytes(proof.codeHash))) {
            throw new Error(`${invalidErrorMsg} codeHash does not match`);
        }
    }
    for (const stProof of proof.storageProof) {
        const storageProof = stProof.proof.map((value) => hexToBytes(value));
        const storageValue = setLengthLeft(hexToBytes(stProof.value), 32);
        const storageKey = hexToBytes(stProof.key);
        const proofValue = await verifyMerkleProof(storageKey, storageProof, {
            useKeyHashing: true,
        });
        const reportedValue = setLengthLeft(RLP.decode(proofValue ?? new Uint8Array(0)), 32);
        if (!equalsBytes(reportedValue, storageValue)) {
            throw new Error(`Reported trie value does not match storage, key: ${stProof.key}, reported: ${bytesToHex(reportedValue)}, actual: ${bytesToHex(storageValue)}`);
        }
    }
    return true;
}
//# sourceMappingURL=merkle.js.map