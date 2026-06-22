import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { type Address, type Hex, getAddress, maxUint256 } from "viem";

import { LiquidationEncoder } from "./LiquidationEncoder.js";

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

/**
 * Encodes a full liquidation tx: collateral conversion → approve → liquidate → skim profit.
 * Returns null if no venue supports the collateral→loan route.
 */
export async function buildLiquidateCalls(
  encoder: LiquidationEncoder,
  {
    morphoAddress,
    market,
    borrower,
    seizedAssets,
    liquidityVenues,
    treasuryAddress,
  }: {
    morphoAddress: Address;
    market: MarketParams;
    borrower: Address;
    seizedAssets: bigint;
    liquidityVenues: LiquidityVenue[];
    treasuryAddress: Address;
  },
): Promise<Hex[] | null> {
  let toConvert = {
    src: getAddress(market.collateralToken),
    dst: getAddress(market.loanToken),
    srcAmount: seizedAssets,
  };

  let converted = false;
  for (const venue of liquidityVenues) {
    try {
      // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
      if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst)) {
        // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
        toConvert = await venue.convert(encoder, toConvert);
      }
    } catch {
      continue;
    }
    if (toConvert.src === toConvert.dst) {
      converted = true;
      break;
    }
  }

  if (!converted) return null;

  encoder.erc20Approve(market.loanToken, morphoAddress, maxUint256);
  const liquidationCallbackCalls = encoder.flush();

  encoder.morphoBlueLiquidate(
    morphoAddress,
    market,
    borrower,
    seizedAssets,
    0n,
    liquidationCallbackCalls,
  );
  encoder.erc20Skim(market.loanToken, treasuryAddress);

  return encoder.flush();
}
