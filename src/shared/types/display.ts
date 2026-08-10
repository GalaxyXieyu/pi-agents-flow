/** Domain types split from shared/types.ts (compatible facade). */


export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };
