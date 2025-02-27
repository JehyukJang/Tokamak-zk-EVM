<<<<<<< HEAD
/**
 * Run this file with:
 * DEBUG=ethjs,evm:*,evm:*:* tsx erc20-transfer.ts
 */

import { Account, Address, hexToBytes } from "@ethereumjs/util/index.js"
import { keccak256 } from 'ethereum-cryptography/keccak'

import { createEVM } from '../../src/constructors.js'
import { finalize } from '../../src/tokamak/core/finalize.js'

function formatLogs(logs: any) {
    logs.forEach((log: any, index: any) => {
        console.log('\nTransaction Receipt Event Logs:');
        console.log('─'.repeat(50));
        console.log('address:', `0x${Buffer.from(log[0]).toString('hex')}`);
        console.log('topics:');
        log[1].forEach((topic: any, i: any) => {
            const topicHex = `0x${Buffer.from(topic).toString('hex')}`;
            if (i === 0) {
                console.log(`[0] ${topicHex}`);
                console.log('    Transfer(address indexed from, address indexed to, uint256 value)');
            } else if (i === 1) {
                console.log(`[1] ${topicHex}`);
                console.log('    From: 0x' + topicHex.slice(-40));
            } else if (i === 2) {
                console.log(`[2] ${topicHex}`);
                console.log('    To: 0x' + topicHex.slice(-40));
            }
        });
        
        const dataHex = `0x${Buffer.from(log[2]).toString('hex')}`;
        console.log('data:', dataHex);
        console.log('    Value:', parseInt(dataHex, 16).toString(), 'tokens');
    });
}

