/**
 * Arbitrage script: flash-loan token0 → swap to token1 → supply collateral → borrow token0 → repay flash loan → profit.
 *
 * Typical use case: oracle price discrepancy or large depeg allows borrowing more token0 than was swapped.
 *
 * Usage (UniswapV3 swap):
 *   pnpm arb --chain-id=1 \
 *     --flash-loan-source=morpho \
 *     --token0=0x... \
 *     --token1=0x... \
 *     --flash-loan-amount=1000000000000000000 \
 *     --min-collateral-out=1000000 \
 *     --market-id=0x... \
 *     --borrow-amount=1100000000000000000 \
 *     [--uniswap-fee=3000] \
 *     [--simulate-only]
 *
 * Usage (Pendle PT swap — token1 is a Pendle PT):
 *   pnpm arb --chain-id=1 \
 *     --flash-loan-source=morpho \
 *     --swap-venue=pendle \
 *     --pendle-market=0x... \
 *     --token0=0x... \
 *     --token1=0x... \
 *     --flash-loan-amount=1000000000000000000 \
 *     --min-collateral-out=1000000 \
 *     --market-id=0x... \
 *     --borrow-amount=1100000000000000000 \
 *     [--simulate-only]
 */

import { chainConfigs, PENDLE_API_URL, PENDLE_SLIPPAGE } from "@morpho-blue-liquidation-bot/config";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import dotenv from "dotenv";
import { ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  type Hex,
  createWalletClient,
  encodePacked,
  erc20Abi,
  http,
  formatUnits,
  maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract, simulateCalls } from "viem/actions";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { morphoBlueAbi } from "./abis/morpho/morphoBlue.js";

async function getPendleSwapCallData(
  chainId: number,
  pendleMarket: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  receiver: string,
) {
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
    data: { amountOut: string; priceImpact: number };
  }>;
}

// Default router / vault addresses per chain. Override with --uniswap-v3-router / --balancer-vault.
const DEFAULT_UNISWAP_V3_ROUTER: Record<number, Address> = {
  1: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02 mainnet
  8453: "0x2626664c2603336E57B271c5C0b26F421741e481", // Base
  42161: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Arbitrum
  130: "0x2626664c2603336E57B271c5C0b26F421741e481", // Unichain
  480: "0x091AD9e2e6e5eD44c1c66dB50e49A601F9f36cF6", // Worldchain
};

