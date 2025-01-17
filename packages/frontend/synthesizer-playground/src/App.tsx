import React, { useState } from 'react';
import { fetchTransactionBytecode } from './utils/etherscanApi';
import { processBytecodeWithSynthesizer } from '@your-monorepo/synthesizer';

const App: React.FC = () => {
  const [transactionId, setTransactionId] = useState('');
  const [output, setOutput] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      //const bytecode = await fetchTransactionBytecode(transactionId); 
      //const result = processBytecodeWithSynthesizer(bytecode); // commented out for now
      setOutput(result);
    } catch (err) {
      console.error('Error:', err);
      setOutput('Error processing transaction');
    }
  };

  return (
    <div>
      <h1>Synthesizer Developer Playground</h1>
      <input
        type="text"
        value={transactionId}
        onChange={(e) => setTransactionId(e.target.value)}
        placeholder="Enter Transaction ID"
      />
      <button onClick={handleSubmit}>Process</button>
      {output && <pre>{output}</pre>}
    </div>
  );
};

export default App;
