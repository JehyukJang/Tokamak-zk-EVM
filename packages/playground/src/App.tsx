// App.tsx
import React, { useState, useEffect } from 'react';
import { fetchTransactionBytecode } from '../utils/etherscanApi';
import { Buffer } from 'buffer';
import { createEVM } from '../../frontend/synthesizer/src/constructors';
import { hexToBytes, Address } from '../../frontend/synthesizer/libs/util/dist/esm/index.js';
import { TON_CONTRACT_CODE } from './constant/evm.js';
import { setupEVM } from '../utils/setupEVM';
import logo from '/logo.svg';
import { getValueDecimal, summarizeHex, serializePlacements, add0xPrefix } from '../helpers/helpers';
import './App.css';
import CustomTabSwitcher from './components/CustomTabSwitcher.js';
import save from '/save.svg';
import CustomErrorTab from './components/CustomErrorTab.js';
import {
  RETURN_PLACEMENT_INDEX,
  STORAGE_IN_PLACEMENT_INDEX,
  STORAGE_OUT_PLACEMENT_INDEX,
} from '../../frontend/synthesizer/src/tokamak/constant/constants.js';
import RainbowImage from './components/RainbowImage.js';
import Stars from './components/Stars.js';
import CustomInput from './components/CustomInput.js';
import CustomLoading from './components/CustomLoading.js';

window.Buffer = window.Buffer || Buffer;

type LogCardProps = {
  contractAddress: string;
  keyValue: string;
  valueDecimal: string;
  valueHex: string;
  summarizeAddress?: boolean;
};

const LogCard: React.FC<LogCardProps> = ({
  contractAddress,
  keyValue,
  valueDecimal,
  valueHex,
  summarizeAddress = false,
}) => (
  <div className="log-card">
    {contractAddress && (
      <div>
        <strong>Contract Address:</strong>{' '}
        <span title={contractAddress}>
          {summarizeAddress ? summarizeHex(contractAddress) : contractAddress}
        </span>
      </div>
    )}
    {keyValue && (
      <div>
        <strong>Key:</strong>{' '}
        <span title={keyValue}>{summarizeHex(keyValue)}</span>
      </div>
    )}
    <div>
      <strong>Value (Decimal):</strong>{' '}
      <span>{valueDecimal || getValueDecimal(valueHex)}</span>
    </div>
    <div>
      <strong>Value (Hex):</strong>{' '}
      <span title={valueHex}>{valueHex}</span>
    </div>
  </div>
);

export interface FormattedLog {
  address: string;
  topics: {
    signature: string;
    from: string;
    to: string;
  };
  data: {
    hex: string;
    value: string;
  };
}