// Balancer V2 Vault — same address across most chains
const DEFAULT_BALANCER_VAULT: Record<number, Address> = {
  1: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  8453: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  42161: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

async function run() {
  dotenv.config();

  const argv = yargs(hideBin(process.argv))
    .option("chainId", {
      type: "number",
      description: "Chain ID",
      demandOption: true,
    })
    .option("flashLoanSource", {
      choices: ["morpho", "balancer"] as const,
      description: "Flash loan source",
      demandOption: true,
    })
    .option("token0", {
      type: "string",
      description: "Flash loan token address (also the loan token in the Morpho market)",
      demandOption: true,
    })
    .option("token1", {
      type: "string",
      description: "Collateral token address in the Morpho market",
      demandOption: true,
    })
    .option("flashLoanAmount", {
      type: "string",
      description: "Amount of token0 to flash loan (in wei / smallest unit)",
      demandOption: true,
    })
    .option("swapVenue", {
      choices: ["uniswap", "pendle"] as const,
      description: "Venue used to swap token0 → token1",
      default: "uniswap" as const,
    })
    .option("uniswapFee", {
      type: "number",
      description:
        "UniswapV3 pool fee tier (500 | 3000 | 10000). Only used when --swap-venue=uniswap.",
      default: 3000,
    })
    .option("pendleMarket", {
      type: "string",
      description: "Pendle market address. Required when --swap-venue=pendle.",
    })
    .option("minCollateralOut", {
      type: "string",
      description: "Minimum token1 to receive from the swap (slippage protection)",
      demandOption: true,
    })
    .option("marketId", {
      type: "string",
      description: "Morpho market ID (bytes32 hex). Market params are fetched from chain.",
      demandOption: true,
    })
    .option("borrowAmount", {
      type: "string",
      description:
        "Amount of token0 to borrow from Morpho (must exceed flashLoanAmount for profit)",
      demandOption: true,
    })
    .option("collectionAddress", {
      type: "string",
      description: "Address to receive the profit. Defaults to the executor owner.",
    })
    .option("uniswapV3Router", {
      type: "string",
      description: "UniswapV3 SwapRouter02 address (override per-chain default)",
    })
    .option("balancerVault", {
      type: "string",
      description: "Balancer V2 Vault address (override per-chain default)",
    })
    .option("simulateOnly", {
      type: "boolean",
      description: "Only simulate; do not broadcast the transaction",
      default: false,
    })
    .parseSync();

  const chainId = argv.chainId;
  const token0 = argv.token0 as Address;
  const token1 = argv.token1 as Address;
  const flashLoanAmount = BigInt(argv.flashLoanAmount);
  const minCollateralOut = BigInt(argv.minCollateralOut);
  const borrowAmount = BigInt(argv.borrowAmount);
  const marketId = argv.marketId as Hex;
  const uniswapFee = argv.uniswapFee;

  const chainConfig = chainConfigs[chainId];
  if (!chainConfig) throw new Error(`No chain config for chainId=${chainId}`);

  const rpcUrl = process.env[`RPC_URL_${chainId}`];
  const privateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${chainId}`];
  const executorAddress = process.env[`EXECUTOR_ADDRESS_${chainId}`] as Address | undefined;

  if (!rpcUrl) throw new Error(`RPC_URL_${chainId} is not set`);
  if (!privateKey) throw new Error(`LIQUIDATION_PRIVATE_KEY_${chainId} is not set`);
  if (!executorAddress) throw new Error(`EXECUTOR_ADDRESS_${chainId} is not set`);

  const client = createWalletClient({
    chain: chainConfig.chain,
    transport: http(rpcUrl),
    account: privateKeyToAccount(privateKey as Hex),
  });

  const chainAddresses = getChainAddresses(chainId);
  const morphoAddress = chainAddresses.morpho;

  const collectionAddress =
    (argv.collectionAddress as Address | undefined) ?? client.account.address;

  const swapVenue = argv.swapVenue;

  let uniswapV3Router: Address | undefined;
  if (swapVenue === "uniswap") {
    uniswapV3Router =
      (argv.uniswapV3Router as Address | undefined) ?? DEFAULT_UNISWAP_V3_ROUTER[chainId];
    if (!uniswapV3Router) {
      throw new Error(
        `No default UniswapV3 router for chainId=${chainId}. Pass --uniswap-v3-router=0x...`,
      );
    }
  }

  const pendleMarket = argv.pendleMarket;
  if (swapVenue === "pendle" && !pendleMarket) {
    throw new Error(`--pendle-market is required when --swap-venue=pendle`);
  }

  // Fetch market params from chain
  console.log(`Fetching market params for marketId=${marketId}...`);
  const [loanToken, collateralToken, oracle, irm, lltv] = await readContract(client, {
    address: morphoAddress,
    abi: morphoBlueAbi,
    functionName: "idToMarketParams",
    args: [marketId],
  });

  const market = { loanToken, collateralToken, oracle, irm, lltv };

  // Sanity checks
  if (loanToken.toLowerCase() !== token0.toLowerCase()) {
    throw new Error(`Market loan token ${loanToken} does not match --token0 ${token0}`);
  }
  if (collateralToken.toLowerCase() !== token1.toLowerCase()) {
    throw new Error(`Market collateral token ${collateralToken} does not match --token1 ${token1}`);
  }

  const [token0Decimals, token1Decimals, token0Symbol, token1Symbol] = await Promise.all([
    readContract(client, { address: token0, abi: erc20Abi, functionName: "decimals" }),
    readContract(client, { address: token1, abi: erc20Abi, functionName: "decimals" }),
    readContract(client, { address: token0, abi: erc20Abi, functionName: "symbol" }),
    readContract(client, { address: token1, abi: erc20Abi, functionName: "symbol" }),
  ]);

  const profit = borrowAmount - flashLoanAmount;
  if (profit <= 0n) {
    throw new Error(
      `borrowAmount (${borrowAmount}) must be greater than flashLoanAmount (${flashLoanAmount}) to be profitable`,
    );
  }

  console.log(`\nArbitrage parameters:`);
  console.log(`  Chain: ${chainConfig.chain.name} (${chainId})`);
  console.log(`  Flash loan source: ${argv.flashLoanSource}`);
  console.log(`  Flash loan: ${formatUnits(flashLoanAmount, token0Decimals)} ${token0Symbol}`);
  if (swapVenue === "pendle") {
    console.log(`  Swap: ${token0Symbol} → ${token1Symbol} (Pendle market=${pendleMarket})`);
  } else {
    console.log(`  Swap: ${token0Symbol} → ${token1Symbol} (UniswapV3 fee=${uniswapFee})`);
  }
  console.log(
    `  Min collateral out: ${formatUnits(minCollateralOut, token1Decimals)} ${token1Symbol}`,
  );
  console.log(`  Borrow: ${formatUnits(borrowAmount, token0Decimals)} ${token0Symbol}`);
  console.log(`  Expected profit: ${formatUnits(profit, token0Decimals)} ${token0Symbol}`);
  console.log(`  Collection address: ${collectionAddress}`);
  console.log(`  Market: ${marketId}`);
  console.log(`  LLTV: ${formatUnits(lltv, 18)}`);

  // --- Build calldata ---

  // 1. Inner encoder: operations inside the flash loan callback
  //    a. Approve swap venue and swap token0 → token1
  //    b. Supply token1 as collateral to Morpho (with transfer callback)
  //    c. Borrow token0 from Morpho back to executor

  // The supplyCollateral callback transfers token1 from executor to Morpho
  const supplyCallbackCalls: Hex[] = [
    ExecutorEncoder.buildErc20Transfer(token1, morphoAddress, minCollateralOut),
  ];

  // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
  const innerEncoder = new ExecutorEncoder(executorAddress, client);

  if (swapVenue === "pendle") {
    const swapData = await getPendleSwapCallData(
      chainId,
      pendleMarket!,
      token0.toLowerCase(),
      token1.toLowerCase(),
      flashLoanAmount,
      executorAddress,
    );
    innerEncoder
      .erc20Approve(token0, swapData.tx.to, maxUint256)
      .pushCall(
        swapData.tx.to,
        swapData.tx.value ? BigInt(swapData.tx.value) : 0n,
        swapData.tx.data,
      );
  } else {
    const swapPath = encodePacked(["address", "uint24", "address"], [token0, uniswapFee, token1]);
    innerEncoder
      .erc20Approve(token0, uniswapV3Router!, flashLoanAmount)
      .uniV3ExactInput(uniswapV3Router!, swapPath, flashLoanAmount, minCollateralOut);
  }

  innerEncoder
    .morphoBlueSupplyCollateral(
      morphoAddress,
      market,
      minCollateralOut,
      executorAddress,
      supplyCallbackCalls,
    )
    .morphoBlueBorrow(morphoAddress, market, borrowAmount, 0n, executorAddress, executorAddress);

  const flashLoanCallbackCalls = innerEncoder.flush();

  // 2. Outer encoder: flash loan wrapper + profit skim
  // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
  const encoder = new ExecutorEncoder(executorAddress, client);

  if (argv.flashLoanSource === "morpho") {
    encoder.blueFlashLoan(morphoAddress, token0, flashLoanAmount, flashLoanCallbackCalls);
  } else {
    // Balancer
    const balancerVault =
      (argv.balancerVault as Address | undefined) ?? DEFAULT_BALANCER_VAULT[chainId];
    if (!balancerVault) {
      throw new Error(
        `No default Balancer vault for chainId=${chainId}. Pass --balancer-vault=0x...`,
      );
    }
    encoder.balancerFlashLoan(
      balancerVault,
      [{ asset: token0, amount: flashLoanAmount }],
      flashLoanCallbackCalls,
    );
  }

  encoder.erc20Skim(token0, collectionAddress);

  const calls = encoder.flush();

  // --- Simulate ---
  console.log(`\nSimulating...`);

  const { results } = await simulateCalls(client, {
    account: client.account.address,
    calls: [
      {
        to: token0,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [collectionAddress],
      },
      {
        to: executorAddress,
        abi: [
          {
            inputs: [{ name: "calls", type: "bytes[]" }],
            name: "exec_606BaXt",
            outputs: [],
            stateMutability: "payable",
            type: "function",
          },
        ] as const,
        functionName: "exec_606BaXt",
        args: [calls],
      },
      {
        to: token0,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [collectionAddress],
      },
    ],
  });

  const execResult = results[1];

  if (execResult.status !== "success") {
    console.error(`\nSimulation FAILED:`);
    console.error(execResult.error);
    process.exit(1);
  }

  const balanceBefore = results[0].result!;
  const balanceAfter = results[2].result!;
  const actualProfit = balanceAfter - balanceBefore;

  console.log(`Simulation PASSED`);
  console.log(`  Gas used: ${execResult.gasUsed.toLocaleString()}`);
  console.log(`  Simulated profit: ${formatUnits(actualProfit, token0Decimals)} ${token0Symbol}`);

  if (actualProfit <= 0n) {
    console.warn(`\nSimulation shows non-positive profit (${actualProfit}). Aborting.`);
    process.exit(1);
  }

  if (argv.simulateOnly) {
    console.log(`\n--simulate-only flag set. Exiting without broadcasting.`);
    return;
  }

  // --- Execute ---
  console.log(`\nBroadcasting transaction...`);
  const txHash = await encoder.exec();
  console.log(`Transaction submitted: ${txHash}`);
  console.log(
    `Expected profit: ${formatUnits(actualProfit, token0Decimals)} ${token0Symbol} → ${collectionAddress}`,
  );
}

void run().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
