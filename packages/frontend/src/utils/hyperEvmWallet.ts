import type { HyperEvmChainId } from '../types';

interface EthereumProvider {
  request<T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export const HYPEREVM_MAINNET_CHAIN_ID: HyperEvmChainId = 999;
export const HYPEREVM_TESTNET_CHAIN_ID: HyperEvmChainId = 998;
export const DEFAULT_HYPEREVM_CHAIN_ID: HyperEvmChainId = HYPEREVM_MAINNET_CHAIN_ID;

export const HYPEREVM_CHAINS: Record<HyperEvmChainId, {
  chainId: HyperEvmChainId;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
}> = {
  999: {
    chainId: HYPEREVM_MAINNET_CHAIN_ID,
    chainName: 'HyperEVM',
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  },
  998: {
    chainId: HYPEREVM_TESTNET_CHAIN_ID,
    chainName: 'HyperEVM Testnet',
    rpcUrls: ['https://rpc.hyperliquid-testnet.xyz/evm'],
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  },
};

function chainIdToHex(chainId: HyperEvmChainId): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

function getEthereumProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error('No wallet found. Install a browser wallet that supports HyperEVM.');
  }
  return window.ethereum;
}

async function ensureHyperEvmChain(provider: EthereumProvider, chainId: HyperEvmChainId): Promise<void> {
  const chain = HYPEREVM_CHAINS[chainId];
  const chainIdHex = chainIdToHex(chainId);

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (error) {
    const maybeProviderError = error as { code?: number };
    if (maybeProviderError.code !== 4902) {
      throw error;
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainIdHex,
        chainName: chain.chainName,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls,
      }],
    });
  }
}

export async function requestHyperEvmWallet(
  chainId: HyperEvmChainId = DEFAULT_HYPEREVM_CHAIN_ID,
): Promise<{ address: string; chainId: HyperEvmChainId }> {
  const provider = getEthereumProvider();
  await ensureHyperEvmChain(provider, chainId);

  const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' });
  const address = accounts[0];
  if (!address) {
    throw new Error('No wallet account selected.');
  }

  return { address, chainId };
}

export async function signHyperEvmMessage(message: string, address: string): Promise<string> {
  const provider = getEthereumProvider();
  return provider.request<string>({
    method: 'personal_sign',
    params: [message, address],
  });
}

export function formatWalletAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getHyperEvmChainName(chainId: HyperEvmChainId): string {
  return HYPEREVM_CHAINS[chainId]?.chainName ?? `HyperEVM ${chainId}`;
}
