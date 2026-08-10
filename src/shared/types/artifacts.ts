/** Domain types split from shared/types.ts (compatible facade). */


export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export type ArtifactDirPreference = "project" | "session" | "temp";

export interface ArtifactConfig {
	enabled: boolean;
	dir?: ArtifactDirPreference;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeTranscript?: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}
