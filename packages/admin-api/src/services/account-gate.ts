import { getAccountSummary } from './accounts.js';
import { getGateStatus, type GateStatus } from './web3/nft-gate.js';

export interface AccountGateStatusResult {
  gateWallet: string | null;
  gateStatus: GateStatus | null;
  gateStatusByWallet: Record<string, GateStatus>;
}

export interface AccountGateDeps {
  getAccountSummary: typeof getAccountSummary;
  getGateStatus: typeof getGateStatus;
}

/**
 * Compute gate status at the account level.
 *
 * Current implementation selects the "best" linked wallet (max availableSlots, then nftsHeld)
 * and returns its GateStatus as the account-level status.
 */
export async function getAccountGateStatus(
  accountId: string,
  deps: AccountGateDeps = { getAccountSummary, getGateStatus }
): Promise<AccountGateStatusResult> {
  const account = await deps.getAccountSummary(accountId);
  const walletAddresses =
    account?.identities
      .filter((i) => i.type === 'wallet')
      .map((i) => i.providerId) ??
    [];

  const uniqueWallets = Array.from(new Set(walletAddresses));

  if (uniqueWallets.length === 0) {
    return {
      gateWallet: null,
      gateStatus: null,
      gateStatusByWallet: {},
    };
  }

  const statuses = await Promise.all(
    uniqueWallets.map(async (walletAddress) => ({
      walletAddress,
      gateStatus: await deps.getGateStatus(walletAddress),
    }))
  );

  const gateStatusByWallet: Record<string, GateStatus> = {};
  for (const item of statuses) {
    gateStatusByWallet[item.walletAddress] = item.gateStatus;
  }

  const best = statuses
    .slice()
    .sort((a, b) => {
      if (b.gateStatus.availableSlots !== a.gateStatus.availableSlots) {
        return b.gateStatus.availableSlots - a.gateStatus.availableSlots;
      }
      return b.gateStatus.nftsHeld - a.gateStatus.nftsHeld;
    })[0];

  return {
    gateWallet: best?.walletAddress ?? null,
    gateStatus: best?.gateStatus ?? null,
    gateStatusByWallet,
  };
}
