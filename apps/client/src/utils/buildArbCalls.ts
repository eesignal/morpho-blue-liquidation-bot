import { PENDLE_API_URL, PENDLE_SLIPPAGE } from "@morpho-blue-liquidation-bot/config";
import { ExecutorEncoder } from "executooor-viem";
import { type Address, type Hex, encodePacked, maxUint256 } from "viem";

import type { MarketParams } from "./buildLiquidateCalls.js";

export type FlashLoanSource = "morpho" | "balancer";
export type SwapVenue = "uniswap" | "pendle";

export interface ArbParams {
  morphoAddress: Address;
  market: MarketParams;
  token0: Address;
  token1: Address;
  flashLoanAmount: bigint;
  minCollateralOut: bigint;
  borrowAmount: bigint;
  collectionAddress: Address;
  flashLoanSource: FlashLoanSource;
  swapVenue: SwapVenue;
  chainId: number;
  uniswapV3Router?: Address;
  uniswapFee?: number;
  balancerVault?: Address;
  pendleMarket?: string;
}

async function fetchPendleSwapCallData(
  chainId: number,
  pendleMarket: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  receiver: string,
): Promise<{ tx: { data: Hex; to: Address; value: string }; data: { amountOut: string } }> {
  const params = new URLSearchParams({
    receiver,
    slippage: PENDLE_SLIPPAGE.toString(),
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
  });
  const url = `${PENDLE_API_URL}v2/sdk/${chainId}/markets/${pendleMarket}/swap?${params}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Pendle API error: ${res.statusText}`);
  return res.json() as Promise<{
    tx: { data: Hex; to: Address; value: string };
    data: { amountOut: string };
  }>;
}

/**
 * Encodes a full flash-loan arbitrage tx:
 * flash loan token0 → swap to token1 → supply collateral → borrow token0 → repay → skim profit.
 */
export async function buildArbCalls(
  // biome-ignore lint: ExecutorEncoder uses an older viem version — safe at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encoder: any,
  params: ArbParams,
): Promise<Hex[]> {
  const {
    morphoAddress,
    market,
    token0,
    token1,
    flashLoanAmount,
    minCollateralOut,
    borrowAmount,
    collectionAddress,
    flashLoanSource,
    swapVenue,
    chainId,
    uniswapV3Router,
    uniswapFee = 3000,
    balancerVault,
    pendleMarket,
  } = params;

  const supplyCallbackCalls: Hex[] = [
    ExecutorEncoder.buildErc20Transfer(token1, morphoAddress, minCollateralOut),
  ];

  const innerEncoder = new ExecutorEncoder(encoder.address, encoder.client);

  if (swapVenue === "pendle") {
    if (!pendleMarket) throw new Error("pendleMarket is required for pendle swap venue");
    const swapData = await fetchPendleSwapCallData(
      chainId,
      pendleMarket,
      token0.toLowerCase(),
      token1.toLowerCase(),
      flashLoanAmount,
      encoder.address,
    );
    innerEncoder
      .erc20Approve(token0, swapData.tx.to, maxUint256)
      .pushCall(
        swapData.tx.to,
        swapData.tx.value ? BigInt(swapData.tx.value) : 0n,
        swapData.tx.data,
      );
  } else {
    if (!uniswapV3Router) throw new Error("uniswapV3Router is required for uniswap swap venue");
    const swapPath = encodePacked(["address", "uint24", "address"], [token0, uniswapFee, token1]);
    innerEncoder
      .erc20Approve(token0, uniswapV3Router, flashLoanAmount)
      .uniV3ExactInput(uniswapV3Router, swapPath, flashLoanAmount, minCollateralOut);
  }

  innerEncoder
    .morphoBlueSupplyCollateral(
      morphoAddress,
      market,
      minCollateralOut,
      encoder.address,
      supplyCallbackCalls,
    )
    .morphoBlueBorrow(morphoAddress, market, borrowAmount, 0n, encoder.address, encoder.address);

  const flashLoanCallbackCalls = innerEncoder.flush();

  if (flashLoanSource === "morpho") {
    encoder.blueFlashLoan(morphoAddress, token0, flashLoanAmount, flashLoanCallbackCalls);
  } else {
    if (!balancerVault) throw new Error("balancerVault is required for balancer flash loan source");
    encoder.balancerFlashLoan(
      balancerVault,
      [{ asset: token0, amount: flashLoanAmount }],
      flashLoanCallbackCalls,
    );
  }

  encoder.erc20Skim(token0, collectionAddress);
  return encoder.flush();
}
