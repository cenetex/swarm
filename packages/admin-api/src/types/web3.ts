/**
 * Web3/wallet/NFT types
 */

// Wallet info (public data only)
export interface WalletInfo {
  id: string;
  avatarId: string;
  walletType: 'solana' | 'ethereum';
  publicKey: string;
  address: string;
  name: string;
  createdAt: number;
  createdBy: string;
}
