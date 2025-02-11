import { hexToBytes, Address, Account } from '../../../libs/util/dist/esm/index.js';
import { keccak256 } from 'ethereum-cryptography/keccak';

interface StorageItem {
    astId: number;
    contract: string;
    label: string;
    offset: number;
    slot: string;
    type: string;
}

interface StorageLayout {
    storageLayout: {
        storage: StorageItem[];
        types: {
            [key: string]: {
                encoding: string;
                label: string;
                numberOfBytes: string;
                key?: string;
                value?: string;
            };
        };
    };
}

export const setupEVMFromCalldata = async (
    evm: any,
    contractAddr: Address,
    contractCode: Uint8Array,
    storageLayout: StorageLayout,
    calldata: string,
    sender: Address,
) => {
    // Create contract account and deploy code
    await evm.stateManager.putAccount(contractAddr, new Account());
    await evm.stateManager.putCode(contractAddr, contractCode);

    const selector = calldata.slice(0, 10);
    const params = calldata.slice(10);

    // Find relevant storage slots from layout
    const findSlot = (labelToFind: string) => {
        const item = storageLayout.storageLayout.storage.find(item => item.label === labelToFind);
        // if (!item) throw new Error(`Storage slot not found for ${labelToFind}`);
        return item;
    };

    switch (selector) {
        // transfer(address,uint256)
        case '0xa9059cbb': {
            const recipient = '0x' + params.slice(24, 64);
            const amount = BigInt('0x' + params.slice(64));
            
            // Find balances mapping slot from layout
            const balancesItem = findSlot('_balances'); 
            // If not found, try alternative names
            const balanceSlot = balancesItem?.slot || 
                              findSlot('balances')?.slot || 
                findSlot('_balance')?.slot;
           
            console.log("balanceSlot", balanceSlot);
            
            if (balanceSlot === undefined) throw new Error(`Storage slot not found for _balances`);
            
            const senderBalanceSlot = keccak256(
                hexToBytes(
                    '0x' + sender.toString().slice(2).padStart(64, '0') + 
                    balanceSlot.padStart(64, '0'),
                ),
            );
            
            await evm.stateManager.putStorage(
                contractAddr,
                senderBalanceSlot,
                hexToBytes('0x' + amount.toString(16).padStart(64, '0')),
            );
            break;
        }

        // approve(address,uint256)
        case '0x095ea7b3': {
            const spender = '0x' + params.slice(24, 64);
            const amount = BigInt('0x' + params.slice(64));
            
            // Find allowances mapping slot from layout
            const allowancesItem = findSlot('_allowances') || // TON uses '_allowances'
                                 findSlot('allowed') ||       // Some tokens use 'allowed'
                                 findSlot('allowances');      // Others might use 'allowances'
            
            const allowanceSlot = allowancesItem.slot;
            
            const ownerKey = keccak256(
                hexToBytes(
                    '0x' + sender.toString().slice(2).padStart(64, '0') + 
                    allowanceSlot.padStart(64, '0'),
                ),
            );
            const spenderKey = keccak256(
                hexToBytes(
                    '0x' + spender.slice(2).padStart(64, '0') + 
                    ownerKey.toString('hex').padStart(64, '0'),
                ),
            );
            
            await evm.stateManager.putStorage(
                contractAddr,
                spenderKey,
                hexToBytes('0x' + amount.toString(16).padStart(64, '0')),
            );
            break;
        }

        // transferFrom(address,address,uint256)
        case '0x23b872dd': {
            const from = '0x' + params.slice(24, 64);
            const to = '0x' + params.slice(88, 128);
            const amount = BigInt('0x' + params.slice(128));
            
            // Find balances mapping slot
            const balancesItem = findSlot('_balances') || 
                               findSlot('balances') || 
                               findSlot('_balance');
            const balanceSlot = balancesItem.slot;
            
            // Setup from balance
            const fromBalanceSlot = keccak256(
                hexToBytes(
                    '0x' + from.slice(2).padStart(64, '0') + 
                    balanceSlot.padStart(64, '0'),
                ),
            );
            
            await evm.stateManager.putStorage(
                contractAddr,
                fromBalanceSlot,
                hexToBytes('0x' + amount.toString(16).padStart(64, '0')),
            );
            
            // Find and setup allowance
            const allowancesItem = findSlot('_allowances') || 
                                 findSlot('allowed') || 
                                 findSlot('allowances');
            const allowanceSlot = allowancesItem.slot;
            
            const ownerKey = keccak256(
                hexToBytes(
                    '0x' + from.slice(2).padStart(64, '0') + 
                    allowanceSlot.padStart(64, '0'),
                ),
            );
            const spenderKey = keccak256(
                hexToBytes(
                    '0x' + sender.toString().slice(2).padStart(64, '0') + 
                    ownerKey.toString('hex').padStart(64, '0'),
                ),
            );
            
            await evm.stateManager.putStorage(
                contractAddr,
                spenderKey,
                hexToBytes('0x' + amount.toString(16).padStart(64, '0')),
            );
            break;
        }
    }
};