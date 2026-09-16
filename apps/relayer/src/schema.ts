import { getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";

const addressSchema = z
  .string()
  .refine(isAddress, "invalid address")
  .transform((value) => getAddress(value));

const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "expected an unsigned integer string")
  .transform((value) => BigInt(value));

const hexData = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "expected even-length hex data")
  .max(4_098, "calldata exceeds 2 KiB")
  .transform((value) => value as Hex);

const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature")
  .transform((value) => value as Hex);

export const relayBodySchema = z
  .object({
    request: z
      .object({
        from: addressSchema,
        to: addressSchema,
        value: uintString,
        gas: uintString,
        deadline: z.number().int().positive(),
        data: hexData,
        signature,
      })
      .strict(),
  })
  .strict();

export const quoteQuerySchema = z.object({
  amount: uintString,
});
