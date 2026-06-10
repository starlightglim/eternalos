# 14 — HyperEVM Asset Provenance

> Optional HyperEVM ownership and provenance layer for EternalOS assets.
> Assets remain usable without a wallet; on-chain state adds verification, not storage.

## Current slice

Implemented first:

- HyperEVM-specific wallet challenges for chain IDs `999` and `998`.
- Optional wallet linking after normal EternalOS login.
- Wallet login only for already-linked wallets.
- Linked wallets stored on the existing `UserRecord` and indexed in `AUTH_KV`.
- Bazaar pack type shape now has optional `verification` metadata for later display.

This deliberately does **not** replace email/password or Google OAuth.

## HyperEVM constants

```ts
mainnet: {
  chainId: 999,
  rpcUrl: "https://rpc.hyperliquid.xyz/evm",
  gas: "HYPE"
}

testnet: {
  chainId: 998,
  rpcUrl: "https://rpc.hyperliquid-testnet.xyz/evm",
  gas: "HYPE"
}
```

## Product rule

Do not make HyperEVM mandatory for the desktop.

Good first uses:

- verified creator badge on Bazaar packs
- limited-edition skins/themes
- token-gated installs as an optional publisher setting
- provenance for forks/remixes

Avoid:

- tokenizing private uploads by default
- requiring chain availability to use installed assets
- treating NFT metadata as the asset source of truth

## Asset identity

The source of truth should be a canonical EternalOS asset manifest:

```ts
interface AssetPublicationManifest {
  version: 1;
  packId: string;
  type: "cursor" | "icon" | "sound" | "effect" | "skin" | "app";
  name: string;
  authorUid: string;
  authorUsername: string;
  files: Array<{
    path: string;
    r2Key: string;
    sha256: string;
    mimeType: string;
    size: number;
  }>;
}
```

The NFT should point to this manifest or its hash. It should not be the storage layer.

## Verification metadata

```ts
interface HyperEvmAssetVerification {
  provider: "hyperevm";
  chainId: 998 | 999;
  contractAddress: string;
  tokenId: string;
  standard: "ERC721" | "ERC1155";
  manifestHash: string;
  tokenUri?: string;
  txHash?: string;
  verifiedOwner?: string;
  verifiedAt?: number;
  status: "pending" | "verified" | "mismatch" | "revoked";
}
```

## Verification flow

```text
creator publishes Bazaar pack
  -> Worker builds canonical manifest and content hashes
  -> creator optionally mints/links NFT on HyperEVM
  -> Worker checks token ownership and metadata via HyperEVM JSON-RPC
  -> Worker stores verification metadata on the Bazaar pack
  -> Bazaar displays HyperEVM verified badge
```

For `ERC721`, verify with `ownerOf(tokenId)`.

For `ERC1155`, verify with `balanceOf(owner, tokenId) > 0`.

For install gating, re-check ownership at install time or use a short TTL cache. For simple provenance badges, a one-time verified record is enough.

## Non-goals for the first pass

- payments
- marketplace bidding
- automatic NFT minting from every upload
- cross-chain support
- chain-dependent desktop boot
- user account creation from arbitrary unlinked wallets
