import { hexToBytes } from "@synthesizer-libs/util";

//ERC20 contract
export const TON_CONTRACT_CODE = hexToBytes(
  '0x608060405234801561001057600080fd5b50600436106101c45760003560e01c806370a08231116100f95780639865027511610097578063aa271e1a11610071578063aa271e1a1461052b578063cae9ca5114610551578063dd62ed3e1461060c578063f2fde38b1461063a576101c4565b806398650275146104cb578063a457c2d7146104d3578063a9059cbb146104ff576101c4565b80638da5cb5b116100d35780638da5cb5b1461048d5780638f32d59b1461049557806395d89b411461049d578063983b2d56146104a5576101c4565b806370a0823114610439578063715018a61461045f5780637657f20a14610467576101c4565b806339509351116101665780635f112c68116101405780635f112c68146103b957806363380113146103df5780636d435421146103e75780636fb7f55814610415576101c4565b8063395093511461033b57806340c10f191461036757806341eb24bb14610393576101c4565b806323b872dd116101a257806323b872dd146102a05780633113ed5c146102d6578063313ce567146102f757806338bf3cfa14610315576101c4565b806306fdde03146101c9578063095ea7b31461024657806318160ddd14610286575b600080fd5b6101d1610660565b6040805160208082528351818301528351919283929083019185019080838360005b8381101561020b5781810151838201526020016101f3565b50505050905090810190601f1680156102385780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b6102726004803603604081101561025c57600080fd5b506001600160a01b0381351690602001356106f6565b604080519115158252519081900360200190f35b61028e610713565b60408051918252519081900360200190f35b610272600480360360608110156102b657600080fd5b506001600160a01b03813581169160208101359091169060400135610719565b6102f5600480360360208110156102ec57600080fd5b50351515610788565b005b6102ff6107ed565b6040805160ff9092168252519081900360200190f35b6102f56004803603602081101561032b57600080fd5b50356001600160a01b03166107f6565b6102726004803603604081101561035157600080fd5b506001600160a01b038135169060200135610893565b6102726004803603604081101561037d57600080fd5b506001600160a01b0381351690602001356108ec565b6102f5600480360360208110156103a957600080fd5b50356001600160a01b0316610943565b6102f5600480360360208110156103cf57600080fd5b50356001600160a01b03166109c5565b610272610a47565b6102f5600480360360408110156103fd57600080fd5b506001600160a01b0381358116916020013516610a57565b61041d610b12565b604080516001600160a01b039092168252519081900360200190f35b61028e6004803603602081101561044f57600080fd5b50356001600160a01b0316610b26565b6102f5610b41565b6102f56004803603602081101561047d57600080fd5b50356001600160a01b0316610bd2565b61041d610c09565b610272610c18565b6101d1610c3e565b6102f5600480360360208110156104bb57600080fd5b50356001600160a01b0316610c9f565b6102f5610cf1565b610272600480360360408110156104e957600080fd5b506001600160a01b038135169060200135610d03565b6102726004803603604081101561051557600080fd5b506001600160a01b038135169060200135610d71565b6102726004803603602081101561054157600080fd5b50356001600160a01b0316610d85565b6102726004803603606081101561056757600080fd5b6001600160a01b038235169160208101359181019060608101604082013564010000000081111561059757600080fd5b8201836020820111156105a957600080fd5b803590602001918460018302840111640100000000831117156105cb57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550610d9e945050505050565b61028e6004803603604081101561062257600080fd5b506001600160a01b0381358116916020013516610dc9565b6102f56004803603602081101561065057600080fd5b50356001600160a01b0316610df4565b60058054604080516020601f60026000196101006001881615020190951694909404938401819004810282018101909252828152606093909290918301828280156106ec5780601f106106c1576101008083540402835291602001916106ec565b820191906000526020600020905b8154815290600101906020018083116106cf57829003601f168201915b5050505050905090565b600061070a610703610e44565b8484610e48565b50600192915050565b60025490565b6000336001600160a01b038516148061073a5750336001600160a01b038416145b6107755760405162461bcd60e51b8152600401808060200182810382526030815260200180611c006030913960400191505060405180910390fd5b610780848484610f34565b949350505050565b610790610c18565b6107cf576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b60078054911515600160a81b0260ff60a81b19909216919091179055565b60075460ff1690565b6107fe610c18565b61083d576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b806001600160a01b031663715018a66040518163ffffffff1660e01b8152600401600060405180830381600087803b15801561087857600080fd5b505af115801561088c573d6000803e3d6000fd5b5050505050565b600061070a6108a0610e44565b846108e785600160006108b1610e44565b6001600160a01b03908116825260208083019390935260409182016000908120918c16815292529020549063ffffffff610fb216565b610e48565b60006108fe6108f9610e44565b610d85565b6109395760405162461bcd60e51b8152600401808060200182810382526030815260200180611c306030913960400191505060405180910390fd5b61070a8383611013565b61094b610c18565b61098a576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b806001600160a01b0316636ef8d66d6040518163ffffffff1660e01b8152600401600060405180830381600087803b15801561087857600080fd5b6109cd610c18565b610a0c576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b806001600160a01b031663986502756040518163ffffffff1660e01b8152600401600060405180830381600087803b15801561087857600080fd5b600754600160a81b900460ff1681565b610a5f610c18565b610a9e576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b816001600160a01b031663f2fde38b826040518263ffffffff1660e01b815260040180826001600160a01b03166001600160a01b03168152602001915050600060405180830381600087803b158015610af657600080fd5b505af1158015610b0a573d6000803e3d6000fd5b505050505050565b60075461010090046001600160a01b031681565b6001600160a01b031660009081526020819052604090205490565b610b49610c18565b610b88576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b6004546040516000916001600160a01b0316907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0908390a3600480546001600160a01b0319169055565b60405162461bcd60e51b8152600401808060200182810382526025815260200180611d346025913960400191505060405180910390fd5b6004546001600160a01b031690565b6004546000906001600160a01b0316610c2f610e44565b6001600160a01b031614905090565b60068054604080516020601f60026000196101006001881615020190951694909404938401819004810282018101909252828152606093909290918301828280156106ec5780601f106106c1576101008083540402835291602001916106ec565b610caa6108f9610e44565b610ce55760405162461bcd60e51b8152600401808060200182810382526030815260200180611c306030913960400191505060405180910390fd5b610cee816110e9565b50565b610d01610cfc610e44565b611131565b565b600061070a610d10610e44565b846108e785604051806060016040528060258152602001611d816025913960016000610d3a610e44565b6001600160a01b03908116825260208083019390935260409182016000908120918d1681529252902054919063ffffffff61117916565b600061070a610d7e610e44565b8484611210565b6000610d9860038363ffffffff6112e616565b92915050565b6000610daa84846106f6565b610db357600080fd5b610dbf3385858561134d565b5060019392505050565b6001600160a01b03918216600090815260016020908152604080832093909416825291909152205490565b610dfc610c18565b610e3b576040805162461bcd60e51b81526020600482018190526024820152600080516020611ca9833981519152604482015290519081900360640190fd5b610cee816115bf565b3390565b6001600160a01b038316610e8d5760405162461bcd60e51b8152600401808060200182810382526024815260200180611d106024913960400191505060405180910390fd5b6001600160a01b038216610ed25760405162461bcd60e51b8152600401808060200182810382526022815260200180611b876022913960400191505060405180910390fd5b6001600160a01b03808416600081815260016020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b6000610f41848484611210565b610dbf84610f4d610e44565b6108e785604051806060016040528060288152602001611c81602891396001600160a01b038a16600090815260016020526040812090610f8b610e44565b6001600160a01b03168152602081019190915260400160002054919063ffffffff61117916565b60008282018381101561100c576040805162461bcd60e51b815260206004820152601b60248201527f536166654d6174683a206164646974696f6e206f766572666c6f770000000000604482015290519081900360640190fd5b9392505050565b61101d8282611660565b600754600160a81b900460ff168015611045575060075461010090046001600160a01b031615155b156110e55760075460408051634a39314960e01b81526000600482018190526001600160a01b03868116602484015260448301869052925161010090940490921692634a39314992606480840193602093929083900390910190829087803b1580156110b057600080fd5b505af11580156110c4573d6000803e3d6000fd5b505050506040513d60208110156110da57600080fd5b50516110e557600080fd5b5050565b6110fa60038263ffffffff61175016565b6040516001600160a01b038216907f6ae172837ea30b801fbfcdd4108aa1d5bf8ff775444fd70256b44e6bf3dfc3f690600090a250565b61114260038263ffffffff6117d116565b6040516001600160a01b038216907fe94479a9f7e1952cc78f2d6baab678adc1b772d936c6583def489e524cb6669290600090a250565b600081848411156112085760405162461bcd60e51b81526004018080602001828103825283818151815260200191508051906020019080838360005b838110156111cd5781810151838201526020016111b5565b50505050905090810190601f1680156111fa5780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b505050900390565b61121b838383611838565b600754600160a81b900460ff168015611243575060075461010090046001600160a01b031615155b156112e15760075460408051634a39314960e01b81526001600160a01b038681166004830152858116602483015260448201859052915161010090930490911691634a393149916064808201926020929091908290030181600087803b1580156112ac57600080fd5b505af11580156112c0573d6000803e3d6000fd5b505050506040513d60208110156112d657600080fd5b50516112e157600080fd5b505050565b60006001600160a01b03821661132d5760405162461bcd60e51b8152600401808060200182810382526022815260200180611cc96022913960400191505060405180910390fd5b506001600160a01b03166000908152602091909152604090205460ff1690565b632139e50b60e11b61135f8482611994565b61139a5760405162461bcd60e51b8152600401808060200182810382526031815260200180611ba96031913960400191505060405180910390fd5b60006060856001600160a01b0316838888888860405160240180856001600160a01b03166001600160a01b03168152602001846001600160a01b03166001600160a01b0316815260200183815260200180602001828103825283818151815260200191508051906020019080838360005b8381101561142357818101518382015260200161140b565b50505050905090810190601f1680156114505780820380516001836020036101000a031916815260200191505b5060408051601f198184030181529181526020820180516001600160e01b03166001600160e01b0319909a16999099178952518151919890975087965094509250829150849050835b602083106114b85780518252601f199092019160209182019101611499565b6001836020036101000a0380198251168184511680821785525050505050509050019150506000604051808303816000865af19150503d806000811461151a576040519150601f19603f3d011682016040523d82523d6000602084013e61151f565b606091505b50915091508181906115725760405162461bcd60e51b81526020600482018181528351602484015283519092839260449091019190850190808383600083156111cd5781810151838201526020016111b5565b5060208101519150816115b65760405162461bcd60e51b8152600401808060200182810382526028815260200180611d596028913960400191505060405180910390fd5b50505050505050565b6001600160a01b0381166116045760405162461bcd60e51b8152600401808060200182810382526026815260200180611b616026913960400191505060405180910390fd5b6004546040516001600160a01b038084169216907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a3600480546001600160a01b0319166001600160a01b0392909216919091179055565b6001600160a01b0382166116bb576040805162461bcd60e51b815260206004820152601f60248201527f45524332303a206d696e7420746f20746865207a65726f206164647265737300604482015290519081900360640190fd5b6002546116ce908263ffffffff610fb216565b6002556001600160a01b0382166000908152602081905260409020546116fa908263ffffffff610fb216565b6001600160a01b0383166000818152602081815260408083209490945583518581529351929391927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a35050565b61175a82826112e6565b156117ac576040805162461bcd60e51b815260206004820152601f60248201527f526f6c65733a206163636f756e7420616c72656164792068617320726f6c6500604482015290519081900360640190fd5b6001600160a01b0316600090815260209190915260409020805460ff19166001179055565b6117db82826112e6565b6118165760405162461bcd60e51b8152600401808060200182810382526021815260200180611c606021913960400191505060405180910390fd5b6001600160a01b0316600090815260209190915260409020805460ff19169055565b6001600160a01b03831661187d5760405162461bcd60e51b8152600401808060200182810382526025815260200180611ceb6025913960400191505060405180910390fd5b6001600160a01b0382166118c25760405162461bcd60e51b8152600401808060200182810382526023815260200180611b3e6023913960400191505060405180910390fd5b61190581604051806060016040528060268152602001611bda602691396001600160a01b038616600090815260208190526040902054919063ffffffff61117916565b6001600160a01b03808516600090815260208190526040808220939093559084168152205461193a908263ffffffff610fb216565b6001600160a01b038084166000818152602081815260409182902094909455805185815290519193928716927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92918290030190a3505050565b600061199f836119b0565b801561100c575061100c83836119e3565b60006119c3826301ffc9a760e01b6119e3565b8015610d9857506119dc826001600160e01b03196119e3565b1592915050565b60008060006119f28585611a09565b91509150818015611a005750805b95945050505050565b604080516001600160e01b0319831660248083019190915282518083039091018152604490910182526020810180516001600160e01b03166301ffc9a760e01b1781529151815160009384939284926060926001600160a01b038a169261753092879282918083835b60208310611a915780518252601f199092019160209182019101611a72565b6001836020036101000a0380198251168184511680821785525050505050509050019150506000604051808303818686fa925050503d8060008114611af2576040519150601f19603f3d011682016040523d82523d6000602084013e611af7565b606091505b5091509150602081511015611b155760008094509450505050611b36565b81818060200190516020811015611b2b57600080fd5b505190955093505050505b925092905056fe45524332303a207472616e7366657220746f20746865207a65726f20616464726573734f776e61626c653a206e6577206f776e657220697320746865207a65726f206164647265737345524332303a20617070726f766520746f20746865207a65726f206164647265737345524332304f6e417070726f76653a207370656e64657220646f65736e277420737570706f7274206f6e417070726f766545524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e636553656967546f6b656e3a206f6e6c792073656e646572206f7220726563697069656e742063616e207472616e736665724d696e746572526f6c653a2063616c6c657220646f6573206e6f74206861766520746865204d696e74657220726f6c65526f6c65733a206163636f756e7420646f6573206e6f74206861766520726f6c6545524332303a207472616e7366657220616d6f756e74206578636565647320616c6c6f77616e63654f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572526f6c65733a206163636f756e7420697320746865207a65726f206164647265737345524332303a207472616e736665722066726f6d20746865207a65726f206164647265737345524332303a20617070726f76652066726f6d20746865207a65726f2061646472657373544f4e3a20544f4e20646f65736e277420616c6c6f7720736574536569674d616e6167657245524332304f6e417070726f76653a206661696c656420746f2063616c6c206f6e417070726f766545524332303a2064656372656173656420616c6c6f77616e63652062656c6f77207a65726fa265627a7a723158205acbb5bfd5f6981d9718f217b2535ee43574f978327da90713ca318b5181142b64736f6c634300050c0032',
)
  