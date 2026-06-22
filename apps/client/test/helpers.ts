import { MarketUtils } from "@morpho-org/blue-sdk";
import type { AnvilTestClient } from "@morpho-org/test";
import {
  type Address,
  encodePacked,
  fromHex,
  type Hex,
  keccak256,
  maxUint128,
  maxUint256,
  toHex,
} from "viem";
import { getStorageAt, readContract } from "viem/actions";

import { morphoBlueAbi } from "../src/abis/morpho/morphoBlue";

import { BORROW_SHARES_AND_COLLATERAL_OFFSET, borrower, MORPHO, POSITION_SLOT } from "./constants";

export async function setupPosition(
  client: AnvilTestClient,
  marketParams: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  },
  collateralAmount: bigint,
  borrowAmount: bigint,
) {
  const marketId = MarketUtils.getMarketId(marketParams);

  await client.deal({
    erc20: marketParams.collateralToken,
    account: borrower.address,
    amount: collateralAmount,
  });

  await client.approve({
    account: borrower,
    address: marketParams.collateralToken,
    args: [MORPHO, maxUint256],
  });

  await client.writeContract({
    account: borrower,
    address: MORPHO,
    abi: morphoBlueAbi,
    functionName: "supplyCollateral",
    args: [marketParams, collateralAmount, borrower.address, "0x"],
  });

  await client.writeContract({
    account: borrower,
    address: MORPHO,
    abi: morphoBlueAbi,
    functionName: "borrow",
    args: [marketParams, borrowAmount, 0n, borrower.address, borrower.address],
  });

  await overwriteCollateral(client, marketId, borrower.address, collateralAmount / 2n);
}

async function overwriteCollateral(
  client: AnvilTestClient,
  marketId: Hex,
  user: Address,
  amount: bigint,
) {
  const slot = borrowSharesAndCollateralSlot(user, marketId);

  // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
  const value = await getStorageAt(client, {
    address: MORPHO,
    slot,
  });

  await client.setStorageAt({
    address: MORPHO,
    index: slot,
    value: modifyCollateralSlot(value!, amount),
  });
}

function borrowSharesAndCollateralSlot(user: Address, marketId: Hex) {
  return padToBytes32(
    toHex(
      fromHex(
        keccak256(
          encodePacked(
            ["bytes32", "bytes32"],
            [
              padToBytes32(user),
              keccak256(encodePacked(["bytes32", "uint256"], [marketId, POSITION_SLOT])),
            ],
          ),
        ),
        "bigint",
      ) + BORROW_SHARES_AND_COLLATERAL_OFFSET,
    ),
  );
}

function padToBytes32(hex: `0x${string}`, bytes = 32): Hex {
  const withoutPrefix = hex.slice(2);
  const padded = withoutPrefix.padStart(2 * bytes, "0");
  return `0x${padded}`;
}

function modifyCollateralSlot(value: Hex, amount: bigint) {
  if (amount > maxUint128) throw new Error("Amount is too large");

  const collateralBytes = padToBytes32(toHex(amount), 16);
  const slotBytes = value.slice(34);

  return `${collateralBytes}${slotBytes}` as Hex;
}

export const syncTimestamp = async (client: AnvilTestClient, timestamp?: bigint) => {
  const { vi } = await import("vitest");
  timestamp ??= (await client.timestamp()) + 60n;

  vi.useFakeTimers({
    now: Number(timestamp) * 1000,
    toFake: ["Date"],
  });
  vi.setSystemTime(Number(timestamp) * 1000);

  await client.setNextBlockTimestamp({ timestamp });

  return timestamp;
};

export async function getPositionCollateral(
  client: AnvilTestClient,
  marketId: Hex,
  user: Address,
): Promise<bigint> {
  // @ts-expect-error viem peer-dep version mismatch (2.38 vs 2.46) — safe at runtime
  const [, , collateral] = await readContract(client, {
    address: MORPHO,
    abi: morphoBlueAbi,
    functionName: "position",
    args: [marketId, user],
  });
  return collateral;
}