// ERC20 contract bytecode
const contractCode = hexToBytes(
  '0x6080604052600436106101ac5760003560e01c80636e9960c3116100ec578063b01b0ef71161008a578063dc2173f311610064578063dc2173f31461082b578063dcdf5158146108e2578063dd62ed3e14610974578063e18aa335146109af576101ac565b8063b01b0ef71461070c578063bb1e23cb14610721578063cae9ca51146107a6576101ac565b80638f283970116100c65780638f2839701461066557806395d89b41146101b1578063a9059cbb14610698578063ac9fe421146106d1576101ac565b80636e9960c3146104dc57806370a082311461050d5780637dd711c414610540576101ac565b80632b9917461161015957806342966c681161013357806342966c681461041157806361247de31461043b578063654b748a1461046e578063699c834b146104a1576101ac565b80632b99174614610360578063313ce567146103a35780633b7b5a16146103ce576101ac565b806318160ddd1161018a57806318160ddd146102bd5780631dd319cb146102e457806323b872dd1461031d576101ac565b806306fdde03146101b15780630819ba741461023b578063095ea7b314610270575b600080fd5b3480156101bd57600080fd5b506101c6610a0c565b6040805160208082528351818301528351919283929083019185019080838360005b838110156102005781810151838201526020016101e8565b50505050905090810190601f16801561022d5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34801561024757600080fd5b5061026e6004803603602081101561025e57600080fd5b50356001600160a01b0316610a43565b005b34801561027c57600080fd5b506102a96004803603604081101561029357600080fd5b506001600160a01b038135169060200135610b0e565b604080519115158252519081900360200190f35b3480156102c957600080fd5b506102d2610b25565b60408051918252519081900360200190f35b3480156102f057600080fd5b506102a96004803603604081101561030757600080fd5b506001600160a01b038135169060200135610b2b565b34801561032957600080fd5b506102a96004803603606081101561034057600080fd5b506001600160a01b03813581169160208101359091169060400135610b37565b34801561036c57600080fd5b506102a96004803603606081101561038357600080fd5b506001600160a01b03813581169160208101359091169060400135610c29565b3480156103af57600080fd5b506103b8610c97565b6040805160ff9092168252519081900360200190f35b3480156103da57600080fd5b506102a9600480360360608110156103f157600080fd5b506001600160a01b03813581169160208101359091169060400135610c9c565b34801561041d57600080fd5b506102a96004803603602081101561043457600080fd5b5035610d0a565b34801561044757600080fd5b506102a96004803603602081101561045e57600080fd5b50356001600160a01b0316610d1e565b34801561047a57600080fd5b506102a96004803603602081101561049157600080fd5b50356001600160a01b0316610d3c565b3480156104ad57600080fd5b5061026e600480360360408110156104c457600080fd5b506001600160a01b0381351690602001351515610d5a565b3480156104e857600080fd5b506104f1610e07565b604080516001600160a01b039092168252519081900360200190f35b34801561051957600080fd5b506102d26004803603602081101561053057600080fd5b50356001600160a01b0316610e16565b34801561054c57600080fd5b506105e2600480360360a081101561056357600080fd5b6001600160a01b03823581169260208101359091169160408201359160608101359181019060a0810160808201356401000000008111156105a357600080fd5b8201836020820111156105b557600080fd5b803590602001918460018302840111640100000000831117156105d757600080fd5b509092509050610e31565b604051808315151515815260200180602001828103825283818151815260200191508051906020019080838360005b83811015610629578181015183820152602001610611565b50505050905090810190601f1680156106565780820380516001836020036101000a031916815260200191505b50935050505060405180910390f35b34801561067157600080fd5b5061026e6004803603602081101561068857600080fd5b50356001600160a01b0316610ed4565b3480156106a457600080fd5b506102a9600480360360408110156106bb57600080fd5b506001600160a01b038135169060200135610fb5565b3480156106dd57600080fd5b5061026e600480360360408110156106f457600080fd5b506001600160a01b0381351690602001351515610fc2565b34801561071857600080fd5b506104f161106f565b6101c66004803603606081101561073757600080fd5b6001600160a01b038235169160208101359181019060608101604082013564010000000081111561076757600080fd5b82018360208201111561077957600080fd5b8035906020019184600183028401116401000000008311171561079b57600080fd5b50909250905061107e565b6101c6600480360360608110156107bc57600080fd5b6001600160a01b03823516916020810135918101906060810160408201356401000000008111156107ec57600080fd5b8201836020820111156107fe57600080fd5b8035906020019184600183028401116401000000008311171561082057600080fd5b509092509050611225565b34801561083757600080fd5b506105e2600480360361010081101561084f57600080fd5b6001600160a01b038235811692602081013582169260408201359260608301359260808101359260a08201359260c0830135169190810190610100810160e08201356401000000008111156108a357600080fd5b8201836020820111156108b557600080fd5b803590602001918460018302840111640100000000831117156108d757600080fd5b5090925090506112c4565b3480156108ee57600080fd5b506105e26004803603606081101561090557600080fd5b6001600160a01b038235169160208101359181019060608101604082013564010000000081111561093557600080fd5b82018360208201111561094757600080fd5b8035906020019184600183028401116401000000008311171561096957600080fd5b509092509050611387565b34801561098057600080fd5b506102d26004803603604081101561099757600080fd5b506001600160a01b0381358116916020013516611456565b3480156109bb57600080fd5b506102a9600480360360e08110156109d257600080fd5b506001600160a01b038135811691602081013582169160408201359160608101359160808201359160a08101359160c09091013516611481565b60408051808201909152600481527f53414e4400000000000000000000000000000000000000000000000000000000602082015290565b6000546001600160a01b03163314610a8c5760405162461bcd60e51b815260040180806020018281038252602d815260200180611bd8602d913960400191505060405180910390fd5b600054604080516001600160a01b039283168152918316602083015280517fb2b670b34860515166c00eba5e2e5fa8116d57091604f37ba24ac8021c7fa1659281900390910190a1600080547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0392909216919091179055565b6000610b1b338484611504565b5060015b92915050565b60045490565b6000610b1b83836115d7565b6000336001600160a01b03851614801590610b6257503360009081526003602052604090205460ff16155b15610c14576001600160a01b03841660009081526006602090815260408083203384529091529020546000198114610c125782811015610be9576040805162461bcd60e51b815260206004820152601860248201527f4e6f7420656e6f7567682066756e647320616c6c6f7765640000000000000000604482015290519081900360640190fd5b6001600160a01b0385166000908152600660209081526040808320338452909152902083820390555b505b610c1f8484846117d8565b5060019392505050565b6000336001600160a01b0385161480610c5157503360009081526003602052604090205460ff165b610c8c5760405162461bcd60e51b8152600401808060200182810382526025815260200180611b0e6025913960400191505060405180910390fd5b610c1f848484611504565b601290565b6000336001600160a01b0385161480610cc457503360009081526003602052604090205460ff165b610cff5760405162461bcd60e51b8152600401808060200182810382526025815260200180611b0e6025913960400191505060405180910390fd5b610c1f84848461190c565b6000610d1633836115d7565b506001919050565b6001600160a01b031660009081526001602052604090205460ff1690565b6001600160a01b031660009081526003602052604090205460ff1690565b6000546001600160a01b03163314610da35760405162461bcd60e51b815260040180806020018281038252603a815260200180611b72603a913960400191505060405180910390fd5b6001600160a01b038216600081815260016020908152604091829020805460ff191685151590811790915582519384529083015280517ffcebaa973ed84808fb785c92941aa4798f3f66923f5a2ff544382db3a9b3a3a29281900390910190a15050565b6002546001600160a01b031690565b6001600160a01b031660009081526005602052604090205490565b3360009081526001602052604081205460609060ff16610e825760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b610ec58888888888888080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061196792505050565b91509150965096945050505050565b6002546001600160a01b03163314610f33576040805162461bcd60e51b815260206004820152601b60248201527f6f6e6c792061646d696e2063616e206368616e67652061646d696e0000000000604482015290519081900360640190fd5b600254604080516001600160a01b039283168152918316602083015280517f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f9281900390910190a1600280547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0392909216919091179055565b6000610b1b3384846117d8565b6002546001600160a01b0316331461100b5760405162461bcd60e51b815260040180806020018281038252602c815260200180611bac602c913960400191505060405180910390fd5b6001600160a01b038216600081815260036020908152604091829020805460ff191685151590811790915582519384529083015280517f44f92d27abdf4cfb6a7d712c3af68f3be086d4ca747ab802c36f67d6790060d89281900390910190a15050565b6000546001600160a01b031690565b60606110c183838080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250339250611a59915050565b611112576040805162461bcd60e51b815260206004820152601560248201527f666972737420706172616d20213d2073656e6465720000000000000000000000604482015290519081900360640190fd5b83156111235761112333868661190c565b60006060866001600160a01b0316348686604051808383808284376040519201945060009350909150508083038185875af1925050503d8060008114611185576040519150601f19603f3d011682016040523d82523d6000602084013e61118a565b606091505b509150915081819061121a5760405162461bcd60e51b81526004018080602001828103825283818151815260200191508051906020019080838360005b838110156111df5781810151838201526020016111c7565b50505050905090810190601f16801561120c5780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b509695505050505050565b606061126883838080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250339250611a59915050565b6112b9576040805162461bcd60e51b815260206004820152601560248201527f666972737420706172616d20213d2073656e6465720000000000000000000000604482015290519081900360640190fd5b611123338686611504565b6000606060005a3360009081526001602052604090205490915060ff1661131c5760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b61135f8c8c8c8c89898080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061196792505050565b90935091508715611378576113788c8a8a848b8b611a84565b50995099975050505050505050565b3360009081526001602052604081205460609060ff166113d85760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b856001600160a01b03168585856040518083838082843760405192019450600093509091505080830381838787f1925050503d8060008114611436576040519150601f19603f3d011682016040523d82523d6000602084013e61143b565b606091505b509092509050603f85045a1161144d57fe5b94509492505050565b6001600160a01b03918216600090815260066020908152604080832093909416825291909152205490565b6000805a3360009081526001602052604090205490915060ff166114d65760405162461bcd60e51b815260040180806020018281038252603f815260200180611b33603f913960400191505060405180910390fd5b6114e18989896117d8565b84156114f5576114f5898787848888611a84565b50600198975050505050505050565b6001600160a01b0383161580159061152457506001600160a01b03821615155b611575576040805162461bcd60e51b815260206004820152601760248201527f43616e6e6f7420617070726f7665207769746820307830000000000000000000604482015290519081900360640190fd5b6001600160a01b03808416600081815260066020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b6000811161162c576040805162461bcd60e51b815260206004820152601460248201527f63616e6e6f74206275726e203020746f6b656e73000000000000000000000000604482015290519081900360640190fd5b336001600160a01b0383161480159061165557503360009081526003602052604090205460ff16155b15611707576001600160a01b0382166000908152600660209081526040808320338452909152902054818110156116d3576040805162461bcd60e51b815260206004820152601860248201527f4e6f7420656e6f7567682066756e647320616c6c6f7765640000000000000000604482015290519081900360640190fd5b8060001914611705576001600160a01b0383166000908152600660209081526040808320338452909152902082820390555b505b6001600160a01b03821660009081526005602052604090205481811015611775576040805162461bcd60e51b815260206004820152601060248201527f4e6f7420656e6f7567682066756e647300000000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b03831660008181526005602090815260408083208686039055600480548790039055805186815290519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a3505050565b6001600160a01b038216611833576040805162461bcd60e51b815260206004820152601260248201527f43616e6e6f742073656e6420746f203078300000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b038316600090815260056020526040902054818110156118a1576040805162461bcd60e51b815260206004820152600f60248201527f6e6f7420656e6f7567682066756e640000000000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b0380851660008181526005602090815260408083208787039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350505050565b600081118015611922575061192082610d3c565b155b15611962576001600160a01b038084166000908152600660209081526040808320938616835292905220548181101561196057611960848484611504565b505b505050565b60006060841561197c5761197c87878761190c565b856001600160a01b031684846040518082805190602001908083835b602083106119d557805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe09092019160209182019101611998565b6001836020036101000a03801982511681845116808217855250505050505090500191505060006040518083038160008787f1925050503d8060008114611a38576040519150601f19603f3d011682016040523d82523d6000602084013e611a3d565b606091505b509092509050603f84045a11611a4f57fe5b9550959350505050565b6000604483511015611a6d57506000610b1f565b5060248201516001600160a01b0382161492915050565b60005a8403905085811115611a965750845b820184810285828281611aa557fe5b0414611af8576040805162461bcd60e51b815260206004820152600860248201527f6f766572666c6f77000000000000000000000000000000000000000000000000604482015290519081900360640190fd5b611b038884836117d8565b505050505050505056fe6d73672e73656e64657220213d206f776e6572202626202173757065724f70657261746f726f6e6c7920657865637574696f6e206f70657261746f727320616c6c6f77656420746f2070657266726f6d207472616e7366657220616e64206368617267656f6e6c7920657865637574696f6e2061646d696e20697320616c6c6f77656420746f2061646420657865637574696f6e206f70657261746f72736f6e6c792061646d696e20697320616c6c6f77656420746f20616464207375706572206f70657261746f72736f6e6c7920657865637574696f6e41646d696e2063616e206368616e676520657865637574696f6e41646d696e6f6e6c7920657865637574696f6e206f70657261746f727320616c6c6f77656420746f2065786563757465206f6e2053414e4420626568616c66a265627a7a72305820c7a438998ba2dc88fc9df905ee2425cd3898a4efc17aeb7ccfef84f57510980864736f6c63430005090032',
)

