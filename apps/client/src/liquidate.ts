/**
 * Manual liquidation script: seize collateral → convert to loan token → repay debt → profit.
 *
 * Usage:
 *   pnpm liquidate \
 *     --chain-id=42161 \
 *     --market-id=0x... \
 *     --borrower=0x... \
 *     [--seized-assets=1000000000000000000] \
 *     [--treasury=0x...] \
 *     [--simulate-only]
 */

import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import dotenv from "dotenv";
import { executorAbi } from "executooor-viem";
import {
  type Address,
  type Hex,
  createWalletClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract, simulateCalls, writeContract } from "viem/actions";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { morphoBlueAbi } from "./abis/morpho/morphoBlue.js";
import { buildLiquidateCalls } from "./utils/buildLiquidateCalls.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";

async function run() {
  dotenv.config();

  const argv = yargs(hideBin(process.argv))
    .option("chainId", {
      type: "number",
      description: "Chain ID",
      demandOption: true,
    })
    .option("marketId", {
      type: "string",
      description: "Morpho market ID (bytes32 hex)",
      demandOption: true,
    })
    .option("borrower", {
      type: "string",
      description: "Borrower address to liquidate",
      demandOption: true,
    })
    .option("seizedAssets", {
      type: "string",
      description: "Amount of collateral to seize (wei). Defaults to full position collateral.",
    })
    .option("treasury", {
      type: "string",
      description: "Address to receive the profit. Defaults to executor owner.",
    })
    .option("simulateOnly", {
      type: "boolean",
      description: "Only simulate; do not broadcast the transaction",
      default: false,
    })
    .parseSync();

  const chainId = argv.chainId;
  const marketId = argv.marketId as Hex;
  const borrower = getAddress(argv.borrower);

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
  const treasuryAddress = (argv.treasury as Address | undefined) ?? client.account.address;

  // Fetch market params and position from chain
  console.log(`Fetching market params for marketId=${marketId}...`);
  const [[loanToken, collateralToken, oracle, irm, lltv], [, , collateralOnChain]] =
    await Promise.all([
      readContract(client, {
        address: morphoAddress,
        abi: morphoBlueAbi,
        functionName: "idToMarketParams",
        args: [marketId],
      }),
      readContract(client, {
        address: morphoAddress,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, borrower],
      }),
    ]);

  const market = { loanToken, collateralToken, oracle, irm, lltv };

  const seizedAssets = argv.seizedAssets ? BigInt(argv.seizedAssets) : collateralOnChain;

  if (seizedAssets === 0n) {
    throw new Error(`Borrower ${borrower} has no collateral in market ${marketId}`);
  }

  const [loanDecimals, collateralDecimals, loanSymbol, collateralSymbol] = await Promise.all([
    readContract(client, { address: loanToken, abi: erc20Abi, functionName: "decimals" }),
    readContract(client, {
      address: collateralToken,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    readContract(client, { address: loanToken, abi: erc20Abi, functionName: "symbol" }),
    readContract(client, { address: collateralToken, abi: erc20Abi, functionName: "symbol" }),
  ]);

  console.log(`\nLiquidation parameters:`);
  console.log(`  Chain: ${chainConfig.chain.name} (${chainId})`);
  console.log(`  Market: ${marketId}`);
  console.log(`  Borrower: ${borrower}`);
  console.log(
    `  Collateral on chain: ${formatUnits(collateralOnChain, collateralDecimals)} ${collateralSymbol}`,
  );
  console.log(
    `  Seized assets: ${formatUnits(seizedAssets, collateralDecimals)} ${collateralSymbol}`,
  );
  console.log(`  Loan token: ${loanSymbol} (${loanToken})`);
  console.log(`  Treasury: ${treasuryAddress}`);

  // Build liquidation calldata using configured liquidity venues
  const liquidityVenues = chainConfig.options.liquidityVenues.map((name) =>
    createLiquidityVenue(name),
  );

  const encoder = new LiquidationEncoder(executorAddress, client);

  const calls = await buildLiquidateCalls(encoder, {
    morphoAddress,
    market,
    borrower,
    seizedAssets,
    liquidityVenues,
    treasuryAddress,
  });

  if (!calls) {
    throw new Error(`No liquidity venue found to convert ${collateralSymbol} → ${loanSymbol}`);
  }

  // Simulate
  console.log(`\nSimulating...`);

  const functionData = {
    abi: executorAbi,
    functionName: "exec_606BaXt",
    args: [calls],
  } as const;

  const { results } = await simulateCalls(client, {
    account: client.account.address,
    calls: [
      { to: loanToken, abi: erc20Abi, functionName: "balanceOf", args: [treasuryAddress] },
      { to: executorAddress, ...functionData },
      { to: loanToken, abi: erc20Abi, functionName: "balanceOf", args: [treasuryAddress] },
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
  const profit = balanceAfter - balanceBefore;

  console.log(`Simulation PASSED`);
  console.log(`  Gas used: ${execResult.gasUsed.toLocaleString()}`);
  console.log(`  Profit: ${formatUnits(profit, loanDecimals)} ${loanSymbol}`);

  if (profit <= 0n) {
    console.warn(`\nSimulation shows non-positive profit (${profit}). Aborting.`);
    process.exit(1);
  }

  if (argv.simulateOnly) {
    console.log(`\n--simulate-only flag set. Exiting without broadcasting.`);
    return;
  }

  // Execute
  console.log(`\nBroadcasting transaction...`);
  const txHash = await writeContract(client, { address: executorAddress, ...functionData });
  console.log(`Transaction submitted: ${txHash}`);
  console.log(`Profit: ${formatUnits(profit, loanDecimals)} ${loanSymbol} → ${treasuryAddress}`);
}

void run().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