export function formatLogsStructured(logs: any[]): FormattedLog[] {
  console.log('Raw logs:', logs);
  const formattedLogs = logs.map((log: any) => {
    const topics = log[1].map((topic: any) => `0x${Buffer.from(topic).toString('hex')}`);
    const dataHex = `0x${Buffer.from(log[2]).toString('hex')}`;

    const formattedLog: FormattedLog = {
      address: `0x${Buffer.from(log[0]).toString('hex')}`,
      topics: {
        signature: topics[0],
        from: `0x${topics[1].slice(-40)}`,
        to: `0x${topics[2].slice(-40)}`,
      },
      data: {
        hex: dataHex,
        value: parseInt(dataHex, 16).toString(),
      },
    };

    console.log('Formatted log:', formattedLog);
    return formattedLog;
  });
  return formattedLogs;
}

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

      // Temporary delay (for testing purposes)
      //await new Promise((resolve) => setTimeout(resolve, 2000));

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

  const renderActiveTab = () => {
    if (activeTab === 'storageLoad') {
      return storageLoad.length ? (
        storageLoad.map((item, index) => (
          <div key={index} className="log-card-inside">
            <div className="data-label">Data #{index + 1}</div>
            <LogCard
              contractAddress={item.contractAddress || evmContractAddress}
              keyValue={add0xPrefix(item.key)}
              valueDecimal={item.valueDecimal}
              valueHex={add0xPrefix(item.valueHex)}
            />
          </div>
        ))
      ) : (
        <p>No storage load data.</p>
      );
    } else if (activeTab === 'logs') {
      return placementLogs.length ? (
        placementLogs.map((log, index) => (
          <div key={index} className="log-card-inside">
            <div className="data-label">Data #{index + 1}</div>
            <div>
              <strong>Topics:</strong>
              <div
                className="log-topics"
                style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
              >
                {log.topics.map((topic: string, idx: number) => (
                  <div key={idx} className="topic-badge">
                    {`${idx}: ${add0xPrefix(summarizeHex(topic))}`}
                  </div>
                ))}
              </div>
            </div>
            <LogCard
              contractAddress=""
              keyValue=""
              valueDecimal={log.valueDec.toString()}
              valueHex={add0xPrefix(log.valueHex)}
            />
          </div>
        ))
      ) : (
        <p>No logs data.</p>
      );
    } else if (activeTab === 'storageStore') {
      return storageStore.length ? (
        storageStore.map((item, index) => {
          const contractAddress = Array.isArray(item)
            ? item[0] || evmContractAddress
            : item.contractAddress || evmContractAddress;
          const key = Array.isArray(item) ? item[1] : item.key;
          const valueDecimal = item.value !== undefined ? item.value.toString() : '0';
          const valueHex = item.valueHex || '0x0';

          return (
            <div key={index} className="log-card-inside">
              <div className="data-label">Data #{index + 1}</div>
              <LogCard
                contractAddress={contractAddress}
                keyValue={add0xPrefix(key)}
                valueDecimal={valueDecimal}
                valueHex={add0xPrefix(valueHex)}
                summarizeAddress={true}
              />
            </div>
          );
        })
      ) : (
        <p>No storage store data.</p>
      );
    }
    return null;
  };

  return (
    <>
      <div className="background-container">
        <Stars />
        <RainbowImage />
      </div>
      <div className="container">
        <div className="logo-container">
          <img
            src={logo}
            alt="Synthesizer Logo"
            className="logo-image"
            onClick={() => window.location.reload()}
          />
        </div>
        <div className="title-container">
          <h1 className="main-title">Synthesizer</h1>
          <h2 className="subtitle">Developer Playground</h2>
        </div>
        <div className="input-button-container">
          <CustomInput
            value={transactionId}
            onChange={setTransactionId}
            disabled={isProcessing}
            error={status?.startsWith('Error')}
          />
          <button
            onClick={handleSubmit}
            className={`btn-process ${isProcessing ? 'disabled' : ''} ${
              status && status.startsWith('Error') ? 'error' : ''
            }`}
            disabled={isProcessing}
          >
            <span className="btn-icon">
              <img src={save} alt="icon" />
            </span>
            <span className="btn-text">Process</span>
          </button>
        </div>
        {isProcessing ? (
          <CustomLoading />
        ) : status && status.startsWith('Error') ? (
          <CustomErrorTab errorMessage={status.replace('Error: ', '')} />
        ) : null}
        {/* Only show the result box when not processing */}
        {!isProcessing && (storageLoad.length > 0 || placementLogs.length > 0 || storageStore.length > 0 || serverData) && (
          <div className="big-box">
            <CustomTabSwitcher activeTab={activeTab} setActiveTab={setActiveTab} />
            <div className="fixed-box">{renderActiveTab()}</div>
            {serverData && (
              <div className="download-buttons-container">
                {serverData.permutation && (
                  <button
                    onClick={() => handleDownload(serverData.permutation, 'permutation.json')}
                    className="btn-download btn-permutation"
                    disabled={isProcessing}
                  >
                    Download Permutation
                  </button>
                )}
                {serverData.placementInstance && (
                  <button
                    onClick={() =>
                      handleDownload(serverData.placementInstance, 'placementInstance.json')
                    }
                    className="btn-download btn-placement"
                    disabled={isProcessing}
                  >
                    Download Placement Instance
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default App;