const main = async () => {
  const evm = await createEVM()

  // 계정 설정
  const contractAddr = new Address(hexToBytes('0x1000000000000000000000000000000000000000'))
  const sender = new Address(hexToBytes('0x2000000000000000000000000000000000000000'))
  const recipient = new Address(hexToBytes('0x3000000000000000000000000000000000000000'))

  // 컨트랙트 계정 생성
  await evm.stateManager.putAccount(contractAddr, new Account())

  // 컨트랙트 코드 배포
  await evm.stateManager.putCode(contractAddr, contractCode)

  // 잔액 설정
  const balanceSlot = '0x5'
  const senderBalanceSlot = keccak256(
    hexToBytes(
      '0x' + sender.toString().slice(2).padStart(64, '0') + balanceSlot.slice(2).padStart(64, '0'),
    ),
  )
  await evm.stateManager.putStorage(
    contractAddr,
    senderBalanceSlot,
    hexToBytes('0x' + '100'.padStart(64, '0')),
  )

  // Now run the transfer
  const transferAmount = BigInt(100)
  const result = await evm.runCode({
    caller: sender,
    to: contractAddr,
    code: contractCode,
    data: hexToBytes(
      '0xa9059cbb' +
        recipient.toString().slice(2).padStart(64, '0') +
        transferAmount.toString(16).padStart(64, '0'),
    ),
  })

      console.log("result", result)
    console.log("****************")
formatLogs(result.logs);

   // Get circuit placements
  console.log('Circuit Placements:', 
    JSON.stringify(result.runState?.synthesizer.placements, null, 2)
  )

  // Generate proof
  const permutation = await finalize(result.runState!.synthesizer.placements, true)
}

