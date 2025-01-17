import axios from 'axios';

const ETHERSCAN_API_URL = 'https://api.etherscan.io/api'; 
const API_KEY = process.env.VITE_ETHERSCAN_API_KEY; //will be replaced by the actual API key 

export const fetchTransactionBytecode = async (transactionId: string): Promise<string> => {
  const response = await axios.get(ETHERSCAN_API_URL, {
    params: {
      module: 'proxy',
      action: 'eth_getTransactionByHash',
      txhash: transactionId,
      apikey: API_KEY,
    },
  });

  if (!response.data || !response.data.result) {
    throw new Error('Failed to fetch transaction bytecode');
  }

  return response.data.result.input; // Bytecode is in the input
};
