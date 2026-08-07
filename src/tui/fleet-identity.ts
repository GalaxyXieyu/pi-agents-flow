import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type FleetIdentityTone = "accent" | "success" | "warning" | "muted";
export type FleetIdentityLanguage = "zh" | "en";
export type FleetAvatar = [string, string, string, string, string, string, string];

export interface FleetIdentity {
	name: string;
	tone: FleetIdentityTone;
	avatarPath: string;
	avatarIndex: number;
	/** High-contrast terminal fallback. PNG downsampling loses facial detail below 10x7 cells. */
	avatar: FleetAvatar;
}

const ENGLISH_NAMES = [
	"Ada", "Alex", "Ari", "Bea", "Cleo", "Eli", "Emi", "Finn",
	"Iris", "Jules", "Kai", "Leo", "Maya", "Milo", "Nina", "Noah",
	"Remy", "Rin", "Sage", "Sam", "Theo", "Uma", "Vera", "Zoe",
	"Avery", "Blair", "Drew", "Eden", "Jamie", "Lane", "Robin", "Toni",
];

const ENGLISH_SURNAMES = [
	"Ash", "Bell", "Chen", "Cole", "Dale", "Frost", "Gray", "Hart",
	"Ives", "Jade", "Kim", "Lake", "Moon", "North", "Park", "Quinn",
	"Reed", "Shaw", "Stone", "Vale", "West", "Wren", "Young", "Zane",
	"Brooks", "Ellis", "Hayes", "Lin", "Mori", "Nash", "Ross", "Wu",
];

const CHINESE_SURNAMES = [
	"赵", "钱", "孙", "李", "周", "吴", "郑", "王",
	"冯", "陈", "褚", "卫", "蒋", "沈", "韩", "杨",
	"朱", "秦", "许", "何", "吕", "施", "张", "孔",
	"曹", "严", "华", "金", "魏", "陶", "姜", "谢",
];

const CHINESE_GIVEN_NAMES = [
	"子安", "清和", "景明", "若川", "知远", "星野", "云舟", "嘉树",
	"明澈", "听澜", "望舒", "砚秋", "南乔", "初阳", "修竹", "怀瑾",
	"雨时", "亦辰", "书宁", "言溪", "青禾", "令仪", "思齐", "予安",
	"云深", "昭然", "静姝", "知夏", "映雪", "向晚", "沐川", "长风",
];

const AVATAR_FILES = [
	"01-sam-dale.png", "02-nina-zane.png", "03-theo-ross.png", "04-emi-shaw.png",
	"05-cleo-chen.png", "06-vera-stone.png", "07-rin-moon.png", "08-blair-lake.png",
	"09-robin-zane.png", "10-toni-chen.png", "11-maya-park.png", "12-finn-stone.png",
	"13-jamie-cole.png", "14-jules-hart.png", "15-remy-nash.png", "16-lane-wren.png",
] as const;

const AVATAR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/avatars");

const HAIR: Array<readonly [string, string]> = [
	["  ▄█████▄", " ▟███████▙"],
	["  ▄██▀██▄", " ▟██   ██▙"],
	["  ███████", " ███▀ ▀███"],
	["  ▄▄▄▄▄▄▄", " ▄████████▄"],
	["  ▄█████▄", " ▟██▀▀▀██▙"],
	["  ▄▀▀▀▀▀▄", " ▟███████▙"],
	["  ▄███▄▄▄", " ▟███████▙"],
	["  ▄▄▄███▄", " ▟███████▙"],
	["  ▄█▀▀▀█▄", " ▟█▄▄▄▄▄█▙"],
	["  ▄█████▄", " ▟█▀███▀█▙"],
	["  ▄▄███▄▄", " ▟███████▙"],
	["  ▄▀████▄", " ▟███  ██▙"],
];

const FACES: Array<readonly [string, string, string]> = [
	[" █ ▄   ▄ █", " █   ▄   █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▀   ▀ █", " █  ▄▀▄  █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▀   ▀ █", " █   ▀   █", " ▀█▄███▄█▀"],
	[" █ ▄   ▀ █", " █   ▄   █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▀   ▄ █", " █   ▄   █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▀   ▀ █", " █  ▀▀▀  █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▄   ▄ █", " █  ▀▄▀  █", " ▀█▄▄▄▄▄█▀"],
	[" █ ▄   ▄ █", " █   ▀   █", " ▀█▄▀▀▀▄█▀"],
];

const OUTFITS: Array<readonly [string, string]> = [
	["   ▄███▄", " ▄████████▄"],
	["   ▄███▄", " ▄███▀████▄"],
	["   ▄███▄", " ▄████▀███▄"],
	["   ▄███▄", " ▄██▀██▀██▄"],
	["   ▄███▄", " ▄█▀████▀█▄"],
	["   ▄███▄", " ▄██▄██▄██▄"],
];

const TONES: FleetIdentityTone[] = ["accent", "accent", "accent", "success", "warning", "muted"];

function hash(value: string): number {
	let result = 2166136261;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16777619);
	}
	return result >>> 0;
}

function mix(value: number): number {
	value ^= value >>> 16;
	value = Math.imul(value, 0x7feb352d);
	value ^= value >>> 15;
	value = Math.imul(value, 0x846ca68b);
	value ^= value >>> 16;
	return value >>> 0;
}

function pixelLine(value: string): string {
	return value.slice(0, 11).padEnd(11, " ");
}

function pixelAvatar(value: number): FleetAvatar {
	const hair = HAIR[mix(value ^ 0x27d4eb2f) % HAIR.length]!;
	const face = FACES[mix(value ^ 0x165667b1) % FACES.length]!;
	const outfit = OUTFITS[mix(value ^ 0xd3a2646c) % OUTFITS.length]!;
	return [
		pixelLine(hair[0]),
		pixelLine(hair[1]),
		pixelLine(face[0]),
		pixelLine(face[1]),
		pixelLine(face[2]),
		pixelLine(outfit[0]),
		pixelLine(outfit[1]),
	];
}

function identityName(value: number, language: FleetIdentityLanguage): string {
	if (language === "zh") {
		return `${CHINESE_SURNAMES[mix(value ^ 0x85ebca6b) % CHINESE_SURNAMES.length]!}${CHINESE_GIVEN_NAMES[mix(value ^ 0x9e3779b9) % CHINESE_GIVEN_NAMES.length]!}`;
	}
	return `${ENGLISH_NAMES[mix(value ^ 0x9e3779b9) % ENGLISH_NAMES.length]!} ${ENGLISH_SURNAMES[mix(value ^ 0x85ebca6b) % ENGLISH_SURNAMES.length]!}`;
}

export function fleetIdentity(key: string, language: FleetIdentityLanguage = "en"): FleetIdentity {
	const value = mix(hash(key));
	const avatarIndex = mix(value ^ 0x27d4eb2f) % AVATAR_FILES.length;
	return {
		name: identityName(value, language),
		tone: TONES[mix(value ^ 0x94d049bb) % TONES.length]!,
		avatarPath: path.join(AVATAR_DIR, AVATAR_FILES[avatarIndex]!),
		avatarIndex,
		avatar: pixelAvatar(value),
	};
}