void main()
=======
/**
 * Run this file with:
 * DEBUG=ethjs,evm:*,evm:*:* tsx erc20-transfer.ts
 */

import { Account, Address, hexToBytes } from "@synthesizer-libs/util"
import { keccak256 } from 'ethereum-cryptography/keccak'

import { createEVM } from '../../src/constructors.js'
import { finalize } from '../../src/tokamak/core/finalize.js'

function formatLogs(logs: any) {
    logs.forEach((log: any, index: any) => {
        console.log('\nTransaction Receipt Event Logs:');
        console.log('─'.repeat(50));
        console.log('address:', `0x${Buffer.from(log[0]).toString('hex')}`);
        console.log('topics:');
        log[1].forEach((topic: any, i: any) => {
            const topicHex = `0x${Buffer.from(topic).toString('hex')}`;
            if (i === 0) {
                console.log(`[0] ${topicHex}`);
                console.log('    Transfer(address indexed from, address indexed to, uint256 value)');
            } else if (i === 1) {
                console.log(`[1] ${topicHex}`);
                console.log('    From: 0x' + topicHex.slice(-40));
            } else if (i === 2) {
                console.log(`[2] ${topicHex}`);
                console.log('    To: 0x' + topicHex.slice(-40));
            }
        });
        
        const dataHex = `0x${Buffer.from(log[2]).toString('hex')}`;
        console.log('data:', dataHex);
        console.log('    Value:', parseInt(dataHex, 16).toString(), 'tokens');
    });
}

