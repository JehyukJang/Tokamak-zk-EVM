// App.tsx
import React, { useState, useEffect } from 'react';
import { fetchTransactionBytecode } from '../utils/etherscanApi';
import { Buffer } from 'buffer';
import { createEVM } from '../../frontend/synthesizer/src/constructors';
import { hexToBytes, Address } from '@synthesizer-libs/util';
import { TON_CONTRACT_CODE } from './constant/evm';
import { setupEVM } from '../utils/setupEVM';
import logo from '/src/assets/logo.svg';
import {serializePlacements} from '../helpers/helpers';
import './App.css';

import Header from './components/Header';
import TransactionForm from './components/TransactionForm';
import ResultDisplay from './components/ResultDisplay';
import CustomLoading from './components/CustomLoading';
import CustomErrorTab from './components/CustomErrorTab';
import Stars from './components/Stars';
import RainbowImage from './components/RainbowImage';

window.Buffer = window.Buffer || Buffer;

const App: React.FC = () => {
  const [transactionId, setTransactionId] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [serverData, setServerData] = useState<{
    permutation: string | null;
    placementInstance: string | null;
  } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const [storageLoad, setStorageLoad] = useState<any[]>([]);
  const [placementLogs, setPlacementLogs] = useState<any[]>([]);
  const [storageStore, setStorageStore] = useState<any[]>([]);
  const [evmContractAddress, setEvmContractAddress] = useState<string>('');
  const [activeTab, setActiveTab] = useState('storageLoad');

  const processTransaction = async (txId: string) => {
    try {
      setIsProcessing(true);

      setStatus('Fetching bytecode from Etherscan...');
      setStorageLoad([]);
      setPlacementLogs([]);
      setStorageStore([]);
      setServerData(null);

      const { bytecode, from, to } = await fetchTransactionBytecode(txId);
      if (!bytecode || bytecode.length < 2) {
        throw new Error('Invalid bytecode received. Check your transaction ID.');
      }

      const contractCode = TON_CONTRACT_CODE;
      setStatus('Creating and running the EVM...');
      const evm = await createEVM();
      const contractAddr = new Address(hexToBytes(to));
      setEvmContractAddress(contractAddr.toString());
      const sender = new Address(hexToBytes(from));
      await setupEVM(evm, from, contractCode, contractAddr, sender);

      const res = await evm.runCode({
        caller: sender,
        to: contractAddr,
        code: contractCode,
        data: hexToBytes(bytecode),
      });

      if (!res.runState?.synthesizer?.placements) {
        throw new Error('No placements generated by the synthesizer.');
      }

      const placementsMap = res.runState.synthesizer.placements;

      const {
        STORAGE_IN_PLACEMENT_INDEX,
        RETURN_PLACEMENT_INDEX,
        STORAGE_OUT_PLACEMENT_INDEX,
      } = await import('../../frontend/synthesizer/src/tokamak/constant/constants.js');
      
      const storageLoadPlacement = placementsMap.get(STORAGE_IN_PLACEMENT_INDEX);
      const logsPlacement = placementsMap.get(RETURN_PLACEMENT_INDEX);
      const storageStorePlacement = placementsMap.get(STORAGE_OUT_PLACEMENT_INDEX);

      const storageLoadData = storageLoadPlacement?.inPts || [];
      const storageStoreData = storageStorePlacement?.outPts || [];
      const _logsData = logsPlacement?.outPts || [];

      const logsData: { topics: string[]; valueDec: bigint; valueHex: string }[] = [];
      let prevIdx = -1;
      for (const _logData of _logsData) {
        const idx = _logData.pairedInputWireIndices![0];
        if (idx !== prevIdx) {
          logsData.push({ topics: [], valueDec: _logData.value, valueHex: _logData.valueHex });
        } else {
          logsData[idx].topics.push(_logData.valueHex);
        }
        prevIdx = idx;
      }
      setStorageLoad(storageLoadData);
      setStorageStore(storageStoreData);
      setPlacementLogs(logsData);

      const placementsObj = Object.fromEntries(placementsMap.entries());

      setStatus('Finalizing placements on the server...');
      const response = await fetch('api/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializePlacements(placementsObj),
      });
      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const json = await response.json();

      if (!json.ok) {
        throw new Error(json.error || 'Unknown server error.');
      }

      const { permutation, placementInstance } = json.data || {};
      setServerData({ permutation, placementInstance });
      setStatus(null);
      sessionStorage.removeItem('pendingTransactionId');
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      sessionStorage.removeItem('pendingTransactionId');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = () => {
    if (isProcessing) return;
    sessionStorage.setItem('pendingTransactionId', transactionId);
    window.location.reload();
  };

  useEffect(() => {
    const pendingTxId = sessionStorage.getItem('pendingTransactionId');
    if (pendingTxId) {
      setTransactionId(pendingTxId);
      processTransaction(pendingTxId);
    }
  }, []);

  const handleDownload = (fileContent: string | null, fileName: string) => {
    if (!fileContent) return;
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="background-container">
        <Stars />
        <RainbowImage />
      </div>
      <div>
        <Header logo={logo} onLogoClick={() => window.location.reload()} />
        <TransactionForm
          transactionId={transactionId}
          setTransactionId={setTransactionId}
          handleSubmit={handleSubmit}
          isProcessing={isProcessing}
          error={status?.startsWith('Error')}
        />
        {isProcessing ? (
          <CustomLoading />
        ) : status && status.startsWith('Error') ? (
          <CustomErrorTab errorMessage={status.replace('Error: ', '')} />
        ) : null}
        {!isProcessing && (storageLoad.length > 0 || placementLogs.length > 0 || storageStore.length > 0 || serverData) && (
          <ResultDisplay
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            storageLoad={storageLoad}
            placementLogs={placementLogs}
            storageStore={storageStore}
            evmContractAddress={evmContractAddress}
            handleDownload={handleDownload}
            serverData={serverData}
          />
        )}
      </div>
    </>
  );
};

export default App;
