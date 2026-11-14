import { randomBytes } from "node:crypto";

/** A random key of exactly `length` hex characters, generated at run time. */
export const randomKey = (length = 64): string => randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