// ERC20 contract bytecode
const contractCode = hexToBytes(
  '0x6080604052600436106101ac5760003560e01c80636e9960c3116100ec578063b01b0ef71161008a578063dc2173f311610064578063dc2173f31461082b578063dcdf5158146108e2578063dd62ed3e14610974578063e18aa335146109af576101ac565b8063b01b0ef71461070c578063bb1e23cb14610721578063cae9ca51146107a6576101ac565b80638f283970116100c65780638f2839701461066557806395d89b41146101b1578063a9059cbb14610698578063ac9fe421146106d1576101ac565b80636e9960c3146104dc57806370a082311461050d5780637dd711c414610540576101ac565b80632b9917461161015957806342966c681161013357806342966c681461041157806361247de31461043b578063654b748a1461046e578063699c834b146104a1576101ac565b80632b99174614610360578063313ce567146103a35780633b7b5a16146103ce576101ac565b806318160ddd1161018a57806318160ddd146102bd5780631dd319cb146102e457806323b872dd1461031d576101ac565b806306fdde03146101b15780630819ba741461023b578063095ea7b314610270575b600080fd5b3480156101bd57600080fd5b506101c6610a0c565b6040805160208082528351818301528351919283929083019185019080838360005b838110156102005781810151838201526020016101e8565b50505050905090810190601f16801561022d5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34801561024757600080fd5b5061026e6004803603602081101561025e57600080fd5b50356001600160a01b0316610a43565b005b34801561027c57600080fd5b506102a96004803603604081101561029357600080fd5b506001600160a01b038135169060200135610b0e565b604080519115158252519081900360200190f35b3480156102c957600080fd5b506102d2610b25565b60408051918252519081900360200190f35b3480156102f057600080fd5b506102a96004803603604081101561030757600080fd5b506001600160a01b038135169060200135610b2b565b34801561032957600080fd5b506102a96004803603606081101561034057600080fd5b506001600160a01b03813581169160208101359091169060400135610b37565b34801561036c57600080fd5b506102a96004803603606081101561038357600080fd5b506001600160a01b03813581169160208101359091169060400135610c29565b3480156103af57600080fd5b506103b8610c97565b6040805160ff9092168252519081900360200190f35b3480156103da57600080fd5b506102a9600480360360608110156103f157600080fd5b506001600160a01b03813581169160208101359091169060400135610c9c565b34801561041d57600080fd5b506102a96004803603602081101561043457600080fd5b5035610d0a565b34801561044757600080fd5b506102a96004803603602081101561045e57600080fd5b50356001600160a01b0316610d1e565b34801561047a57600080fd5b506102a96004803603602081101561049157600080fd5b50356001600160a01b0316610d3c565b3480156104ad57600080fd5b5061026e600480360360408110156104c457600080fd5b506001600160a01b0381351690602001351515610d5a565b3480156104e857600080fd5b506104f1610e07565b604080516001600160a01b039092168252519081900360200190f35b34801561051957600080fd5b506102d26004803603602081101561053057600080fd5b50356001600160a01b0316610e16565b34801561054c57600080fd5b506105e2600480360360a081101561056357600080fd5b6001600160a01b03823581169260208101359091169160408201359160608101359181019060a0810160808201356401000000008111156105a357600080fd5b8201836020820111156105b557600080fd5b803590602001918460018302840111640100000000831117156105d757600080fd5b509092509050610e31565b604051808315151515815260200180602001828103825283818151815260200191508051906020019080838360005b83811015610629578181015183820152602001610611565b50505050905090810190601f1680156106565780820380516001836020036101000a031916815260200191505b50935050505060405180910390f35b34801561067157600080fd5b5061026e6004803603602081101561068857600080fd5b50356001600160a01b0316610ed4565b3480156106a457600080fd5b506102a9600480360360408110156106bb57600080fd5b506001600160a01b038135169060200135610fb5565b3480156106dd57600080fd5b5061026e600480360360408110156106f457600080fd5b506001600160a01b0381351690602001351515610fc2565b34801561071857600080fd5b506104f161106f565b6101c66004803603606081101561073757600080fd5b6001600160a01b038235169160208101359181019060608101604082013564010000000081111561076757600080fd5b82018360208201111561077957600080fd5b8035906020019184600183028401116401000000008311171561079b57600080fd5b50909250905061107e565b6101c6600480360360608110156107bc57600080fd5b6001600160a01b03823516916020810135918101906060810160408201356401000000008111156107ec57600080fd5b8201836020820111156107fe57600080fd5b8035906020019184600183028401116401000000008311171561082057600080fd5b509092509050611225565b34801561083757600080fd5b506105e2600480360361010081101561084f57600080fd5b6001600160a01b038235811692602081013582169260408201359260608301359260808101359260a08201359260c0830135169190810190610100810160e08201356401000000008111156108a357600080fd5b8201836020820111156108b557600080fd5b803590602001918460018302840111640100000000831117156108d757600080fd5b5090925090506112c4565b3480156108ee57600080fd5b506105e26004803603606081101561090557600080fd5b6001600160a01b038235169160208101359181019060608101604082013564010000000081111561093557600080fd5b82018360208201111561094757600080fd5b8035906020019184600183028401116401000000008311171561096957600080fd5b509092509050611387565b34801561098057600080fd5b506102d26004803603604081101561099757600080fd5b506001600160a01b0381358116916020013516611456565b3480156109bb57600080fd5b506102a9600480360360e08110156109d257600080fd5b506001600160a01b038135811691602081013582169160408201359160608101359160808201359160a08101359160c09091013516611481565b60408051808201909152600481527f53414e4400000000000000000000000000000000000000000000000000000000602082015290565b6000546001600160a01b03163314610a8c5760405162461bcd60e51b815260040180806020018281038252602d815260200180611bd8602d913960400191505060405180910390fd5b600054604080516001600160a01b039283168152918316602083015280517fb2b670b34860515166c00eba5e2e5fa8116d57091604f37ba24ac8021c7fa1659281900390910190a1600080547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0392909216919091179055565b6000610b1b338484611504565b5060015b92915050565b60045490565b6000610b1b83836115d7565b6000336001600160a01b03851614801590610b6257503360009081526003602052604090205460ff16155b15610c14576001600160a01b03841660009081526006602090815260408083203384529091529020546000198114610c125782811015610be9576040805162461bcd60e51b815260206004820152601860248201527f4e6f7420656e6f7567682066756e647320616c6c6f7765640000000000000000604482015290519081900360640190fd5b6001600160a01b0385166000908152600660209081526040808320338452909152902083820390555b505b610c1f8484846117d8565b5060019392505050565b6000336001600160a01b0385161480610c5157503360009081526003602052604090205460ff165b610c8c5760405162461bcd60e51b8152600401808060200182810382526025815260200180611b0e6025913960400191505060405180910390fd5b610c1f848484611504565b601290565b6000336001600160a01b0385161480610cc457503360009081526003602052604090205460ff165b610cff5760405162461bcd60e51b8152600401808060200182810382526025815260200180611b0e6025913960400191505060405180910390fd5b610c1f84848461190c565b6000610d1633836115d7565b506001919050565b6001600160a01b031660009081526001602052604090205460ff1690565b6001600160a01b031660009081526003602052604090205460ff1690565b6000546001600160a01b03163314610da35760405162461bcd60e51b815260040180806020018281038252603a815260200180611b72603a913960400191505060405180910390fd5b6001600160a01b038216600081815260016020908152604091829020805460ff191685151590811790915582519384529083015280517ffcebaa973ed84808fb785c92941aa4798f3f66923f5a2ff544382db3a9b3a3a29281900390910190a15050565b6002546001600160a01b031690565b6001600160a01b031660009081526005602052604090205490565b3360009081526001602052604081205460609060ff16610e825760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b610ec58888888888888080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061196792505050565b91509150965096945050505050565b6002546001600160a01b03163314610f33576040805162461bcd60e51b815260206004820152601b60248201527f6f6e6c792061646d696e2063616e206368616e67652061646d696e0000000000604482015290519081900360640190fd5b600254604080516001600160a01b039283168152918316602083015280517f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f9281900390910190a1600280547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0392909216919091179055565b6000610b1b3384846117d8565b6002546001600160a01b0316331461100b5760405162461bcd60e51b815260040180806020018281038252602c815260200180611bac602c913960400191505060405180910390fd5b6001600160a01b038216600081815260036020908152604091829020805460ff191685151590811790915582519384529083015280517f44f92d27abdf4cfb6a7d712c3af68f3be086d4ca747ab802c36f67d6790060d89281900390910190a15050565b6000546001600160a01b031690565b60606110c183838080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250339250611a59915050565b611112576040805162461bcd60e51b815260206004820152601560248201527f666972737420706172616d20213d2073656e6465720000000000000000000000604482015290519081900360640190fd5b83156111235761112333868661190c565b60006060866001600160a01b0316348686604051808383808284376040519201945060009350909150508083038185875af1925050503d8060008114611185576040519150601f19603f3d011682016040523d82523d6000602084013e61118a565b606091505b509150915081819061121a5760405162461bcd60e51b81526004018080602001828103825283818151815260200191508051906020019080838360005b838110156111df5781810151838201526020016111c7565b50505050905090810190601f16801561120c5780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b509695505050505050565b606061126883838080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250339250611a59915050565b6112b9576040805162461bcd60e51b815260206004820152601560248201527f666972737420706172616d20213d2073656e6465720000000000000000000000604482015290519081900360640190fd5b611123338686611504565b6000606060005a3360009081526001602052604090205490915060ff1661131c5760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b61135f8c8c8c8c89898080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061196792505050565b90935091508715611378576113788c8a8a848b8b611a84565b50995099975050505050505050565b3360009081526001602052604081205460609060ff166113d85760405162461bcd60e51b815260040180806020018281038252603a815260200180611c05603a913960400191505060405180910390fd5b856001600160a01b03168585856040518083838082843760405192019450600093509091505080830381838787f1925050503d8060008114611436576040519150601f19603f3d011682016040523d82523d6000602084013e61143b565b606091505b509092509050603f85045a1161144d57fe5b94509492505050565b6001600160a01b03918216600090815260066020908152604080832093909416825291909152205490565b6000805a3360009081526001602052604090205490915060ff166114d65760405162461bcd60e51b815260040180806020018281038252603f815260200180611b33603f913960400191505060405180910390fd5b6114e18989896117d8565b84156114f5576114f5898787848888611a84565b50600198975050505050505050565b6001600160a01b0383161580159061152457506001600160a01b03821615155b611575576040805162461bcd60e51b815260206004820152601760248201527f43616e6e6f7420617070726f7665207769746820307830000000000000000000604482015290519081900360640190fd5b6001600160a01b03808416600081815260066020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b6000811161162c576040805162461bcd60e51b815260206004820152601460248201527f63616e6e6f74206275726e203020746f6b656e73000000000000000000000000604482015290519081900360640190fd5b336001600160a01b0383161480159061165557503360009081526003602052604090205460ff16155b15611707576001600160a01b0382166000908152600660209081526040808320338452909152902054818110156116d3576040805162461bcd60e51b815260206004820152601860248201527f4e6f7420656e6f7567682066756e647320616c6c6f7765640000000000000000604482015290519081900360640190fd5b8060001914611705576001600160a01b0383166000908152600660209081526040808320338452909152902082820390555b505b6001600160a01b03821660009081526005602052604090205481811015611775576040805162461bcd60e51b815260206004820152601060248201527f4e6f7420656e6f7567682066756e647300000000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b03831660008181526005602090815260408083208686039055600480548790039055805186815290519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a3505050565b6001600160a01b038216611833576040805162461bcd60e51b815260206004820152601260248201527f43616e6e6f742073656e6420746f203078300000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b038316600090815260056020526040902054818110156118a1576040805162461bcd60e51b815260206004820152600f60248201527f6e6f7420656e6f7567682066756e640000000000000000000000000000000000604482015290519081900360640190fd5b6001600160a01b0380851660008181526005602090815260408083208787039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350505050565b600081118015611922575061192082610d3c565b155b15611962576001600160a01b038084166000908152600660209081526040808320938616835292905220548181101561196057611960848484611504565b505b505050565b60006060841561197c5761197c87878761190c565b856001600160a01b031684846040518082805190602001908083835b602083106119d557805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe09092019160209182019101611998565b6001836020036101000a03801982511681845116808217855250505050505090500191505060006040518083038160008787f1925050503d8060008114611a38576040519150601f19603f3d011682016040523d82523d6000602084013e611a3d565b606091505b509092509050603f84045a11611a4f57fe5b9550959350505050565b6000604483511015611a6d57506000610b1f565b5060248201516001600160a01b0382161492915050565b60005a8403905085811115611a965750845b820184810285828281611aa557fe5b0414611af8576040805162461bcd60e51b815260206004820152600860248201527f6f766572666c6f77000000000000000000000000000000000000000000000000604482015290519081900360640190fd5b611b038884836117d8565b505050505050505056fe6d73672e73656e64657220213d206f776e6572202626202173757065724f70657261746f726f6e6c7920657865637574696f6e206f70657261746f727320616c6c6f77656420746f2070657266726f6d207472616e7366657220616e64206368617267656f6e6c7920657865637574696f6e2061646d696e20697320616c6c6f77656420746f2061646420657865637574696f6e206f70657261746f72736f6e6c792061646d696e20697320616c6c6f77656420746f20616464207375706572206f70657261746f72736f6e6c7920657865637574696f6e41646d696e2063616e206368616e676520657865637574696f6e41646d696e6f6e6c7920657865637574696f6e206f70657261746f727320616c6c6f77656420746f2065786563757465206f6e2053414e4420626568616c66a265627a7a72305820c7a438998ba2dc88fc9df905ee2425cd3898a4efc17aeb7ccfef84f57510980864736f6c63430005090032',
)

const main = async () => {
  const evm = await createEVM()

  // 계정 설정
  const contractAddr = new Address(hexToBytes('0x1000000000000000000000000000000000000000'))
  const sender = new Address(hexToBytes('0x2000000000000000000000000000000000000000'))
  const recipient = new Address(hexToBytes('0x3000000000000000000000000000000000000000'))

  // 컨트랙트 계정 생성
  await evm.stateManager.putAccount(contractAddr, new Account())

  // 컨트랙트 코드 배포
  await evm.stateManager.putCode(contractAddr, contractCode)

  // 잔액 설정
  const balanceSlot = '0x5'
  const senderBalanceSlot = keccak256(
    hexToBytes(
      '0x' + sender.toString().slice(2).padStart(64, '0') + balanceSlot.slice(2).padStart(64, '0'),
    ),
  )
  await evm.stateManager.putStorage(
    contractAddr,
    senderBalanceSlot,
    hexToBytes('0x' + '100'.padStart(64, '0')),
  )

  // Now run the transfer
  const transferAmount = BigInt(100)
  const result = await evm.runCode({
    caller: sender,
    to: contractAddr,
    code: contractCode,
    data: hexToBytes(
      '0xa9059cbb' +
        recipient.toString().slice(2).padStart(64, '0') +
        transferAmount.toString(16).padStart(64, '0'),
    ),
  })

      console.log("result", result)
    console.log("****************")
formatLogs(result.logs);

   // Get circuit placements
  console.log('Circuit Placements:', 
    JSON.stringify(result.runState?.synthesizer.placements, null, 2)
  )

  // Generate proof
  const permutation = await finalize(result.runState!.synthesizer.placements, true)
}

void main()
>>>>>>> 603bf51d9e02a58183fabb7f7fd08e9580ceef44
